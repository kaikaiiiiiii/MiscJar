// Electron 主进程: 440x600 固定窗口 + IPC (inspect / pack / unpack)
// --selftest: 无对话框跑完整自检 (核心逻辑 + UI 状态断言 + 截图) 后退出
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const SELFTEST = process.argv.includes('--selftest');
const SELFTEST_DIR = path.join(os.tmpdir(), 'miscjar-selftest');
const SELFTEST_LOG = path.join(SELFTEST_DIR, 'result.log');

if (SELFTEST) {
    app.disableHardwareAcceleration();
    if (process.platform === 'linux') {
        // GitHub Actions 的 Ubuntu 24.04 限制非特权 userns, Electron 的 SUID sandbox 不可用;
        // selftest 只处理自己临时目录里的文件, 直接关沙箱并避开容器 /dev/shm 限制。
        app.commandLine.appendSwitch('no-sandbox');
        app.commandLine.appendSwitch('disable-dev-shm-usage');
    }
    // 启动期异常 (例如原生模块加载失败) 在 CI 上会弹阻塞式错误对话框; 自检必须记录后自行退出
    process.on('uncaughtException', (err) => {
        appendSelftestLog('[selftest] uncaughtException: ' + ((err && err.stack) || err));
        app.exit(1);
    });
    // 看门狗: 任一 await 卡死 (典型是窗口/渲染进程起不来) 都必须在 CI 超时前收场
    setTimeout(() => {
        appendSelftestLog('[selftest] 看门狗超时, 强制退出');
        app.exit(3);
    }, 180000);
}

// 必须在 SELFTEST 的异常处理装好之后再加载 (sqlite3 绑定失败会在这里抛)
const archive = require('./lib/archive');

function appendSelftestLog(line) {
    try {
        fs.mkdirSync(SELFTEST_DIR, { recursive: true });
        fs.appendFileSync(SELFTEST_LOG, line + '\n');
    } catch (e) { /* 日志写入失败不能影响主流程 */ }
    try { console.log(line); } catch (e) { /* Windows 打包版没有控制台 */ }
}

let win = null;

function createWindow() {
    win = new BrowserWindow({
        width: 440,
        height: 600,
        useContentSize: true,       // 客户区精确 440x600 (要求 1/2)
        resizable: false,
        maximizable: false,
        fullscreenable: false,
        autoHideMenuBar: true,
        show: !SELFTEST,            // 自检不建可见窗口: CI 无桌面会话时避免窗口合成/激活阻塞
        title: '谜罐 MiscJar',
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
            backgroundThrottling: false,   // selftest 窗口可能被遮挡: 禁止渲染节流, 否则 capturePage 拿到陈旧帧
            paintWhenInitiallyHidden: true, // 隐藏窗口也要持续出帧, capturePage 才能拿到画面
        },
    });
    win.loadFile(path.join(__dirname, 'index.html'));
}

app.whenReady().then(async () => {
    createWindow();

    // 拖入项检测: 目录 / 本工具归档 (文件) / 普通文件
    ipcMain.handle('archive:inspect', async (_e, p) => {
        try {
            const st = fs.lstatSync(p);
            if (st.isDirectory()) { return { isDir: true, isOurs: false }; }
            return { isDir: false, isOurs: await archive.sniffOurs(p) };
        } catch (e) {
            return { isDir: false, isOurs: false, error: e.message };
        }
    });

    ipcMain.handle('archive:pack', async (_e, items) => {
        try {
            const r = await archive.pack(items);
            if (!SELFTEST) {
                dialog.showMessageBoxSync(win, {
                    type: 'info', message: '已打包',
                    detail: r.outPath + '\n条目数: ' + r.count,
                });
            }
            return { ok: true, outPath: r.outPath, count: r.count };
        } catch (e) {
            return failBox('打包失败', e.message);
        }
    });

    ipcMain.handle('archive:unpack', async (_e, p) => {
        try {
            const r = await archive.unpack(p);
            if (!SELFTEST) {
                dialog.showMessageBoxSync(win, {
                    type: 'info',
                    message: '已还原到 ' + r.outdir,
                    detail: '文件 ' + r.files + ' 个, 目录 ' + r.dirs + ' 个'
                        + (r.renamed.length ? '\n冲突改名:\n' + r.renamed.join('\n') : '')
                        + (r.errors.length ? '\n错误 ' + r.errors.length + ' 个:\n' + r.errors.slice(0, 5).join('\n') : ''),
                });
            }
            return { ok: true, files: r.files, dirs: r.dirs, renamed: r.renamed, errors: r.errors, outdir: r.outdir };
        } catch (e) {
            return failBox('解包失败', e.message);
        }
    });

    function failBox(title, msg) {
        if (!SELFTEST) { dialog.showErrorBox(title, msg); }
        return { ok: false, error: msg };
    }

    if (SELFTEST) { await runSelftest(); }
});

// ---------------------------------------------------------------- selftest
async function runSelftest() {
    // 输出目录用 %TEMP%: 打包版应用在 asar 内 (__dirname 只读), 截图/日志必须写到可写位置
    fs.rmSync(SELFTEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(SELFTEST_DIR, { recursive: true });
    const shots = SELFTEST_DIR;
    // 打包后的 Electron 是 GUI 程序, Windows 上 console.log 不进控制台 —— 同时追加写文件以便验收
    const log = appendSelftestLog;
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const withTimeout = (p, ms, what) => Promise.race([
        p,
        delay(ms).then(() => { throw new Error(what + ' 超时 (' + ms + 'ms)'); }),
    ]);
    const snap = async (n) => {
        try {
            const img = await withTimeout(win.webContents.capturePage(), 15000, '截图 ' + n);
            fs.writeFileSync(path.join(shots, n + '.png'), img.toPNG());
        } catch (e) {
            // 截图只是排查材料, 不是断言项; 拿不到帧也不能让自检卡死
            log('[selftest] 截图 ' + n + ' 跳过: ' + e.message);
        }
    };
    const js = (code) => withTimeout(win.webContents.executeJavaScript(code, true), 15000, 'executeJavaScript');

    try {
        log('[selftest] start');
        await withTimeout(new Promise((resolve, reject) => {
            if (!win.webContents.isLoading()) { resolve(); return; }
            win.webContents.once('did-finish-load', resolve);
            win.webContents.once('did-fail-load', (_e, code, desc) => reject(new Error('did-fail-load ' + code + ' ' + desc)));
            win.webContents.once('render-process-gone', (_e, details) => reject(new Error('render-process-gone: ' + details.reason)));
        }), 30000, '页面加载');
        await delay(300);

        // --- 核心逻辑自检 (跑在 Electron 的 Node 里, 顺带验证 zstd 可用性) ---
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-gui-'));
        selftestTmpDir = tmp;
        fs.writeFileSync(path.join(tmp, 'a.bin'), 'gui-payload-0123456789');
        fs.mkdirSync(path.join(tmp, 'cab', 'sub'), { recursive: true });
        fs.writeFileSync(path.join(tmp, 'cab', 'x.txt'), 'x-content');
        fs.mkdirSync(path.join(tmp, 'cab', 'empty'));
        const packed = await archive.pack([path.join(tmp, 'a.bin'), path.join(tmp, 'cab')]);
        log('[selftest] pack: ' + JSON.stringify(packed));
        log('[selftest] sniff ours=' + (await archive.sniffOurs(packed.outPath))
            + ' plain=' + (await archive.sniffOurs(path.join(tmp, 'a.bin'))));
        // 解包: a.bin 与 cab 都已存在 (源) -> 顶层冲突 -> a (2).bin / cab (2)
        const u = await archive.unpack(packed.outPath);
        log('[selftest] unpack: ' + JSON.stringify(u));
        log('[selftest] a (2).bin exists=' + fs.existsSync(path.join(tmp, 'a (2).bin'))
            + ', cab (2)/x.txt ok=' + (fs.readFileSync(path.join(tmp, 'cab (2)', 'x.txt'), 'utf8') === 'x-content')
            + ', cab (2)/empty dir=' + fs.statSync(path.join(tmp, 'cab (2)', 'empty')).isDirectory());
        selftestPackedPath = packed.outPath;

        // --- UI 状态断言 (对应规范 3/4/5/6/8/10) + 截图 ---
        await snap('01-initial');
        log('[selftest] state0: ' + await js('JSON.stringify(window.__testState())'));

        await js('window.__testAddPath(' + JSON.stringify(selftestPackedPath) + ')');
        await delay(400);
        await snap('02-one-ours');
        log('[selftest] state1: ' + await js('JSON.stringify(window.__testState())'));

        await js('window.__testAddPath(' + JSON.stringify(path.join(selftestTmpDir, 'cab')) + ')');
        await delay(300);
        await snap('03-two-labels');
        log('[selftest] state2: ' + await js('JSON.stringify(window.__testState())'));

        await js('window.__testRemoveAt(1)');
        await delay(150);
        await snap('04-after-remove');
        log('[selftest] state3: ' + await js('JSON.stringify(window.__testState())'));

        // 大量 label: 虚拟滚动 (要求 7)
        for (let i = 1; i <= 30; i++) {
            const f = path.join(selftestTmpDir, 'f' + String(i).padStart(2, '0') + '.txt');
            fs.writeFileSync(f, 'f' + i);
            await js('window.__testAddPath(' + JSON.stringify(f) + ')');
        }
        await delay(500);
        await snap('05-many-labels');
        log('[selftest] state4: ' + await js('JSON.stringify(window.__testState())'));

        // 虚拟滚动回归: 滚动位置必须保持 (此前缺陷: 重建时滚动高度塌缩, scrollTop 被钳回 0)
        await js('window.__testScrollTo(400)');
        await delay(200);
        await snap('06-scrolled');
        log('[selftest] scroll: ' + await js('JSON.stringify(window.__testScrollState())'));

        // 动画删除回归: 点击删除后 DOM 与状态一致 (行不重播入场动画, 下方行上移后无缝重建)
        await js('window.__testRemoveAnimated(0)');
        await delay(320);
        await snap('07-after-animated-remove');
        log('[selftest] state5: ' + await js('JSON.stringify(window.__testState())'));
        log('[selftest] rows5: ' + await js('JSON.stringify(window.__testScrollState())'));

        log('[selftest] done, shots in ' + shots);
        app.exit(0);
    } catch (e) {
        log('[selftest] 失败: ' + ((e && e.stack) || e));
        app.exit(1);
    }
}

let selftestPackedPath = null;   // selftest 打包产物 (留在临时目录供外部互通验证)
let selftestTmpDir = null;

app.on('window-all-closed', () => app.quit());
