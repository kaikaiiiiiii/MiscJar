#!/usr/bin/env node

// 解包: SQLite 数据库文件 -> 还原到磁盘
//
// 用法:
//   node src/load.js <文件> [--out <目录>]
//
// 只看是不是合法的 SQLite 数据库, 不关心扩展名 —— 产物叫 .zip 也能正常还原。
//
// 错误处理约定:
//   - 任何失败都走 fail(): 只打一行人话 + 退出码 1, 不打堆栈
//   - 单个条目失败不中断整体还原, 但会计数并在最后以非零退出码收场

const fs = require('fs');
const path = require('path');
const os = require('os');
const sqlite3 = require('sqlite3').verbose();
const codec = require('./codec');

const KNOWN_FORMAT_VERSIONS = [1];
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');
const PK_PREFIX = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

// 统一的失败出口
function fail(msg) {
    console.error('错误: ' + msg);
    process.exit(1);
}

function parseArgs(argv) {
    const opts = { file: null, out: null, help: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') { opts.help = true; }
        else if (a === '--out') {
            if (i + 1 >= argv.length) { fail('--out 缺少参数值'); }
            opts.out = argv[++i];
        }
        else if (a.startsWith('-') && a !== '-') { fail('未知选项: ' + a + ' (用 --help 看用法)'); }
        else if (!opts.file) { opts.file = a; }
        else { fail('多余的位置参数: ' + a); }
    }
    return opts;
}

function usage() {
    console.log('用法: node src/load.js <文件> [--out <目录>]');
    console.log('  --out <目录>   还原到指定目录 (默认当前目录)');
}

// 写文件到磁盘, 目录不存在则逐级创建
function putDBCaseToFile(filepath, content) {
    const folder = path.dirname(filepath);
    fs.mkdirSync(folder, { recursive: true });
    if (content) {
        fs.writeFileSync(filepath, content);
    } else {
        fs.mkdirSync(filepath, { recursive: true });
    }
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) { usage(); return; }
    if (!opts.file) { usage(); fail('缺少文件参数'); }

    const dbpath = opts.file;
    if (!fs.existsSync(dbpath)) { fail('文件不存在: ' + dbpath); }

    const outdir = opts.out ? path.resolve(opts.out) : process.cwd();
    try {
        fs.mkdirSync(outdir, { recursive: true });
    } catch (e) {
        fail('无法创建输出目录 ' + outdir + ': ' + e.message);
    }

    // 诚实头直接打开; 伪装头归档 (src/save.js 默认产物, 或历史 --disguise 产物) 复制到临时文件、还原魔数后打开,
    // 原文件全程只读。预检 (PK 前缀 + 偏移 60 user_version=1) 不满足则按原样打开, 走既有报错路径。
    let openPath = dbpath;
    let tmpCopy = null;
    const head = Buffer.alloc(64);
    const hfd = fs.openSync(dbpath, 'r');
    fs.readSync(hfd, head, 0, 64, 0);
    fs.closeSync(hfd);
    if (!head.subarray(0, 16).equals(SQLITE_MAGIC)
        && head.subarray(0, 4).equals(PK_PREFIX)
        && head.readUInt32BE(60) === 1) {
        tmpCopy = path.join(os.tmpdir(), 'miscjar-' + process.pid + '-' + Date.now() + '-' + path.basename(dbpath));
        fs.copyFileSync(dbpath, tmpCopy);
        const tfd = fs.openSync(tmpCopy, 'r+');
        fs.writeSync(tfd, SQLITE_MAGIC, 0, 16, 0);
        fs.closeSync(tfd);
        openPath = tmpCopy;
    }

    let files = 0, dirs = 0, errors = 0;
    let fatal = null;
    let version = null;
    let hasNotice = false;

    const db = new sqlite3.Database(openPath, (openErr) => {
        if (openErr) {
            fatal = '无法打开数据库 ' + dbpath + ': ' + openErr.message;
        }
    });

    db.serialize(() => {
        db.get('PRAGMA user_version', (e, row) => {
            if (!e && row) { version = row.user_version; }
        });
        db.get("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='notice'", (e, row) => {
            if (!e && row) { hasNotice = row.n > 0; }
        });
        db.each('SELECT rpath, g, content FROM files', (err, row) => {
            if (err) {
                // 查询本身失败 (表不存在 / 文件损坏) —— 无法继续
                if (!fatal) {
                    if (/no such table/i.test(err.message)) {
                        fatal = dbpath + ' 里没有 files 表, 不是本工具产出的归档';
                    } else {
                        fatal = '读取 files 表失败: ' + err.message;
                    }
                }
                return;
            }
            try {
                let filepath = path.join(outdir, row.rpath);
                if (process.platform === 'win32') {
                    filepath = filepath.replace(/\//g, '\\');
                }
                if (process.platform === 'darwin') {
                    filepath = filepath.replace(/\\/g, '/');
                }
                // g 是位掩码, bit0 = 目录 (位分配见 docs/DATA_FORMAT.md); 判断必须用位与, 不能用真值
                if (row.g & 1) {
                    putDBCaseToFile(filepath, null);
                    dirs++;
                } else {
                    const content = codec.decode(row.content);
                    putDBCaseToFile(filepath, content);
                    files++;
                }
            } catch (e) {
                console.error('还原失败 ' + row.rpath + ': ' + e.message);
                errors++;
            }
        });
    });

    db.close((closeErr) => {
        if (tmpCopy) { try { fs.unlinkSync(tmpCopy); } catch (_) { } }
        if (fatal) { fail(fatal); }
        if (closeErr) { fail('关闭数据库失败: ' + closeErr.message); }
        if (version !== null && !KNOWN_FORMAT_VERSIONS.includes(version)) {
            console.error('警告: 归档格式版本 ' + version + ' 未知 (本工具支持 '
                + KNOWN_FORMAT_VERSIONS.join('/') + '), 已尽力还原');
        }
        console.log('已还原: ' + outdir);
        console.log('  文件 ' + files + ' 个, 目录 ' + dirs + ' 个'
            + (errors ? ', 错误 ' + errors + ' 个' : '')
            + (hasNotice ? '' : ' (归档无提示文件, 可能是旧版本)'));
        if (errors) { process.exit(1); }
    });
}

try {
    main();
} catch (e) {
    fail((e && e.message) ? e.message : String(e));
}
