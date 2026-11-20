// 开发时测试总入口 (根目录 npm test): 聚合全部套件, 任一失败即非零退出。
// 套件: CLI 行为 / GUI 核心逻辑 / GUI<->CLI 互通 / Electron selftest (UI 状态+虚拟滚动+截图)。
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { check } = require('./check-selftest');

const ROOT = path.join(__dirname, '..');
const GUI = path.join(ROOT, 'gui');
const ELECTRON_CLI = path.join(GUI, 'node_modules', 'electron', 'cli.js');
let failed = 0;

function suite(name, cwd, args) {
    console.log('\n=== ' + name + ' ===');
    try {
        execFileSync('node', args, { cwd, stdio: 'inherit', timeout: 300000 });
        console.log('--- ' + name + ': 通过 ---');
    } catch (e) {
        failed++;
        const how = e.signal ? ('信号 ' + e.signal) : ('退出码 ' + e.status);
        console.log('--- ' + name + ': 失败 (' + how + ') ---');
    }
}

suite('CLI 行为测试', ROOT, [path.join(__dirname, 'cli.test.js')]);
suite('GUI 核心逻辑测试', GUI, ['test/core.test.js']);
suite('GUI <-> CLI 互通测试', GUI, ['test/interop.test.js']);

// selftest: Electron 窗口程序, 验收依据是 result.log (console 输出不可靠)
console.log('\n=== Electron selftest ===');
const shots = path.join(os.tmpdir(), 'miscjar-selftest');
fs.rmSync(shots, { recursive: true, force: true });
try {
    execFileSync('node', [ELECTRON_CLI, '.', '--selftest'], { cwd: GUI, stdio: 'inherit', timeout: 240000 });
} catch (e) {
    failed++;
    console.log('--- Electron selftest: 进程退出码 ' + e.status + ' ---');
}
const logPath = path.join(shots, 'result.log');
const err = check(logPath);
if (err) {
    failed++;
    console.log('--- Electron selftest: ' + err + ' ---');
} else {
    console.log('--- Electron selftest: 通过 ---');
}

console.log('\n======== 总结果: ' + (failed ? '失败 (' + failed + ' 个套件未过)' : '全部通过') + ' ========');
process.exit(failed ? 1 : 0);
