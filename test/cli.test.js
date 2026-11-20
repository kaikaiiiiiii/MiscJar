// CLI 全量行为测试 —— 固化历史上所有已验证的行为约定, 改动 src/save.js 等 CLI 源码后必跑。
// 覆盖: 往返一致 / rpath 归一化与码位序 / 同名自动改名与失败不波及旧产物 / FNAME=readme.txt /
//       page 2 自验证 / --append 多批次与兼容检查 / 文件头全链路 (默认 PK 伪装头 / --honest / append 状态保持) / 参数校验与错误路径 /
//       --notice/--notice-url / 单文件打包 / 未知版本警告 / codec 与 zipentry 单元行为。
// 运行: node test/cli.test.js (或根目录 npm test)
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const sqlite3 = require('sqlite3');
const codec = require('../src/codec');
const zipentry = require('../src/zipentry');

const ROOT = path.join(__dirname, '..');
const PK16 = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0, 0, 0, 0, 0, 0x21, 0, 0, 0]);
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');
let pass = 0, fail = 0;
function check(name, ok) {
    if (ok) { pass++; console.log('PASS ' + name); }
    else { fail++; console.log('FAIL ' + name); }
}

// 运行 src/save.js / src/load.js, 统一捕获退出码与输出 (spawnSync: stderr 在成功路径也可捕获, 如版本警告)
function run(script, args, opts) {
    const r = spawnSync('node', [path.join(ROOT, 'src', script), ...args], { encoding: 'utf8', ...opts });
    return { code: r.status === null ? 1 : r.status, out: r.stdout || '', err: r.stderr || '' };
}
function head16(p) { return fs.readFileSync(p).subarray(0, 16); }
// 揭示副本: 产物默认是 PK 伪装头, sqlite3 无法直连 —— 复制一份并把头 16 字节还原为
// SQLite 魔数, 供测试内直接查询表内容 (原产物不动)
function revealDb(srcPath) {
    const dst = srcPath + '.reveal.db';
    fs.copyFileSync(srcPath, dst);
    const fd = fs.openSync(dst, 'r+');
    fs.writeSync(fd, SQLITE_MAGIC, 0, 16, 0);
    fs.closeSync(fd);
    return dst;
}
function dbRows(dbp, sql) {
    return new Promise((res, rej) => {
        const db = new sqlite3.Database(dbp);
        const out = [];
        db.serialize(() => {
            db.each(sql, (e, r) => { if (!e) { out.push(r); } }, (e) => { db.close(() => (e ? rej(e) : res(out))); });
        });
    });
}
function dbRun(dbp, sql) {
    return new Promise((res) => {
        const db = new sqlite3.Database(dbp);
        db.run(sql, () => db.close(() => res()));
    });
}
// 构造源目录: 乱序创建 (z 在前) 以证明排序确定性; 含嵌套/空目录/中文名
function makeSrc(tmp, name) {
    const src = path.join(tmp, name);
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(src, 'emptydir'), { recursive: true });
    fs.mkdirSync(path.join(src, 'sub2'), { recursive: true });
    fs.writeFileSync(path.join(src, 'sub2', 'z.txt'), 'zzz-content');
    fs.writeFileSync(path.join(src, 'sub', 'deep.bin'), 'deep-bytes-' + name);
    fs.writeFileSync(path.join(src, 'a.txt'), 'hello world');
    fs.writeFileSync(path.join(src, '中 文.txt'), '中文内容');
    return src;
}
const EXPECTED_RPATHS = ['src/a.txt:0', 'src/emptydir:1', 'src/sub/deep.bin:0', 'src/sub2/z.txt:0', 'src/中 文.txt:0'];

(async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-cli-'));
    const src = makeSrc(tmp, 'src');

    // --- A. 往返一致 + 空目录 + 中文名 ---
    const rA = run('save.js', [src, '--out', path.join(tmp, 'a.zip')], { cwd: tmp });
    check('save 退出码 0', rA.code === 0);
    check('save 输出解出名为 readme.txt', rA.out.includes('readme.txt'));
    const restA = path.join(tmp, 'rest-a');
    check('load 退出码 0', run('load.js', [path.join(tmp, 'a.zip'), '--out', restA], { cwd: tmp }).code === 0);
    check('往返逐字节一致 (含中文名/嵌套)',
        ['a.txt', '中 文.txt', path.join('sub', 'deep.bin'), path.join('sub2', 'z.txt')]
            .every((f) => fs.readFileSync(path.join(restA, 'src', f)).equals(fs.readFileSync(path.join(src, f)))));
    check('空目录保留', fs.statSync(path.join(restA, 'src', 'emptydir')).isDirectory());

    // --- B. rpath 归一化 + 码位序排序 (id 序 = rpath 序) ---
    const rB = await dbRows(revealDb(path.join(tmp, 'a.zip')), 'SELECT rpath, g FROM files ORDER BY id');
    const seq = rB.map((r) => r.rpath + ':' + r.g);
    check('rpath 全部 / 分隔', rB.every((r) => !r.rpath.includes('\\')));
    check('乱序创建 -> 码位序 id 序 (sub/ 先于 sub2/)', JSON.stringify(seq) === JSON.stringify(EXPECTED_RPATHS));

    // --- C. FNAME=readme.txt + page 2 自验证 ---
    const dataA = fs.readFileSync(path.join(tmp, 'a.zip'));
    const gzOff = dataA.indexOf(Buffer.from([0x1f, 0x8b, 0x08]));
    check('首个 gzip 流落在 page 2 内', gzOff >= 4096 && gzOff < 8192);
    const gz = dataA.subarray(gzOff);
    check('gzip FLG FNAME 位已置', (gz[3] & 0x08) !== 0);
    check('FNAME = "readme.txt\\0", MTIME=0', gz.subarray(10, 21).toString('utf8') === 'readme.txt\0' && gz.readUInt32LE(4) === 0);
    check('user_version = 1, 默认 PK 伪装头 (结构字段未动)', dataA.readUInt32BE(60) === 1
        && dataA.subarray(0, 16).equals(PK16) && dataA.readUInt16BE(16) === 4096);

    // --- D. 同名自动改名 + 失败不波及旧产物 ---
    check('第 2 次同名 -> (2).zip', run('save.js', [src, '--out', path.join(tmp, 'a.zip')], { cwd: tmp }).out.includes('a (2).zip')
        && fs.existsSync(path.join(tmp, 'a (2).zip')));
    check('第 3 次同名 -> (3).zip', run('save.js', [src, '--out', path.join(tmp, 'a.zip')], { cwd: tmp }).out.includes('a (3).zip')
        && fs.existsSync(path.join(tmp, 'a (3).zip')));
    check('既有产物逐字节未动', fs.readFileSync(path.join(tmp, 'a.zip')).equals(dataA));
    const badSrc = path.join(tmp, 'badsrc');
    fs.mkdirSync(path.join(tmp, 'jt-target'), { recursive: true });
    fs.mkdirSync(badSrc);
    fs.writeFileSync(path.join(badSrc, 'ok.txt'), 'ok');
    fs.symlinkSync(path.join(tmp, 'jt-target'), path.join(badSrc, 'jlink'), 'junction');
    const rD = run('save.js', [badSrc, '--out', path.join(tmp, 'a.zip')], { cwd: tmp });
    check('目录符号链接打包失败 (退出码 1, 一行人话, 无堆栈)', rD.code === 1 && rD.err.includes('错误:') && !rD.err.includes('    at '));
    check('失败不波及旧产物 (a.zip/(2)/(3) 完好, 无 (4))', fs.existsSync(path.join(tmp, 'a (3).zip')) && !fs.existsSync(path.join(tmp, 'a (4).zip')));

    // --- E. --append 多批次 + 兼容检查 ---
    const srcB = makeSrc(tmp, 'srcb');
    check('append 退出码 0', run('save.js', [srcB, '--out', path.join(tmp, 'a.zip'), '--append'], { cwd: tmp }).code === 0);
    check('append 到伪装归档状态保持 (默认头)', head16(path.join(tmp, 'a.zip')).equals(PK16));
    const restE = path.join(tmp, 'rest-e');
    run('load.js', [path.join(tmp, 'a.zip'), '--out', restE], { cwd: tmp });
    check('append 后两批次都还原',
        fs.existsSync(path.join(restE, 'src', 'a.txt')) && fs.existsSync(path.join(restE, 'srcb', 'a.txt')));
    const plainDb = path.join(tmp, 'plain.db');
    await dbRun(plainDb, 'CREATE TABLE t(x)');
    const rE2 = run('save.js', [src, '--out', plainDb, '--append'], { cwd: tmp });
    check('append 到非 v1 归档被拒 (退出码 1, 提示新建)', rE2.code === 1 && rE2.err.includes('v1'));
    // 默认伪装头下的失败回滚: 头状态与旧批次都必须保持
    const rE3 = run('save.js', [badSrc, '--out', path.join(tmp, 'a.zip'), '--append'], { cwd: tmp });
    const restE2 = path.join(tmp, 'rest-e2');
    check('append 失败后默认伪装头恢复 + 旧数据完好', rE3.code === 1
        && head16(path.join(tmp, 'a.zip')).equals(PK16)
        && run('load.js', [path.join(tmp, 'a.zip'), '--out', restE2], { cwd: tmp }).code === 0
        && fs.existsSync(path.join(restE2, 'src', 'a.txt'))
        && fs.existsSync(path.join(restE2, 'srcb', 'a.txt')));

    // --- F. 文件头全链路: 默认 PK 伪装头 / --honest 退出 / append 状态保持 ---
    // (默认头的基础断言在 A/C; append 到伪装归档的状态保持在 E)
    const h1 = path.join(tmp, 'h1.zip');
    check('--honest 保留诚实 SQLite 头', run('save.js', [src, '--out', h1, '--honest'], { cwd: tmp }).code === 0
        && head16(h1).equals(SQLITE_MAGIC) && fs.readFileSync(h1).readUInt32BE(60) === 1);
    const restF = path.join(tmp, 'rest-f');
    check('load 诚实归档成功且往返一致', run('load.js', [h1, '--out', restF], { cwd: tmp }).code === 0
        && fs.readFileSync(path.join(restF, 'src', 'a.txt')).equals(fs.readFileSync(path.join(src, 'a.txt'))));
    check('append 到诚实归档状态保持 (无旗标)', run('save.js', [srcB, '--out', h1, '--append'], { cwd: tmp }).code === 0
        && head16(h1).equals(SQLITE_MAGIC));
    const restF2 = path.join(tmp, 'rest-f2');
    check('诚实 append 后两批次都在', run('load.js', [h1, '--out', restF2], { cwd: tmp }).code === 0
        && fs.existsSync(path.join(restF2, 'src', 'a.txt')) && fs.existsSync(path.join(restF2, 'srcb', 'a.txt')));
    const rF3 = run('save.js', [badSrc, '--out', h1, '--append'], { cwd: tmp });
    check('append 失败后诚实头保持 + 旧数据完好', rF3.code === 1 && head16(h1).equals(SQLITE_MAGIC)
        && run('load.js', [h1, '--out', path.join(tmp, 'rest-f3')], { cwd: tmp }).code === 0
        && fs.existsSync(path.join(tmp, 'rest-f3', 'srcb', 'a.txt')));
    check('append 旗标不参与 (--disguise 也保持诚实)', run('save.js', [srcB, '--out', h1, '--append', '--disguise'], { cwd: tmp }).code === 0
        && head16(h1).equals(SQLITE_MAGIC));
    check('append 旗标不参与 (--honest 也保持伪装)', run('save.js', [srcB, '--out', path.join(tmp, 'a.zip'), '--append', '--honest'], { cwd: tmp }).code === 0
        && head16(path.join(tmp, 'a.zip')).equals(PK16));
    check('--honest 与 --disguise 互斥', run('save.js', [src, '--out', path.join(tmp, 'mx.zip'), '--honest', '--disguise'], { cwd: tmp }).code === 1
        && run('save.js', [src, '--out', path.join(tmp, 'mx.zip'), '--honest', '--disguise'], { cwd: tmp }).err.includes('互斥'));
    check('--disguise 兼容保留 (新产物 = 默认 PK 头)', run('save.js', [src, '--out', path.join(tmp, 'd1.zip'), '--disguise'], { cwd: tmp }).code === 0
        && head16(path.join(tmp, 'd1.zip')).equals(PK16));
    const realZip = path.join(tmp, 'real.zip');
    fs.writeFileSync(realZip, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(120, 0x5a)]));
    const realBytes = fs.readFileSync(realZip);
    check('前提: 真 zip 偏移 60 恰不为 1', realBytes.readUInt32BE(60) !== 1);
    check('load 真 zip 报错且一字节不动', run('load.js', [realZip, '--out', path.join(tmp, 'rz')], { cwd: tmp }).code === 1
        && fs.readFileSync(realZip).equals(realBytes));
    check('append 真 zip 报错且一字节不动', run('save.js', [src, '--out', realZip, '--append'], { cwd: tmp }).code === 1
        && fs.readFileSync(realZip).equals(realBytes));
    const crafted = path.join(tmp, 'crafted.zip');
    const craftedBytes = Buffer.from(realBytes);
    craftedBytes.writeUInt32BE(1, 60);
    fs.writeFileSync(crafted, craftedBytes);
    check('伪线索 (PK+user_version=1) 被干净拒绝且原样', run('load.js', [crafted, '--out', path.join(tmp, 'cz')], { cwd: tmp }).code === 1
        && fs.readFileSync(crafted).equals(craftedBytes));
    check('--honest 与自动改名共存', run('save.js', [src, '--out', h1, '--honest'], { cwd: tmp }).out.includes('h1 (2).zip')
        && head16(path.join(tmp, 'h1 (2).zip')).equals(SQLITE_MAGIC) && head16(h1).equals(SQLITE_MAGIC));

    // --- G. 参数校验与错误路径 (全部一行人话 + 退出码 1) ---
    check('--help 退出码 0', run('save.js', ['--help']).code === 0 && run('save.js', ['--help']).out.includes('用法'));
    check('缺少源目录', run('save.js', []).code === 1 && run('save.js', []).err.includes('缺少源目录'));
    check('未知选项', run('save.js', [src, '--bogus']).code === 1 && run('save.js', [src, '--bogus']).err.includes('未知选项'));
    check('选项缺值', run('save.js', [src, '--out']).code === 1 && run('save.js', [src, '--out']).err.includes('缺少参数值'));
    check('多余位置参数', run('save.js', [src, 'extra']).code === 1 && run('save.js', [src, 'extra']).err.includes('多余的位置参数'));
    check('路径不存在 (不再 TypeError)', run('save.js', [path.join(tmp, 'no-such-dir')]).code === 1
        && run('save.js', [path.join(tmp, 'no-such-dir')]).err.includes('路径不存在'));
    check('load 缺文件参数', run('load.js', []).code === 1 && run('load.js', []).err.includes('缺少文件参数'));
    check('load 文件不存在', run('load.js', [path.join(tmp, 'no-such.zip')]).code === 1
        && run('load.js', [path.join(tmp, 'no-such.zip')]).err.includes('文件不存在'));

    // --- H. --notice / --notice-url ---
    const rH = run('save.js', [src, '--out', path.join(tmp, 'h.zip'), '--notice', 'Hello {url}!', '--notice-url', 'zz.example'], { cwd: tmp });
    check('--notice 输出含替换后文本', rH.code === 0 && rH.out.includes('Hello zz.example!'));
    const nRow = await dbRows(revealDb(path.join(tmp, 'h.zip')), 'SELECT content FROM notice WHERE id = 1');
    check('notice BLOB 内容正确 (先替换 {url} 再压缩)', zlib.gunzipSync(nRow[0].content).toString('utf8') === 'Hello zz.example!');

    // --- I. 单文件打包 (rpath 只剩文件名) ---
    const single = path.join(tmp, 'hello.txt');
    fs.writeFileSync(single, 'just-a-file');
    check('单文件产物 hello.zip', run('save.js', [single], { cwd: tmp }).out.includes('hello.zip'));
    const rI = await dbRows(revealDb(path.join(tmp, 'hello.zip')), 'SELECT rpath, g FROM files');
    check('单文件 rpath = 文件名', rI.length === 1 && rI[0].rpath === 'hello.txt' && rI[0].g === 0);

    // --- J. 未知版本警告 (尽力还原 + 提示) ---
    const jDb = revealDb(path.join(tmp, 'a (2).zip'));
    await dbRun(jDb, 'PRAGMA user_version = 99');
    const rJ = run('load.js', [jDb, '--out', path.join(tmp, 'rest-j')], { cwd: tmp });
    check('未知版本: 还原成功 + stderr 警告', rJ.code === 0 && rJ.err.includes('警告'));

    // --- K. codec / zipentry 单元行为 ---
    const payload = Buffer.from('unit-test-payload'.repeat(50));
    const named = codec.FORMATS.gzip.encode(payload, 'readme.txt');
    check('codec gzip(FNAME) 可被 detect/decode', codec.detect(named) === 'gzip' && codec.decode(named).equals(payload));
    check('codec gzipNamed 确定性 (两次编码一致)', named.equals(codec.FORMATS.gzip.encode(payload, 'readme.txt')));
    const plainGz = codec.FORMATS.gzip.encode(payload);
    check('codec 无名 gzip 兼容 (历史格式)', codec.detect(plainGz) === 'gzip' && codec.decode(plainGz).equals(payload));
    const zstd = codec.FORMATS.zstd.encode(payload);
    check('codec zstd 往返', codec.detect(zstd) === 'zstd' && codec.decode(zstd).equals(payload));
    const z = zipentry.pack('entry-name', payload);
    check('zipentry 单条目往返 (历史格式)', codec.detect(z) === 'zip' && zipentry.unpack(z).name === 'entry-name'
        && zipentry.unpack(z).data.equals(payload));
    let threw = false;
    try { codec.decode(Buffer.from([1, 2, 3])); } catch (e) { threw = true; }
    check('codec 未知魔数抛错', threw);

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
})();
