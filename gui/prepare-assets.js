// 把随包资源从仓库根复制到 gui/:
//   src/codec.js, src/zipentry.js -> gui/ (打包后 app 根是 app.asar, ../../src 会逃出应用根)
//   miscJar.png                  -> gui/ (style.css 的背景插画, 开发态 npm start 也要用)
// start / selftest / package 都先跑本脚本, 这些副本因此不进仓库 (.gitignore)。
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const FILES = [
    [path.join(ROOT, 'src', 'codec.js'), path.join(__dirname, 'codec.js')],
    [path.join(ROOT, 'src', 'zipentry.js'), path.join(__dirname, 'zipentry.js')],
    [path.join(ROOT, 'miscJar.png'), path.join(__dirname, 'miscJar.png')],
];

for (const [from, to] of FILES) {
    fs.copyFileSync(from, to);
}
console.log('随包资源已就绪: ' + FILES.map((f) => path.basename(f[0])).join(', '));
