// 打包脚本: 走 @electron/packager API, 用 electronZipDir 指定本地 Electron zip,
// 避免每次打包都联网拉取发行包与校验和 (离线/弱网可复现)。
// 本地缓存缺失时 (如 CI 首次构建) 不中断, 回退为 packager 在线下载。
// 用法: node make-package.js [platform] [arch]
//   缺省为目标主机平台/架构; 例: node make-package.js darwin arm64
//   产物: dist/MiscJar-<platform>-<arch>/ (macOS 下为 MiscJar.app)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { packager } = require('@electron/packager');

const PLATFORM = process.argv[2] || process.platform;
const ARCH = process.argv[3] || process.arch;
const VERSION = require('./node_modules/electron/package.json').version;
const ZIP_NAME = `electron-v${VERSION}-${PLATFORM}-${ARCH}.zip`;
const zipDir = path.join(__dirname, '.electron-zip');
const zipPath = path.join(zipDir, ZIP_NAME);

// @electron/get 的用户缓存根目录按平台不同, zip 在按 URL 哈希命名的子目录里
function cacheRoots() {
    const roots = [];
    if (process.env.LOCALAPPDATA) {
        roots.push(path.join(process.env.LOCALAPPDATA, 'electron', 'Cache'));
    }
    roots.push(path.join(os.homedir(), 'Library', 'Caches', 'electron'));
    roots.push(path.join(os.homedir(), '.cache', 'electron'));
    return roots;
}

function findZip(dir) {
    for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
        const fp = path.join(dir, f.name);
        if (f.isDirectory()) {
            const found = findZip(fp);
            if (found) { return found; }
        } else if (f.name === ZIP_NAME) {
            return fp;
        }
    }
    return null;
}

(async () => {
    if (!fs.existsSync(zipPath)) {
        let cached = null;
        for (const root of cacheRoots()) {
            if (!fs.existsSync(root)) { continue; }
            cached = findZip(root);
            if (cached) { break; }
        }
        fs.mkdirSync(zipDir, { recursive: true });
        if (cached) {
            fs.copyFileSync(cached, zipPath);
            console.log('copied electron zip from cache: ' + cached);
        } else {
            console.warn('找不到 Electron zip: ' + ZIP_NAME + ' (无本地缓存), 本次改为在线下载');
        }
    }
    const opts = {
        dir: __dirname,
        name: 'MiscJar',
        platform: PLATFORM,
        arch: ARCH,
        out: 'dist',
        overwrite: true,
        prune: true,
        ignore: [
            /^\/dist/,
            /^\/selftest/,
            /^\/test/,
            /^\/vendor/,
            /^\/\.electron-zip/,          // 本地 Electron zip 缓存, 只给 electronZipDir 用, 不能打进 app.asar
            /^\/make-package\.js$/,
            /^\/prepare-assets\.js$/,
            /^\/package-lock\.json$/,
            /^\/README\.md$/,
        ],
    };
    if (fs.existsSync(zipPath)) {
        opts.electronZipDir = zipDir;
    }
    console.log(`packaging ${PLATFORM}-${ARCH} (electron ${VERSION})`);
    const paths = await packager(opts);
    console.log('packaged: ' + paths.join(', '));
})();
