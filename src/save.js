#!/usr/bin/env node

// 打包: 目录(或单文件) -> 单个 SQLite 数据库文件 (通常命名为 .zip)
//
// 用法:
//   node src/save.js <源目录> [选项]
//
// 产物结构 (v1):
//   文件头: 前 16 字节 = zip PK 伪装头 (默认; --honest 保留诚实 SQLite 头), 偏移 16+ 为 SQLite 结构字段
//   notice 表 (最先创建, 独占 page 2)  content = gzip 流  <- 提示文件, 偏移必然最低
//   files  表 (page 3+)               content = zstd 流  <- 真实载荷
// 提示文件放在最低偏移, 保证任何"按扩展名误当压缩包"的工具解出来的都是它。
//
// 错误处理约定:
//   - 任何失败都走 fail(): 只打一行人话 + 退出码 1, 不打堆栈
//   - 任何失败都不留下半成品 (非 --append 时删除产物)
//   - 写入出错则 ROLLBACK, 不提交部分数据

const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const codec = require('./codec');

const DEFAULT_NOTICE_URL = 'github.com/myid/repo';
const NOTICE_TEMPLATE = 'Test notice here.';
// 提示文件内嵌在 gzip 头 FNAME 字段里的固定文件名 —— 扫描工具解出的就是它
const NOTICE_NAME = 'readme.txt';
const FORMAT_VERSION = 1;
const PAYLOAD_FORMAT = 'zstd';
const NOTICE_FORMAT = 'gzip';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');
// 伪装头: 16 字节的 zip local file header 前缀。完整 local header 要 30 字节,
// 但偏移 16 起是 SQLite 真实字段 (page size 等), 只能占用魔数这 16 字节。
const PK_PREFIX = Buffer.alloc(16);
PK_PREFIX.writeUInt32LE(0x04034b50, 0);   // PK\x03\x04
PK_PREFIX.writeUInt16LE(20, 4);           // version needed: 2.0
PK_PREFIX.writeUInt16LE(0, 6);            // flags
PK_PREFIX.writeUInt16LE(0, 8);            // method: stored
PK_PREFIX.writeUInt16LE(0, 10);           // time
PK_PREFIX.writeUInt16LE(0x21, 12);        // date: 1980-01-01
PK_PREFIX.writeUInt16LE(0, 14);           // crc 低 2 字节 (识别级工具不校验)

// 统一的失败出口
function fail(msg) {
    console.error('错误: ' + msg);
    process.exit(1);
}

function pathCheck(p) {
    if (fs.existsSync(p)) { return p }

    // windows powershell bug: 粘贴带引号的路径时, 末尾引号会残留在 argv 里
    if (p.match(/^[a-zA-Z]\:\\.+\"$/)) {
        return p.slice(0, -1)
    }
    return p;
}

// 产物已存在时不覆盖: 仿 Windows 资源管理器改名, test.zip -> test (2).zip -> test (3).zip ...
function nextAvailablePath(p) {
    const dir = path.dirname(p);
    const ext = path.extname(p);
    const stem = path.basename(p, ext);
    for (let n = 2; ; n++) {
        const candidate = path.join(dir, stem + ' (' + n + ')' + ext);
        if (!fs.existsSync(candidate)) { return candidate; }
    }
}

// 原位改写文件头 16 字节 (伪装 / 还原共用)
function writeHeader(p, buf16) {
    const fd = fs.openSync(p, 'r+');
    try { fs.writeSync(fd, buf16, 0, 16, 0); } finally { fs.closeSync(fd); }
}

// 伪装头结构预检 (纯读, 不写任何字节): PK 前缀 + user_version=1 + 合法页大小
function looksDisguised(head) {
    if (!head.subarray(0, 4).equals(PK_PREFIX.subarray(0, 4))) { return false; }
    if (head.readUInt32BE(60) !== FORMAT_VERSION) { return false; }
    const ps = head.readUInt16BE(16);
    return ps === 1 || (ps >= 512 && ps <= 65536 && (ps & (ps - 1)) === 0);
}

// --append 目标可能是伪装头归档: 还原魔数再走正常流程, 返回"原本是否伪装"。
// 结构预检不过 -> 不碰文件, 返回 false (真 zip 等外来文件不会被误写);
// 预检过了但打开/验证失败 -> 把原 16 字节原样写回, 返回 false (后续兼容检查自然报错)。
async function revealArchive(dbpath) {
    const head = Buffer.alloc(100);
    const fd = fs.openSync(dbpath, 'r');
    fs.readSync(fd, head, 0, 100, 0);
    fs.closeSync(fd);
    if (!looksDisguised(head)) { return false; }
    const saved = Buffer.from(head.subarray(0, 16));
    writeHeader(dbpath, SQLITE_MAGIC);
    const info = await checkAppendCompatible(dbpath);
    if (info.error || info.version !== FORMAT_VERSION || !info.hasNotice) {
        writeHeader(dbpath, saved);
        return false;
    }
    return true;
}

function parseArgs(argv) {
    const opts = {
        source: null, out: null, notice: null,
        noticeUrl: DEFAULT_NOTICE_URL, append: false, honest: false, disguise: false, help: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') { opts.help = true; }
        else if (a === '--append') { opts.append = true; }
        else if (a === '--disguise') { opts.disguise = true; }
        else if (a === '--honest') { opts.honest = true; }
        else if (a === '--out' || a === '--notice' || a === '--notice-url') {
            if (i + 1 >= argv.length) { fail(a + ' 缺少参数值'); }
            const v = argv[++i];
            if (a === '--out') { opts.out = v; }
            else if (a === '--notice') { opts.notice = v; }
            else { opts.noticeUrl = v; }
        }
        else if (a.startsWith('-') && a !== '-') { fail('未知选项: ' + a + ' (用 --help 看用法)'); }
        else if (!opts.source) { opts.source = a; }
        else { fail('多余的位置参数: ' + a); }
    }
    return opts;
}

function usage() {
    console.log('用法: node src/save.js <源目录> [选项]');
    console.log('  --out <文件名>      产物文件名 (默认 <源目录名>.zip)');
    console.log('  --notice <文本>     提示文件内容 (默认 "' + NOTICE_TEMPLATE + '")');
    console.log('  --notice-url <地址> 替换提示文本里的 {url} 占位符 (默认 ' + DEFAULT_NOTICE_URL + ')');
    console.log('  --append            追加到已有 db (默认: 同名产物自动改名, 如 test (2).zip)');
    console.log('  --honest            产物保留诚实 SQLite 头 (默认: 前 16 字节为 zip PK 伪装头)');
    console.log('  --disguise          显式伪装 (已是默认行为, 兼容保留; 与 --honest 互斥)');
}

function traverseFolder(dir, list = []) {
    let files;
    try {
        files = fs.readdirSync(dir);
    } catch (e) {
        throw new Error('无法读取目录 ' + dir + ': ' + e.message);
    }
    if (files.length === 0) {
        list.push({ "a": dir, "g": 1 })
        return list;
    }
    files.forEach((file) => {
        const pathname = path.join(dir, file);
        let stat;
        try {
            stat = fs.lstatSync(pathname);
        } catch (e) {
            throw new Error('无法读取 ' + pathname + ': ' + e.message);
        }
        if (stat.isDirectory()) {
            traverseFolder(pathname, list)
        } else {
            list.push({ "a": pathname, "g": 0 });
        }
    });
    return list;
}

// 自验证: 提示文件必须独占 page 2 —— 这是"任何载荷字节都不可能比它更靠前"的结构保证。
// 当前只做结构验证 (提示文件落在 page 2 内); "扫描器第一个命中的是提示文件"这一
// 端到端性质后续以另一种方案验证。
//
// 注: 早期版本还逐字节扫全文件断言"提示文件之前无 gzip 流", 但纯 JS 扫描太慢
// (实测约 13MB/s, 1GB 归档要约 80 秒), 已移除。
function verifyNotice(dbpath, noticeBlob) {
    let data;
    try {
        data = fs.readFileSync(dbpath);
    } catch (e) {
        throw new Error('自验证失败: 读不到产物 ' + dbpath + ': ' + e.message);
    }
    const noticeOff = data.indexOf(noticeBlob);
    if (noticeOff < 0) {
        throw new Error('自验证失败: 产物里找不到提示文件');
    }
    // 提示文件必须独占 page 2 —— 载荷都在 page 3+, 偏移必然更高
    const raw = data.readUInt16BE(16);
    const pageSize = raw === 1 ? 65536 : raw;
    if (!(noticeOff >= pageSize && noticeOff < 2 * pageSize)) {
        throw new Error('自验证失败: 提示文件偏移 ' + noticeOff + ' 不在 page 2 内 ['
            + pageSize + ', ' + 2 * pageSize + ') —— 结构保证失效');
    }
    return { offset: noticeOff, pageSize: pageSize };
}

// 追加到已有 db 前先检查兼容性。
// 必须是本工具的 v1 格式: 提示文件要落在 page 2 的最低偏移, 而旧格式的载荷是
// gzip 流 (魔数在 page 2 附近), 追加进去会让提示文件不再是最靠前的那个。
// 与其写完再被自验证拦下 (那时数据已提交), 不如一开始就拒绝。
function checkAppendCompatible(dbpath) {
    return new Promise((resolve) => {
        const db = new sqlite3.Database(dbpath, (openErr) => {
            if (openErr) { resolve({ error: openErr.message }); }
        });
        db.get('PRAGMA user_version', (e1, row) => {
            if (e1) { return db.close(() => resolve({ error: e1.message })); }
            db.get("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='notice'", (e2, r2) => {
                if (e2) { return db.close(() => resolve({ error: e2.message })); }
                const version = Number(row.user_version);
                const hasNotice = Number(r2.n) > 0;
                db.close(() => resolve({ version, hasNotice }));
            });
        });
    });
}

function closeDb(db) {
    return new Promise((resolve) => {
        try { db.close(() => resolve()); } catch (e) { resolve(); }
    });
}

// 自验证失败时, 把刚写入的这一批行删掉, 恢复到追加前的状态
function dropBatch(dbpath, taskid) {
    return new Promise((resolve) => {
        const db = new sqlite3.Database(dbpath);
        db.run('DELETE FROM files WHERE taskid = ?', [taskid], (e) => {
            db.close(() => resolve(!e));
        });
    });
}

// 写入归档。出错时 ROLLBACK, 绝不提交部分数据。
function writeArchive(db, opts) {
    const { filelist, root, taskid, noticeBlob } = opts;
    const errors = [];

    db.serialize(() => {
        // 写性能: 归档是"写一次就不改"的, 不需要回滚日志落盘, 也不需要每次提交都 fsync。
        // 事务语义不变 (出错仍可 ROLLBACK), 只是崩溃时可能留下损坏的库 —— 那种情况
        // 会被下面的自验证发现并删除产物。
        db.run('PRAGMA synchronous = OFF');
        db.run('PRAGMA journal_mode = MEMORY');
        // 关键顺序: notice 表必须最先创建, 才能拿到 page 2 (偏移 < 8192)
        db.run('CREATE TABLE IF NOT EXISTS notice(id INTEGER PRIMARY KEY, content BLOB)',
            (e) => { if (e) { errors.push('建表 notice 失败: ' + e.message); } });
        db.run(`
            CREATE TABLE IF NOT EXISTS files(
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            taskid TEXT,
            rpath TEXT,
            g INTEGER DEFAULT 0,
            content BLOB
            )`, (e) => { if (e) { errors.push('建表 files 失败: ' + e.message); } });
        db.run('PRAGMA user_version = ' + FORMAT_VERSION,
            (e) => { if (e) { errors.push('写版本号失败: ' + e.message); } });
        db.run('BEGIN TRANSACTION',
            (e) => { if (e) { errors.push('开启事务失败: ' + e.message); } });

        const stmt = db.prepare('INSERT INTO files (taskid, rpath, g, content) VALUES (?, ?, ?, ?)',
            (e) => { if (e) { errors.push('准备插入语句失败: ' + e.message); } });
        filelist.forEach((file) => {
            const g = file.g;
            // rpath 已在收集阶段归一化为 / 分隔 (见 main); 还原端在 win32 上转回 \
            const relativepath = file.r;
            if (g & 1) {
                stmt.run([taskid, relativepath, g, null],
                    (e) => { if (e) { errors.push('写入目录条目失败 ' + relativepath + ': ' + e.message); } });
            } else {
                let blob;
                try {
                    blob = codec.FORMATS[PAYLOAD_FORMAT].encode(fs.readFileSync(file.a));
                } catch (e) {
                    errors.push('读取或压缩失败 ' + file.a + ': ' + e.message);
                    return;
                }
                stmt.run([taskid, relativepath, g, blob],
                    (e) => { if (e) { errors.push('写入文件失败 ' + relativepath + ': ' + e.message); } });
            }
        });
        // 提示文件放进 notice 表 (page 2) —— 最低偏移的流
        db.run('INSERT OR REPLACE INTO notice (id, content) VALUES (1, ?)', [noticeBlob],
            (e) => { if (e) { errors.push('写入提示文件失败: ' + e.message); } });
        stmt.finalize((e) => { if (e) { errors.push('结束插入语句失败: ' + e.message); } });
    });

    return new Promise((resolve, reject) => {
        // 哨兵语句: 排队在 serialize 块之后, 回调触发时前面的语句都已执行完,
        // 于是所有异步错误都已收集齐, 可以决定 COMMIT 还是 ROLLBACK。
        db.run('SELECT 1', (sentinelErr) => {
            if (sentinelErr) {
                return reject(new Error('写库失败: ' + sentinelErr.message));
            }
            if (errors.length > 0) {
                const shown = errors.slice(0, 3).join('; ');
                const more = errors.length > 3 ? ' (共 ' + errors.length + ' 项)' : '';
                return db.run('ROLLBACK', () => {
                    reject(new Error(shown + more));
                });
            }
            db.run('COMMIT', (e) => {
                if (e) { return reject(new Error('提交事务失败: ' + e.message)); }
                resolve();
            });
        });
    });
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) { usage(); return; }
    if (!opts.source) { usage(); fail('缺少源目录'); }
    if (opts.honest && opts.disguise) { fail('--honest 与 --disguise 互斥, 只能选一个'); }

    const source = pathCheck(path.resolve(opts.source));
    if (!fs.existsSync(source)) { fail('路径不存在: ' + source); }

    let isDir, root, filelist;
    try {
        isDir = fs.lstatSync(source).isDirectory();
        root = path.dirname(source);
        filelist = isDir ? traverseFolder(source) : [{ "a": source, "g": 0 }];
    } catch (e) {
        fail('读取源目录失败: ' + e.message);
    }
    // 排序键 = 归一化后的 rpath (即入库值): 同一目录两次打包产生可比较的归档, 顺序也跨平台一致
    filelist = filelist.map((f) => ({
        "a": f.a, "g": f.g,
        "r": path.relative(root, f.a).split(path.sep).join('/'),
    }));
    filelist.sort((x, y) => (x.r < y.r ? -1 : x.r > y.r ? 1 : 0));

    // 产物文件名: 默认取源目录名 (或源文件名), 扩展名 .zip
    const baseName = isDir ? path.basename(source) : path.basename(source, path.extname(source));
    let dbpath = opts.out || (baseName + '.zip');

    // {url} 占位符仅在提示文本里真的出现时才替换
    const noticeText = (opts.notice !== null ? opts.notice : NOTICE_TEMPLATE)
        .replace('{url}', opts.noticeUrl);
    const noticeBlob = codec.FORMATS[NOTICE_FORMAT].encode(Buffer.from(noticeText, 'utf8'), NOTICE_NAME);

    // 默认不覆盖已有产物 —— 自动改名 (test.zip -> test (2).zip -> ...), 打包失败也不波及既有归档;
    // --append 才追加到已有 db (多批次共存)
    let wasDisguised = false;
    let appendExisting = false;
    if (!opts.append && fs.existsSync(dbpath)) {
        dbpath = nextAvailablePath(dbpath);
        console.log('产物已存在, 本次保存为: ' + dbpath);
    } else if (opts.append && fs.existsSync(dbpath)) {
        // 目标可能是伪装头归档: 先还原魔数再追加, 结束后按其原有状态恢复 (追加不改变归档的伪装状态)
        appendExisting = true;
        wasDisguised = await revealArchive(dbpath);
        const info = await checkAppendCompatible(dbpath);
        if (info.error) {
            fail('无法读取已有 db ' + dbpath + ': ' + info.error);
        }
        if (info.version !== FORMAT_VERSION || !info.hasNotice) {
            fail('已有 db 不是本工具的 v' + FORMAT_VERSION + ' 格式 (版本=' + info.version
                + ', 有提示表=' + info.hasNotice + '), 无法保证提示文件落在最低偏移, 请新建 db');
        }
    }

    const taskid = Date.now().toString();
    const db = new sqlite3.Database(dbpath);
    try {
        await writeArchive(db, { filelist, root, taskid, noticeBlob });
    } catch (e) {
        await closeDb(db);
        // 非追加模式下不留半成品; 追加模式已回滚, 伪装头按追加前状态恢复
        if (!opts.append) { try { fs.unlinkSync(dbpath); } catch (_) { } }
        else if (wasDisguised) { try { writeHeader(dbpath, PK_PREFIX); } catch (_) { } }
        fail(e.message);
    }
    await closeDb(db);

    let v;
    try {
        v = verifyNotice(dbpath, noticeBlob);
    } catch (e) {
        // 追加模式下数据已提交, 精确删掉刚写入的这一批, 恢复到追加前 (含伪装头)
        if (opts.append) {
            await dropBatch(dbpath, taskid);
            if (wasDisguised) { try { writeHeader(dbpath, PK_PREFIX); } catch (_) { } }
        }
        else { try { fs.unlinkSync(dbpath); } catch (_) { } }
        fail(e.message);
    }

    // 文件头决策: 新产物默认 PK 伪装头 (--honest 才保留诚实 SQLite 头);
    // 追加已有归档则保持其原有伪装状态, 显式旗标不参与 (追加不改变归档的伪装状态)
    const disguised = (opts.append && appendExisting) ? wasDisguised : !opts.honest;
    if (disguised) {
        try {
            writeHeader(dbpath, PK_PREFIX);
        } catch (e) {
            // 归档本身已验证完好, 不删除; 只是伪装没写上
            fail('伪装头写入失败 (产物保留诚实 SQLite 头): ' + e.message);
        }
    }

    console.log('已打包: ' + dbpath);
    console.log('  条目数    : ' + filelist.length + ' (载荷格式 ' + PAYLOAD_FORMAT + ')');
    console.log('  提示文件  : ' + NOTICE_FORMAT + ' 流 (解出名为 ' + NOTICE_NAME + '), 偏移 ' + v.offset + ' (偏移最低, 扫描器第一个命中)');
    if (disguised) { console.log('  伪装头    : 前 16 字节已覆盖为 PK 头 (SQLite 工具将无法直接打开)'); }
    else { console.log('  文件头    : 诚实 SQLite 头 (SQLite 工具可直接打开)'); }
    console.log('  提示内容  : ' + noticeText);
}

main().catch((e) => fail((e && e.message) ? e.message : String(e)));
