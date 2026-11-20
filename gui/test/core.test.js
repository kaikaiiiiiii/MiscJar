// 核心逻辑测试 (纯 Node 运行, cwd = gui/)
// 覆盖: 多根打包 / 格式一致性 (默认 PK 头, page2 notice, user_version, rpath) /
//       sniff 三态 / 顶层冲突解包改名 (Explorer 规则) / 干净解包 / 诚实头归档
const fs = require('fs');
const path = require('path');
const os = require('os');
const archive = require('../lib/archive');
const sqlite3 = require('sqlite3');

const PK16 = Buffer.from([0x50, 0x4b, 0x03, 0x04, 20, 0, 0, 0, 0, 0, 0, 0, 0x21, 0, 0, 0]);
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');

let pass = 0, fail = 0;
function check(name, ok) {
    if (ok) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name); }
}

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-gui-lib-'));
    fs.writeFileSync(path.join(tmp, 'a.bin'), 'A'.repeat(1000));
    fs.mkdirSync(path.join(tmp, 'cab', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'cab', 'x.txt'), 'x-content');
    fs.mkdirSync(path.join(tmp, 'cab', 'empty'));

    // 1. 多根打包: a.bin + cab/ -> a.bin.zip, 根条目为 "a.bin" 与 "cab/..."
    const r = await archive.pack([path.join(tmp, 'a.bin'), path.join(tmp, 'cab')]);
    check('产物名 a.bin.zip 且落在源同目录', path.basename(r.outPath) === 'a.bin.zip' && path.dirname(r.outPath) === tmp);

    const data = fs.readFileSync(r.outPath);
    check('默认 PK 伪装头 (结构字段未动)', data.subarray(0, 16).equals(PK16)
        && data.readUInt16BE(16) === 4096 && data.readUInt32BE(60) === 1);
    const gzOff = data.indexOf(Buffer.from([0x1f, 0x8b, 0x08]));
    check('page 2 notice (首个 gzip 流偏移在 [4096,8192))', gzOff >= 4096 && gzOff < 8192);
    const gz = data.subarray(gzOff);
    check('notice gzip 头内嵌 FNAME=readme.txt', (gz[3] & 0x08) !== 0
        && gz.subarray(10, 21).toString('utf8') === 'readme.txt\0');
    check('user_version = 1', data.readUInt32BE(60) === 1);

    // 产物默认伪装头, sqlite3 直连打不开: 复制一份还原头 16 字节后查询
    const revealPath = path.join(tmp, 'a.bin.reveal.db');
    fs.copyFileSync(r.outPath, revealPath);
    const rfd = fs.openSync(revealPath, 'r+');
    fs.writeSync(rfd, SQLITE_MAGIC, 0, 16, 0);
    fs.closeSync(rfd);
    const rows = await new Promise((res) => {
        const db = new sqlite3.Database(revealPath);
        const out = [];
        db.serialize(() => {
            db.each('SELECT rpath, g FROM files ORDER BY id', (e, row) => { if (!e) { out.push(row.rpath + ':' + row.g); } },
                () => db.close(() => res(out)));
        });
    });
    console.log('  rpaths: ' + JSON.stringify(rows));
    check('多根 rpath (含空目录, 码位序)', JSON.stringify(rows)
        === JSON.stringify(['a.bin:0', 'cab/empty:1', 'cab/sub:1', 'cab/x.txt:0']));

    // 2. sniff 三态
    check('sniff 本工具归档 = true', await archive.sniffOurs(r.outPath));
    check('sniff 普通文件 = false', !(await archive.sniffOurs(path.join(tmp, 'a.bin'))));
    fs.writeFileSync(path.join(tmp, 'real.zip'), Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]));
    check('sniff 真 zip = false', !(await archive.sniffOurs(path.join(tmp, 'real.zip'))));

    // 3. 解包 (顶层冲突): 源 a.bin / cab 仍在 -> 新产物应改名 a (2).bin / cab (2)
    const u = await archive.unpack(r.outPath);
    console.log('  unpack: ' + JSON.stringify(u));
    check('冲突改名 a (2).bin', fs.existsSync(path.join(tmp, 'a (2).bin')));
    check('冲突改名 cab (2)/x.txt 内容一致', fs.readFileSync(path.join(tmp, 'cab (2)', 'x.txt'), 'utf8') === 'x-content');
    check('空目录保留 cab (2)/empty', fs.statSync(path.join(tmp, 'cab (2)', 'empty')).isDirectory());
    check('空目录保留 cab (2)/sub', fs.statSync(path.join(tmp, 'cab (2)', 'sub')).isDirectory());
    check('改名报告 2 项', u.renamed.length === 2 && u.files === 2 && u.dirs === 2);

    // 4. 干净目录解包: 原名还原, 无改名
    const clean = path.join(tmp, 'clean');
    fs.mkdirSync(clean);
    fs.copyFileSync(r.outPath, path.join(clean, 'a.bin.zip'));
    const u2 = await archive.unpack(path.join(clean, 'a.bin.zip'));
    check('无冲突时原名还原', fs.existsSync(path.join(clean, 'a.bin'))
        && fs.existsSync(path.join(clean, 'cab', 'x.txt')) && u2.renamed.length === 0);

    // 5. 单目录打包 (与 CLI 语义一致: 根 = 目录名)
    const r2 = await archive.pack([path.join(tmp, 'cab')]);
    check('单目录产物 cab.zip', path.basename(r2.outPath) === 'cab.zip');

    // 6. 诚实头归档 (--honest 语义 / 历史产物): 默认已是伪装头, 这里反转回诚实头验证
    const dg = path.join(tmp, 'dg.zip');
    fs.copyFileSync(r.outPath, dg);
    const fd = fs.openSync(dg, 'r+');
    fs.writeSync(fd, SQLITE_MAGIC, 0, 16, 0);
    fs.closeSync(fd);
    check('sniff 诚实头归档 = true', await archive.sniffOurs(dg));
    const u3 = await archive.unpack(dg);
    check('解包诚实头归档成功且原文件未变', u3.files === 2 && u3.dirs === 2
        && fs.readFileSync(dg).subarray(0, 16).equals(SQLITE_MAGIC));

    // 7. 打包失败不留半成品 (目录链接 EISDIR)
    const srcj = path.join(tmp, 'srcj');
    fs.mkdirSync(srcj);
    fs.writeFileSync(path.join(srcj, 'ok.txt'), 'ok');
    fs.mkdirSync(path.join(tmp, 'jt'));
    fs.symlinkSync(path.join(tmp, 'jt'), path.join(srcj, 'jlink'), 'junction');
    let failed = false;
    try { await archive.pack([srcj]); } catch (e) { failed = true; }
    check('含目录链接打包失败 (退出为错误)', failed);
    check('失败不留产物 (无 srcj.zip)', !fs.existsSync(path.join(tmp, 'srcj.zip')));

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
})();
