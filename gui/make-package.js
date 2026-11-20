// 打包脚本: 走 @electron/packager API, 用 electronZipDir 指定本地 Electron zip,
// 避免每次打包都联网拉取发行包与校验和 (离线/弱网可复现)。
// 本地缓存缺失时 (如 CI 首次构建) 不中断, 回退为 packager 在线下载。
const fs = require('fs');
const path = require('path');
const { packager } = require('@electron/packager');

const VERSION = require('./node_modules/electron/package.json').version;
const ZIP_NAME = `electron-v${VERSION}-win32-x64.zip`;
const zipDir = path.join(__dirname, '.electron-zip');
const zipPath = path.join(zipDir, ZIP_NAME);

(async () => {
    if (!fs.existsSync(zipPath)) {
        // 优先从 @electron/get 的用户缓存取 (zip 在按 URL 哈希命名的子目录里), 免重复下载
        const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'electron', 'Cache');
        let cached = null;
        if (fs.existsSync(cacheRoot)) {
            const find = (dir) => {
                for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
                    const fp = path.join(dir, f.name);
                    if (f.isDirectory()) { cached = find(fp); if (cached) { return cached; } }
                    else if (f.name === ZIP_NAME) { return fp; }
                }
                return null;
            };
            cached = find(cacheRoot);
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
        platform: 'win32',
        arch: 'x64',
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
    const paths = await packager(opts);
    console.log('packaged: ' + paths.join(', '));
})();
