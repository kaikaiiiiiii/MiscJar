# 谜罐 MiscJar (Electron GUI)

CLI 版（`../src/save.js` / `../src/load.js`）的图形界面。界面采用 **Fluent 2** 设计语言（自实现 CSS 令牌，见 `style.css`，无 UI 框架/构建步骤）。**归档格式与 CLI 完全一致**（notice 表独占 page 2 / 载荷 zstd / 提示 gzip / `user_version=1` / 打包后 page 2 自验证），可直接互相读写；差异只在收集与落盘语义：

- **多根收集**：一次拖入多个文件/目录打进一个归档，每个拖入项以 basename 为顶层条目（`a.bin` + `cab/` → `rpath` 为 `a.bin`、`cab/...`）。
- **产物位置**：归档落在**首个拖入项所在目录**，命名 `<basename>.zip`（`a.zip` → `a.zip.zip`）；已存在时自动改名 `(2)`/`(3)`。
- **解包位置**：落在**归档所在目录**；顶层名冲突时按 Explorer 规则改名（`a (2).bin`、`cab (2)`）。
- 产物默认 **PK 伪装头**（与 CLI 默认一致）；解包时自动识别两种头，伪装头经临时副本还原（原文件只读）。

## 运行

```bash
cd gui
npm install
npm start          # 打开 440x600 固定窗口
npm test           # 核心逻辑测试 (纯 Node)
npm run test:interop   # GUI <-> CLI 互通测试 (产物双向可读写)
npm run selftest   # 无界面自检: 状态断言 + 截图输出到 %TEMP%\miscjar-selftest\
npm run package    # 打包当前平台 → dist/MiscJar-<platform>-<arch>/（Windows 下为 MiscJar.exe）
```

环境要求：Electron 45（其内置 Node 24.22，支持 `zlib.zstdCompressSync`）；`sqlite3` 走 N-API 预编译，无需为 Electron 重编。

> 仓库根目录的 `npm test` 一次性聚合全部套件（本目录两个测试 + CLI 行为测试 + Electron selftest），是改动代码后的标准门禁。

> 若你的 npm 启用了 install-scripts 白名单（安装时出现 `packages have install scripts not yet covered by allowScripts` 警告），需要补跑一次 `npm rebuild electron sqlite3` 以下载 Electron 二进制和 sqlite3 预编译绑定。
>
> Electron 二进制从 GitHub 直连可能建连后 0 字节卡死（国内网络常见）：`npm rebuild electron` 无效时改跑 `node node_modules/electron/install.js`，并前置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 走 npmmirror 镜像（官方产物的镜像副本，下载后 SHASUMS 校验照常执行）。zip 落入 `@electron/get` 用户缓存后，后续 `npm run package` 仍完全离线。

## 打包（多平台）

`npm run package` 产出当前平台的 `dist\MiscJar-<platform>-<arch>\`（macOS 为 `MiscJar.app`，Windows / Linux 为可执行文件）。也可指定目标：`node make-package.js darwin arm64`——必须在对应平台构建，原生模块 `sqlite3` 需要匹配目标平台/架构。正式发布由根目录 `.github/workflows/release.yml` 在六个原生 runner 上完成：Windows / macOS / Linux × x64 / arm64。

要点：

- **离线可复现**：`make-package.js` 通过 `electronZipDir` 指定本地 Electron zip——优先从 `@electron/get` 的用户缓存（Windows `%LOCALAPPDATA%\electron\Cache\`、macOS `~/Library/Caches/electron`、Linux `~/.cache/electron`，首次 `npm install` 成功后即有）复制到 `gui\.electron-zip\`，之后打包不再联网。本地缓存缺失时（如 CI 首次构建）自动回退为在线下载。该目录已被 packager ignore，**不会打进 app.asar**。
- **asar 结构**：产物默认 `asar: true`——应用代码在 `resources\app.asar`；`sqlite3` 的 `node_sqlite3.node` 由 packager 自动解包到 `resources\app.asar.unpacked\`，运行时从真实文件加载（原生模块不能直接从 asar 里 `dlopen`）。
- **随包 codec 与插画**：`prepare-assets.js` 先把 `src/codec.js` / `src/zipentry.js` 与仓库根 `miscJar.png` 拷进 `gui/`（`npm start` / `npm run selftest` / `npm run package` 都会先跑它，副本不进仓库）。因为打包后应用根是 `resources/app.asar`，`lib/archive.js` 里 `require('../../src/codec')` 会逃出应用根（启动即崩）；`archive.js` 开发态取 `src/codec.js`（唯一源）、打包态回退包内副本。
- **产物验收**：打包版 `--selftest` 把 `result.log` 与截图写到系统临时目录的 `miscjar-selftest\`；`test/check-selftest.js` 统一校验关键断言（本地 `npm test` 与 CI 共用）。已验证打包版：状态断言、虚拟滚动、真实打包/解包、其产物可被 CLI `src/load.js` 逐字节还原。

## 结构

```
gui/
├── main.js         # 主进程: 窗口 + IPC (inspect/pack/unpack) + --selftest
├── preload.js      # contextBridge: webUtils.getPathForFile + ipc invoke
├── index.html      # 三段布局 (名称 / 408x408 拖放区·背景 miscJar.png 插画 / 按钮)
├── renderer.js     # 拖放、label 虚拟滚动、按钮状态机
├── style.css
├── lib/archive.js  # 核心逻辑 (镜像 src/save.js、src/load.js; 开发态用 src/codec.js, 打包态用随包副本)
├── codec.js / zipentry.js / miscJar.png   # prepare-assets.js 从 src/ 或仓库根拷入的随包副本, 勿手改
├── prepare-assets.js # 随包资源复制 (start / selftest / package 前自动执行)
├── make-package.js # 打包脚本 (支持 platform/arch 参数, electronZipDir 离线取 Electron zip)
├── vendor/fluentui/  # 本地样式参考底本 (只读, 不构建不引用, 打包排除, 已 gitignore 不提交)
└── test/           # core.test.js + interop.test.js
```
