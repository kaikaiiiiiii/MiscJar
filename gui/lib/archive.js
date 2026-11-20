// GUI 版核心打包/解包逻辑 —— 归档格式与 CLI (src/save.js / src/load.js) 完全一致:
//   notice 表最先创建 (独占 page 2, gzip 提示文件) / files 表 zstd 载荷 / user_version = 1 /
//   rpath 归一化 '/' + 码位序排序 / 单事务写入 + 哨兵 COMMIT / 打包后 page 2 自验证 /
//   产物默认前 16 字节 PK 伪装头 (与 CLI 默认一致)
// 与 CLI 的差异只在收集与落盘语义 (GUI 规范):
//   - 多根收集: 每个拖入项以 basename 为顶层条目 (a.bin + cab/ -> rpath "a.bin", "cab/...")
//   - 产物落在首个拖入项所在目录, 命名 <basename>.zip
//   - 解包落在归档所在目录; 顶层冲突按 Explorer 规则改名 (a -> a (2))
const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
// 开发态: 直接用仓库根的 src/codec.js (唯一源); 打包态: app 根是 resources/app(.asar),
// ../../src 会逃出应用根, 因此 package 脚本先把 src/codec.js/src/zipentry.js 拷进 gui/ 随包,
// 这里回退到包内副本。
let codec;
try {
    codec = require('../../src/codec');
} catch (e) {
    codec = require('../codec');
}

const FORMAT_VERSION = 1;
const PAYLOAD_FORMAT = 'zstd';
const NOTICE_FORMAT = 'gzip';
const NOTICE_TEMPLATE = 'Test notice here.';
const DEFAULT_NOTICE_URL = 'github.com/myid/repo';
// 提示文件内嵌在 gzip 头 FNAME 字段里的固定文件名 (与 CLI 的 NOTICE_NAME 一致)
const NOTICE_NAME = 'readme.txt';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');
// 伪装头 16 字节 PK 前缀 (默认产物头), 与 src/save.js 保持一致
const PK_PREFIX = Buffer.alloc(16);
PK_PREFIX.writeUInt32LE(0x04034b50, 0);
PK_PREFIX.writeUInt16LE(20, 4);
PK_PREFIX.writeUInt16LE(0, 6);
PK_PREFIX.writeUInt16LE(0, 8);
PK_PREFIX.writeUInt16LE(0, 10);
PK_PREFIX.writeUInt16LE(0x21, 12);
PK_PREFIX.writeUInt16LE(0, 14);

// 原位改写文件头 16 字节 (与 src/save.js writeHeader 一致)
function writeHeader(p, buf16) {
    const fd = fs.openSync(p, 'r+');
    try { fs.writeSync(fd, buf16, 0, 16, 0); } finally { fs.closeSync(fd); }
}

function closeDb(db) {
    return new Promise((resolve) => {
        try { db.close(() => resolve()); } catch (e) { resolve(); }
    });
}

// 目录遍历 (与 src/save.js traverseFolder 一致: 只有空目录产出 g=1 行)
function traverseFolder(dir, list = []) {
    let files;
    try {
        files = fs.readdirSync(dir);
    } catch (e) {
        throw new Error('无法读取目录 ' + dir + ': ' + e.message);
    }
    if (files.length === 0) {
        list.push({ "a": dir, "g": 1 });
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
            traverseFolder(pathname, list);
        } else {
            list.push({ "a": pathname, "g": 0 });
        }
    });
    return list;
}

const toForward = (p) => p.split(path.sep).join('/');

// 多根收集: 每个拖入项以 basename 为顶层条目; 全部条目按 rpath 码位序排序 (与 CLI 一致)
function collectItems(items) {
    const list = [];
    for (const item of items) {
        let stat;
        try {
            stat = fs.lstatSync(item);
        } catch (e) {
            throw new Error('无法读取 ' + item + ': ' + e.message);
        }
        const base = path.basename(item);
        if (stat.isDirectory()) {
            for (const f of traverseFolder(item)) {
                const rel = toForward(path.relative(item, f.a));
                list.push({ "a": f.a, "g": f.g, "r": rel ? base + '/' + rel : base });
            }
        } else {
            list.push({ "a": item, "g": 0, "r": toForward(base) });
        }
    }
    list.sort((x, y) => (x.r < y.r ? -1 : x.r > y.r ? 1 : 0));
    return list;
}

// 同名产物自动改名: test.zip -> test (2).zip (与 src/save.js nextAvailablePath 一致)
function nextAvailablePath(p) {
    const dir = path.dirname(p);
    const ext = path.extname(p);
    const stem = path.basename(p, ext);
    for (let n = 2; ; n++) {
        const candidate = path.join(dir, stem + ' (' + n + ')' + ext);
        if (!fs.existsSync(candidate)) { return candidate; }
    }
}

// 解包顶层冲突改名 (Explorer 规则): name -> "name (2)" (在 dir 内找空位)
function nextAvailableName(dir, name) {
    if (!fs.existsSync(path.join(dir, name))) { return name; }
    const ext = path.extname(name);
    const stem = path.basename(name, ext);
    for (let n = 2; ; n++) {
        const cand = stem + ' (' + n + ')' + ext;
        if (!fs.existsSync(path.join(dir, cand))) { return cand; }
    }
}

// --- 格式识别 (与 src/load.js / src/save.js 的判别一致) ---

function looksDisguised(head) {
    if (!head.subarray(0, 4).equals(PK_PREFIX.subarray(0, 4))) { return false; }
    if (head.readUInt32BE(60) !== FORMAT_VERSION) { return false; }
    const ps = head.readUInt16BE(16);
    return ps === 1 || (ps >= 512 && ps <= 65536 && (ps & (ps - 1)) === 0);
}

function checkV1(dbpath) {
    return new Promise((resolve) => {
        const db = new sqlite3.Database(dbpath, (openErr) => { if (openErr) { resolve(false); } });
        db.get('PRAGMA user_version', (e1, r1) => {
            if (e1) { return db.close(() => resolve(false)); }
            db.get("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('notice','files')", (e2, r2) => {
                if (e2) { return db.close(() => resolve(false)); }
                const ok = Number(r1.user_version) === FORMAT_VERSION && Number(r2.n) === 2;
                db.close(() => resolve(ok));
            });
        });
    });
}

// 检测文件是否本工具归档: 诚实头直接开库验证; 伪装头复制到临时副本还原后验证 (原文件只读)
async function sniffOurs(p) {
    let stat;
    try { stat = fs.lstatSync(p); } catch (e) { return false; }
    if (!stat.isFile()) { return false; }
    const head = Buffer.alloc(100);
    const fd = fs.openSync(p, 'r');
    fs.readSync(fd, head, 0, 100, 0);
    fs.closeSync(fd);
    if (head.subarray(0, 16).equals(SQLITE_MAGIC)) { return checkV1(p); }
    if (!looksDisguised(head)) { return false; }
    const tmp = path.join(os.tmpdir(), 'miscjar-' + process.pid + '-' + Date.now());
    fs.copyFileSync(p, tmp);
    const tfd = fs.openSync(tmp, 'r+');
    fs.writeSync(tfd, SQLITE_MAGIC, 0, 16, 0);
    fs.closeSync(tfd);
    const ok = await checkV1(tmp);
    try { fs.unlinkSync(tmp); } catch (_) { }
    return ok;
}

// --- 写入 (与 src/save.js writeArchive 一致) ---

function writeArchive(db, filelist, taskid, noticeBlob) {
    const errors = [];

    db.serialize(() => {
        db.run('PRAGMA synchronous = OFF');
        db.run('PRAGMA journal_mode = MEMORY');
        // 关键顺序: notice 表必须最先创建, 才能拿到 page 2
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
            const relativepath = file.r;   // 收集阶段已归一化为 /
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
        db.run('INSERT OR REPLACE INTO notice (id, content) VALUES (1, ?)', [noticeBlob],
            (e) => { if (e) { errors.push('写入提示文件失败: ' + e.message); } });
        stmt.finalize((e) => { if (e) { errors.push('结束插入语句失败: ' + e.message); } });
    });

    return new Promise((resolve, reject) => {
        // 哨兵语句: 排队在 serialize 块之后, 触发时全部异步错误已收集齐
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

// 打包后自验证 (与 src/save.js verifyNotice 一致): 提示文件必须落在 page 2 内
function verifyNotice(dbpath, noticeBlob) {
    const data = fs.readFileSync(dbpath);
    const noticeOff = data.indexOf(noticeBlob);
    if (noticeOff < 0) {
        throw new Error('自验证失败: 产物里找不到提示文件');
    }
    const raw = data.readUInt16BE(16);
    const pageSize = raw === 1 ? 65536 : raw;
    if (!(noticeOff >= pageSize && noticeOff < 2 * pageSize)) {
        throw new Error('自验证失败: 提示文件偏移 ' + noticeOff + ' 不在 page 2 内');
    }
    return { offset: noticeOff, pageSize: pageSize };
}

// 打包: items 为拖入路径数组; 产物落在首个拖入项所在目录, 命名 <basename>.zip
async function pack(items) {
    const filelist = collectItems(items);
    if (filelist.length === 0) { throw new Error('没有可打包的内容'); }
    const outDir = path.dirname(items[0]);
    const baseName = path.basename(items[0]) + '.zip';
    const target = path.join(outDir, baseName);
    const dbpath = fs.existsSync(target) ? nextAvailablePath(target) : target;

    const noticeText = NOTICE_TEMPLATE.replace('{url}', DEFAULT_NOTICE_URL);
    const noticeBlob = codec.FORMATS[NOTICE_FORMAT].encode(Buffer.from(noticeText, 'utf8'), NOTICE_NAME);
    const taskid = Date.now().toString();

    const db = new sqlite3.Database(dbpath);
    try {
        await writeArchive(db, filelist, taskid, noticeBlob);
    } catch (e) {
        await closeDb(db);
        try { fs.unlinkSync(dbpath); } catch (_) { }
        throw e;
    }
    await closeDb(db);
    try {
        verifyNotice(dbpath, noticeBlob);
    } catch (e) {
        try { fs.unlinkSync(dbpath); } catch (_) { }
        throw e;
    }
    // 默认文件头: 前 16 字节覆盖为 PK 伪装头 (与 CLI 默认一致)。归档已验证完好,
    // 写头失败不删产物, 只报错 (产物保留诚实 SQLite 头)。
    try {
        writeHeader(dbpath, PK_PREFIX);
    } catch (e) {
        throw new Error('伪装头写入失败 (产物保留诚实 SQLite 头): ' + e.message);
    }
    return { outPath: dbpath, count: filelist.length };
}

// --- 解包 (还原逻辑与 src/load.js 一致) ---

function topSegment(rpath) {
    const i = rpath.search(/[\\/]/);
    return i < 0 ? rpath : rpath.slice(0, i);
}

// 解包: 落在归档所在目录; 顶层名冲突时按 Explorer 规则改名 (要求 12)
async function unpack(archivePath) {
    if (!(await sniffOurs(archivePath))) {
        throw new Error('不是本工具产出的归档');
    }
    const outdir = path.dirname(archivePath);

    // 伪装头: 还原到临时副本读取, 原文件只读
    let openPath = archivePath;
    let tmpCopy = null;
    const head = Buffer.alloc(64);
    const hfd = fs.openSync(archivePath, 'r');
    fs.readSync(hfd, head, 0, 64, 0);
    fs.closeSync(hfd);
    if (!head.subarray(0, 16).equals(SQLITE_MAGIC) && looksDisguised(head)) {
        tmpCopy = path.join(os.tmpdir(), 'miscjar-' + process.pid + '-' + Date.now() + '-' + path.basename(archivePath));
        fs.copyFileSync(archivePath, tmpCopy);
        const tfd = fs.openSync(tmpCopy, 'r+');
        fs.writeSync(tfd, SQLITE_MAGIC, 0, 16, 0);
        fs.closeSync(tfd);
        openPath = tmpCopy;
    }

    // 预检: 收集全部顶层名, 已存在的按 Explorer 规则改名, 形成首段重命名映射
    const tops = await new Promise((resolve, reject) => {
        const db = new sqlite3.Database(openPath);
        const set = new Set();
        db.serialize(() => {
            db.each('SELECT rpath FROM files', (e, r) => { if (!e && r.rpath) { set.add(topSegment(r.rpath)); } },
                (e) => { db.close(() => (e ? reject(new Error('读取 files 表失败: ' + e.message)) : resolve(set))); });
        });
    });
    const map = {};
    const renamed = [];
    for (const top of tops) {
        if (fs.existsSync(path.join(outdir, top))) {
            map[top] = nextAvailableName(outdir, top);
            renamed.push(top + ' -> ' + map[top]);
        }
    }

    // 流式还原: g&1 判目录, 按魔数解码, 平台分隔符转换 (与 src/load.js 一致)
    const stats = await new Promise((resolve) => {
        let files = 0, dirs = 0;
        const errors = [];
        const db = new sqlite3.Database(openPath);
        db.serialize(() => {
            db.each('SELECT rpath, g, content FROM files', (err, row) => {
                if (err) { errors.push('读取失败: ' + err.message); return; }
                try {
                    const seg = topSegment(row.rpath);
                    const newRpath = (map[seg] || seg) + row.rpath.slice(seg.length);
                    let filepath = path.join(outdir, newRpath);
                    if (process.platform === 'win32') { filepath = filepath.replace(/\//g, '\\'); }
                    if (process.platform === 'darwin') { filepath = filepath.replace(/\\/g, '/'); }
                    if (row.g & 1) {
                        fs.mkdirSync(filepath, { recursive: true });
                        dirs++;
                    } else {
                        fs.mkdirSync(path.dirname(filepath), { recursive: true });
                        fs.writeFileSync(filepath, codec.decode(row.content));
                        files++;
                    }
                } catch (e) {
                    errors.push(row.rpath + ': ' + e.message);
                }
            }, (e) => {
                if (e) { errors.push('读取 files 表失败: ' + e.message); }
                db.close(() => resolve({ files, dirs, errors }));
            });
        });
    });

    if (tmpCopy) { try { fs.unlinkSync(tmpCopy); } catch (_) { } }
    return { files: stats.files, dirs: stats.dirs, errors: stats.errors, renamed: renamed, outdir: outdir };
}

module.exports = { pack, unpack, sniffOurs, nextAvailableName, collectItems };
