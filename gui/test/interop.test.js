// 互通测试: GUI 归档 <-> CLI 工具双向可读写
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const archive = require('../lib/archive');

// 相对定位仓库根 (兼容任意工作目录名/位置)
const ROOT = path.join(__dirname, '..', '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sq-interop-'));
let pass = 0, fail = 0;
const check = (n, ok) => { ok ? (pass++, console.log('PASS ' + n)) : (fail++, console.log('FAIL ' + n)); };

(async () => {
    // 1. GUI 打包 -> CLI src/load.js 还原
    fs.mkdirSync(path.join(tmp, 'g', 'sub'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'g', 'sub', 'x.txt'), 'gui->cli');
    const g = await archive.pack([path.join(tmp, 'g')]);
    fs.mkdirSync(path.join(tmp, 'by-cli'));
    execFileSync('node', [path.join(ROOT, 'src', 'load.js'), g.outPath, '--out', path.join(tmp, 'by-cli')]);
    check('GUI 产物可被 CLI src/load.js 还原', fs.readFileSync(path.join(tmp, 'by-cli', 'g', 'sub', 'x.txt'), 'utf8') === 'gui->cli');

    // 2. CLI src/save.js 打包 -> GUI sniff + 解包
    const c = execFileSync('node', [path.join(ROOT, 'src', 'save.js'), path.join(tmp, 'g'), '--out', path.join(tmp, 'cli.zip')], { encoding: 'utf8' });
    check('CLI 产物 sniff=true', await archive.sniffOurs(path.join(tmp, 'cli.zip')));
    const u = await archive.unpack(path.join(tmp, 'cli.zip'));
    check('CLI 产物可被 GUI 解包 (冲突改名 g -> g (2))',
        u.renamed.length === 1 && fs.readFileSync(path.join(tmp, 'g (2)', 'sub', 'x.txt'), 'utf8') === 'gui->cli');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('\n结果: ' + pass + ' 通过, ' + fail + ' 失败');
    process.exit(fail ? 1 : 0);
})();
