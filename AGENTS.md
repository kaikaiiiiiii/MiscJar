# PROJECT KNOWLEDGE BASE

**Project:** sqlite-storage（产品名：谜罐 / MiscJar；工作目录已改名为 `D:\Coding\miscJar`，历史文档与旧快照中可能仍见旧名）
**Generated:** 2026-10-19
**Commit:** N/A（尚未初始化 git 仓库）
**Branch:** N/A

## OVERVIEW

Node.js CommonJS CLI（`src/` 下 4 个源文件）。把一个目录（或单个文件）打包进**单个 SQLite 数据库文件**（通常命名为 `.zip`），并可从该数据库完整还原回磁盘。运行时依赖仅 `sqlite3@^5.1.6`（zstd 用 Node 24 内置的 `zlib.zstdCompressSync`，无额外依赖）。

**设计要点**：载荷用 zstd 存，提示文件用 gzip 存，且提示文件独占 page 2 —— 于是它之前**不存在任何 gzip 流**、且偏移低于所有载荷，任何按 gzip 扫描的工具（WinRAR / 7-Zip）第一个命中的必然是提示文件（载荷压缩字节仍可能随机撞上 gzip 魔数，但都在提示文件之后，扫不到）。默认产物还把前 16 字节覆盖为 zip PK 伪装头，头部嗅探工具同样改判 zip；`--honest` 保留诚实 SQLite 头，`--disguise` 仅为兼容保留。

## STRUCTURE

```
miscJar/
├── src/                 # CLI 与共享核心源码（4 个文件，Node CommonJS）
│   ├── save.js          # 打包：目录/文件 → <名字>.zip
│   ├── load.js          # 解包：db → 还原到磁盘
│   ├── codec.js         # 内容格式识别与解压：gzip / zstd / zip
│   └── zipentry.js      # 单条目 zip 的构造与解析（历史格式兼容用）
├── package.json         # dependencies + scripts.test（开发时测试门禁）
├── .gitignore           # 依赖/产物/GUI 构建产物/本地 Fluent 参考底本
├── .github/workflows/   # CI（push/PR 测试）+ Release（tag 触发打包发版）
├── test/                # 开发时测试：cli.test.js（CLI 全量行为 54 项）+ run.js（聚合运行器）+ check-selftest.js（selftest 断言校验，CI 共用）
├── gui/                 # Electron GUI 版（另起一套代码，见 gui/README.md）
│   ├── main.js          # 主进程：440x600 固定窗口 + IPC + --selftest（输出到 %TEMP%\miscjar-selftest）
│   ├── preload.js       # contextBridge：webUtils.getPathForFile + invoke
│   ├── renderer.js      # 拖放 / label 虚拟滚动 / 按钮状态机
│   ├── lib/archive.js   # 核心逻辑：镜像 src/save.js、src/load.js（开发态用 src/codec.js，打包态用随包副本）
│   ├── prepare-assets.js # 随包资源复制：src/codec.js / src/zipentry.js / miscJar.png → gui/
│   ├── make-package.js  # 打包脚本（支持 platform/arch 参数，electronZipDir 离线取 Electron zip）
│   └── test/            # core.test.js + interop.test.js
├── docs/                # 补充文档
│   ├── DESIGN.md        # 设计决策记录（为什么这样做）
│   ├── DATA_FORMAT.md   # 归档格式规范
│   └── KNOWN_ISSUES.md  # 已核实问题清单
└── .codegraph/          # codegraph 索引（工具产物，非源码）
```

## WHERE TO LOOK

| 任务 | 位置 | 说明 |
|------|------|------|
| **表创建顺序（最关键）** | `src/save.js` `CREATE TABLE IF NOT EXISTS notice…` | notice 表**必须最先创建**才能拿到 page 2 |
| 提示文件写入 | `src/save.js` `INSERT OR REPLACE INTO notice` | gzip 压缩（FNAME 固定 `readme.txt`），落在 page 2 |
| 载荷写入 | `src/save.js` `stmt.run([taskid, relativepath, g, blob])` | zstd 压缩，单事务批量 INSERT |
| 格式版本 | `src/save.js` `PRAGMA user_version` | 存于文件头 60-63 字节，不占页 |
| **打包后自验证** | `src/save.js` `verifyNotice()` | 验证提示文件落在 page 2 内；否则拒绝产出（魔数扫描已移除，端到端验证后续换方案） |
| 目录遍历 / 文件收集 | `src/save.js` `traverseFolder()` | 同步 `readdirSync` + `lstatSync`；只有**空目录**才产出 `g=1` 行 |
| rpath 归一化与排序 | `src/save.js` main `filelist.map(…).sort(…)` | rpath 统一 `/` 分隔、按码位序排序（跨平台一致的确定性顺序） |
| 路径规范化 | `src/save.js` `pathCheck()` | 剥掉 PowerShell 粘贴残留的尾引号；失败时返回原值（不再返回 undefined） |
| 相对路径基准 | `src/save.js` `root = path.dirname(source)` | 传目录时保留顶层目录名；传单文件时丢失目录结构 |
| 产物文件名 | `src/save.js` `baseName + '.zip'` | 默认取源目录名，`--out` 可覆盖；已存在时自动改名 `(2)`/`(3)`… |
| 覆盖 / 追加 | `src/save.js` `opts.append` / `nextAvailablePath()` | 默认同名自动改名（不删旧产物），`--append` 才追加 |
| 格式自动识别 | `src/codec.js` `detect()` / `decode()` | 按魔数识别 gzip / zstd / zip，兼容历史 db |
| **错误出口** | `src/save.js` / `src/load.js` `fail()` | 一行人话 + 退出码 1，不打堆栈 |
| **事务边界** | `src/save.js` `writeArchive()` | 哨兵语句收集全部异步错误 → 有错则 `ROLLBACK`，无错才 `COMMIT` |
| **追加兼容性** | `src/save.js` `checkAppendCompatible()` | 只允许追加到 v1 归档，否则提示文件无法保持最低偏移 |
| **追加回滚** | `src/save.js` `dropBatch()` | 自验证失败时按 taskid 删掉刚写的那一批 |
| **文件头（默认 PK 伪装 / --honest）** | `src/save.js` `writeHeader` / `looksDisguised` / `revealArchive` | 新产物默认 verify 后把前 16 字节覆盖为 PK 前缀（`--honest` 保留诚实 SQLite 头）；append 目标先经结构预检还原（预检不过不写外来文件），结束后按原状态重新伪装 |
| 文件头读取 | `src/load.js` main 头部检测 | 诚实头直接打开；默认/`--disguise` 伪装头复制到临时文件还原魔数（原文件只读） |
| **参数校验** | `src/save.js` / `src/load.js` `parseArgs()` | 未知选项 / 缺值 / 多余位置参数一律报错，不静默忽略 |
| 还原逻辑 | `src/load.js` `db.each('SELECT rpath, g, content FROM files')` | **无 WHERE 子句**，还原所有批次 |
| 目录创建 | `src/load.js` `putDBCaseToFile()` | 按分隔符逐段 `mkdirSync`（`recursive: true`） |
| 跨平台分隔符 | `src/load.js` | win32 `/`→`\`，darwin `\`→`/`，linux 不处理 |

## CODE MAP

| 符号 | 类型 | 位置 | 职责 |
|------|------|------|------|
| `main` | function | `src/save.js` | 编排：解析参数 → 遍历 → 归一化排序 → 建表 → 事务写入 → 自验证 |
| `traverseFolder` | function | `src/save.js` | 递归收集 `{a, g}` 列表 |
| `pathCheck` | function | `src/save.js` | 剥掉 PowerShell 粘贴残留的尾引号 |
| `nextAvailablePath` | function | `src/save.js` | 同名产物自动改名：test.zip → test (2).zip → … |
| `writeHeader` / `looksDisguised` / `revealArchive` | function | `src/save.js` | 伪装头的写入 / 结构预检（纯读）/ append 前还原（失败原样写回） |
| `verifyNotice` | function | `src/save.js` | 自验证：提示文件落在 page 2 内 |
| `parseArgs` / `usage` | function | `src/save.js`, `src/load.js` | 命令行参数解析与帮助 |
| `main` | function | `src/load.js` | 打开 db → 逐行还原 → 统计并退出 |
| `putDBCaseToFile` | function | `src/load.js` | 落盘：建目录 + 写文件 |
| `detect` / `decode` | function | `src/codec.js` | 按魔数识别并解压内容 |
| `pack` / `unpack` | function | `src/zipentry.js` | 单条目 zip 的构造与解析 |

> CLI 与 GUI 核心逻辑均有开发时测试覆盖（根目录 `npm test`，见 CONVENTIONS 测试门禁）；UI 渲染层由 selftest 状态断言覆盖。

## CONVENTIONS

- **CommonJS**：`require()`，`package.json` 无 `"type": "module"`。不要引入 ESM 语法。
- **sqlite3 必须 `.verbose()`**：`require('sqlite3').verbose()`。回调风格 API + `db.serialize()` 串行化 + `db.prepare()` 批量 INSERT。
- **Node ≥ 22.15**：zstd 依赖 `zlib.zstdCompressSync` / `zstdDecompressSync`。
- **缩进 4 空格**，语句结尾带分号。
- **引号**：普通字符串单引号；紧凑对象字面量用双引号键 —— `{"a": pathname, "g": 0}`。
- **路径**：一律走 `path.*`，不要手拼分隔符。
- **压缩**：只用 `src/codec.js` 里封装的格式，不要在别处直接调 `zlib.gzipSync` / `zstdCompressSync`。
- **唯一数据源**：`notice` + `files` 两张表，无索引、无视图、无迁移脚本。
- **错误处理**：所有失败走 `fail(msg)` —— 一行人话 + `process.exit(1)`，**不打堆栈**。不引入日志框架，不引入 `try/catch` 之外的异常吞噬。
- **不留半成品**：非 `--append` 模式下失败即删除产物；写入出错则 `ROLLBACK`，不 `COMMIT` 部分数据。
- **GUI 采用 Fluent 2 设计语言**：`gui/` 界面用自实现的 Fluent 2 CSS 令牌（accent `#0f6cbd` 色阶系、4/8px 圆角、Segoe UI Variable、分层浅阴影、150ms 曲线过渡、focus ring、overlay 细滚动条），**不引入 React/UI 框架/构建步骤**；样式集中在 `gui/style.css`，改 UI 时保持 440x600 布局与 12 条界面规范不变。
- **Fluent 样式参考底本（本地，不提交）**：`gui/vendor/fluentui/` 若在本地存在，存放 @fluentui/web-components@3.1.3 的 esm 源树（42 份组件原生 CSS）与 @fluentui/tokens 设计值（均 MIT），**仅作手工移植样式的参考** —— 禁止构建或运行时引用（打包已排除），并已加入 `.gitignore`，不随仓库分发。
- **测试门禁**：**改动任何代码后必须跑根目录 `npm test`** —— 聚合 CLI 行为 / GUI 核心 / GUI↔CLI 互通 / Electron selftest 四个套件，全绿才算完成。新的行为约定应同步补进 `test/cli.test.js` 断言（历史上靠临时脚本验证的约定都已固化 therein）。

## ANTI-PATTERNS（本项目中现存、勿沿用的写法）

- **不要改 `notice` 表的创建顺序**。它必须第一个建，否则拿不到 page 2，提示文件就会落在载荷之后 —— 自动化流程解出来的就是真实文件而不是提示文件。
- **自验证不要写成"全文件恰好一处 gzip 魔数"**。载荷是压缩后的字节，随机撞上 `1f 8b 08` 的概率随载荷体积线性增长（25MB 约 72%），那种断言会误杀合法归档。当前版本只验证"提示文件落在 page 2 内"；本条教训适用于未来任何重实现的验证方案。
- **不要用 zip 格式存载荷**。zip 是随机访问格式，嵌入 db 后中央目录偏移全部失效，读出的条目不可控（详见 `docs/DATA_FORMAT.md`）。
- **不要用 gzip 存载荷**。gzip 魔数与提示文件相同：载荷明文会被按 gzip 扫描的工具直接解出（v0 的实测教训，见 `docs/KNOWN_ISSUES.md` 第 20 条），也让自验证与扫描行为更难推理。
- `src/load.js` 的 `SELECT` 不带 `WHERE` —— 读取全部批次。
- 同步 I/O 贯穿全流程（`readdirSync` / `lstatSync` / `readFileSync` / 同步压缩）。
- `src/load.js` 的还原路径来自数据库内容且未做越界校验。
- **伪装头只能覆盖偏移 0-15**。偏移 16 起是 page size、`user_version` 等真实结构字段，多一个字节都会毁掉整个库；"删掉前 16 字节再补"同样不允许（页边界整体移位）。还原/追加前必须通过结构预检（PK 前缀 + `user_version` + 合法页大小），预检不过不写目标文件任何字节。

## UNIQUE STYLES

- **源目录名即归档根**：打包目录时顶层文件夹名会进 `rpath`；打包单文件时不进。
- **`g` 标志是位掩码**（类 Unix 权限位，位分配见 `docs/DATA_FORMAT.md`）：bit0(1) = 目录（`content` 为 NULL），`0` = 普通文件，其余位预留。判断必须用 `g & 1`，不能用真值。压缩格式不占标志位，由表区分（`notice` 表固定 gzip，`files` 表固定 zstd）。
- **rpath 统一 `/` 分隔**并按码位序排序（跨平台一致的确定性顺序）。
- **同名产物自动改名**：`test.zip` → `test (2).zip` → `test (3).zip`…（仿 Windows 资源管理器），任何失败都不波及既有归档。
- **`taskid` = `Date.now().toString()`**：一个 db 可累积多批次（`--append`），行只增不删。
- **提示文件靠物理位置投递**，不靠任何索引机制。
- **默认文件头伪装**：新产物前 16 字节为 zip PK 头，`--honest` 才保留诚实 SQLite 头；append 按目标原有状态保持，旗标不参与。

## COMMANDS

```bash
npm install                              # 安装唯一依赖 sqlite3@^5.1.6
npm test                                 # 开发时测试门禁：聚合 CLI 54 项 + GUI 20 项 + 互通 3 项 + Electron selftest
node src/save.js <源目录> [--out <名>] [--notice <文本>] [--notice-url <地址>] [--append] [--honest] [--disguise]
node src/load.js <文件> [--out <目录>]
run.bat                                  # 双击启动 GUI（首次运行自动补装 gui 依赖）

# GUI 版（Electron，产物与 CLI 同格式可互通）
cd gui && npm install && npm start       # 440x600 窗口；Electron 45（内置 Node 24.22，zstd 可用）
cd gui && npm test                       # GUI 核心逻辑测试（纯 Node）
cd gui && npm run selftest               # 无界面自检：状态断言 + 截图到 %TEMP%\miscjar-selftest\
cd gui && npm run package                # 打包当前平台 → dist\MiscJar-<platform>-<arch>\（离线，见 gui/README.md）
cd gui && node make-package.js darwin arm64  # 指定目标平台/架构（须在对应平台构建）
```

Windows 下两个脚本都有 `#!/usr/bin/env node` shebang，但需用 `node src/save.js` / `node src/load.js` 调用。
新产物默认伪装头（前 16 字节 PK）；`--honest` 保留诚实 SQLite 头；`--disguise` 兼容保留且与 `--honest` 互斥。
产物落在**执行命令时的工作目录**。

## NOTES

- 已验证：3 / 200 / 1000 个文件三种规模下，往返逐字节一致；提示文件偏移只由提示文本长度决定、与载荷规模无关（默认模板下为 8144），且提示文件之前不存在 gzip 流。
- 2026-10-24 变更：同名产物改为自动改名（不再先删后写）；rpath 统一 `/` 分隔并按码位序排序；`g` 判断改为位与；自验证简化为 page 2 结构验证。13 项端到端测试通过（改名序列 / 排序确定性 / 往返一致 / append / 失败不波及旧产物）。
- 2026-10-24 变更（二）：新增 `--disguise` 伪装头（默认诚实头）。verify 通过后覆盖前 16 字节为 PK 前缀；append 目标先结构预检再还原、结束后按原状态重新伪装（预检不过不写外来文件）；load 走临时副本保持原文件只读。24 项测试通过（含真 zip 不被误写、失败回滚后恢复伪装、临时副本清理）。
- 2026-10-24 变更（三）：新增 `gui/` Electron GUI 版。格式与 CLI 完全一致（notice page 2 / zstd 载荷 / 自验证），差异仅收集语义：多根收集（每项 basename 为顶层条目）、产物落在首个拖入项所在目录、解包落在归档所在目录且顶层冲突按 Explorer 改名。GUI 测试 19/19 + selftest 状态断言与截图验证通过。
- 2026-10-24 变更（四）：提示文件 gzip 流内嵌固定文件名 `readme.txt`（RFC 1952 FNAME，`src/codec.js` 手工组帧，MTIME=0 保持确定性）。扫描工具解出文件名不再随宿主名变（实测 7-Zip 26.05：老流解出名 = 宿主名，新流解出 `readme.txt`；「归档末尾有数据」为两者共有的既有行为，均照常解出）。偏移 8155 → 8144。
- 2026-10-24 变更（五）：GUI 打包全流程打通。`npm run package` → `dist\MiscJar-win32-x64\MiscJar.exe`。两个打包期坑已修：asar 下 `require('../../codec')` 逃出应用根致主进程启动即崩（改为开发态取根 / 打包态回退随包副本，package 脚本先拷 codec.js/zipentry.js 进 gui/）；selftest 写 `__dirname` 在 asar 内只读（改输出 %TEMP%）。`make-package.js` 用 `electronZipDir` 从 @electron/get 用户缓存离线取 zip（发行包+SHASUMS 均不联网）。打包版验收：selftest 全过 + 产物可被 CLI load.js 逐字节还原。
- 2026-10-31 变更（六）：建立开发时测试门禁。根目录 `npm test`（`test/run.js`）聚合四套件，任一失败即非零退出：CLI 行为测试 50 项（新增 `test/cli.test.js`——固化全部历史验证约定：往返一致 / rpath 归一化与码位序 / 同名自动改名 / 失败不波及旧产物 / FNAME=readme.txt / page 2 自验证 / --append 多批次与兼容检查 / --disguise 全链路含真 zip 不被误写 / 参数校验与错误路径 / 未知版本警告 / codec·zipentry 单元）、GUI 核心 20 项、互通 3 项、Electron selftest（result.log 关键断言校验）。变异演练：FNAME 变异被 2 项断言捕获；禁用排序的变异在 NTFS 上不可观测（readdir 天然字母序）——排序断言守护的是 ext4 等无序文件系统上的跨平台一致性。
- 2026-11-01 变更（七）：修复 dropzone 删除闪烁 + 重做删除交互动画。闪烁根因：label-in 入场动画挂在 .label 基类上，删除触发的整列重建让每行重播淡入 —— 现动画只挂在 .enter 且每个条目仅首次渲染时播放（it.entered 标记），重建/滚动一律不重播。新动画：被点行淡出+微缩退场（.exit，150ms），下方行经 top 过渡 180ms 平滑上移，200ms 后重建同步虚拟窗口；动画期间 removal 守卫挡重复点击，滚动触发的重建直接收敛到最终位置。#labels 加 scrollbar-gutter: stable 防滚动条增减时内容横跳。selftest 新增 state5/rows5 断言与 07 截图（重建行 anim=none 证实闪烁根因已断）。
- 2026-11-01 变更（八）：拖放区改为 Fluent 卡片观感 —— 288x288 + 四周 16px gutter 距窗口边缘（288+32=320，中带总高与窗口纵向布局不变），静置 shadow-4 淡阴影表现轻微高于背景，拖入悬停升至 shadow-8；label 宽度上限随之 160→144（保持要求 7 的「至多拖放区一半」比例）。
- 2026-11-01 变更（九）：重绘中部 logo。弃用手绘伪 3D 箭头+篮子，改用 Material Icons 「move_to_inbox」（箭头投入收件篮，Apache 2.0，来源与许可注明于 index.html）的语义，重绘为 Fluent regular 描边风格：浅灰描边圆角容器 + 收件口弧形凹槽 + 深一档实心箭头。
- 2026-11-01 变更（十）：评估 Fluent UI Web Components 直接采用后否决（实测坑：npm latest 标签仍指 v2；预打包单文件只注册兜底定义、无样式；样式生效依赖 alpha 版 tokens 的 setTheme；与无构建步骤约定冲突），改为在 `gui/vendor/fluentui/` 存源码底本按需抄样式；运行时依赖已卸载、打包 ignore vendor。
- 2026-11-07 变更（十一）：Electron 37.10.3 → 45.2.3（Electron 无 LTS，只维护最新三个大版本，37 已 EOL；按"无 LTS 则上最新稳定版"决策）。`gui/package.json` devDep `^37.0.0` → `^45.0.0`，内置 Node 22.16 → 24.22（zstd 能力不变，收益是受支持的 Chromium —— 本工具会解包外来文件）。四套件门禁全绿 + 打包版验收（selftest 退出码 0、全部状态断言过、产物被 CLI load.js 逐字节还原）。**网络坑**：Electron 二进制从 GitHub 直连会建连后 0 字节卡死，需 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 走 npmmirror 镜像跑 `node node_modules/electron/install.js`（产物为官方副本，SHASUMS 校验照常执行）；zip 落入 @electron/get 用户缓存后，`make-package.js` 的离线打包流程不变。sqlite3@5.1.7 NAPI 预编译在 Node 24 / Electron 45 直接可用。
- 2026-11-14 变更（十二）：窗口 320x480 → 440x600（dropzone 408x408 = 440−32，中带总高仍等于窗口宽；label 宽度上限 144→204 = 408 的一半，保持要求 7 比例；按钮 130x42→150x46，名称字号 15→16；renderer 虚拟滚动 vh 兜底值 312→400）。dropzone 背景改为项目根 `miscJar.png` 插画（`gui/miscJar.png` 为 package 脚本拷入的随包副本，模式同 codec.js；surface 兜底，图片缺失仍是白卡片）。拖入悬停反馈改为 accent 半透明纱罩（`#drop::after`，z 序在 label 之下）+ accent 描边 + shadow-8 —— 背景是不透明插画，原 background-color 着色不可见。原 SVG logo（变更九，造型语义取自 Material Icons move_to_inbox, Apache 2.0）从空态移除，语义由插画承担，出处注记保留在 index.html 注释；`has-items` 类仍由 renderer 维护。selftest 断言不依赖窗口尺寸。
- 2026-11-19 变更（十三）：源码整理 —— 根目录 `save.js` / `load.js` / `codec.js` / `zipentry.js` 移入 `src/`（内部相对 `require` 不变）；`test/cli.test.js`、`gui/test/interop.test.js`、`gui/lib/archive.js`（开发态取 `../../src/codec`）与 `gui/package.json` 的随包拷贝路径同步更新。历史笔记中的根路径指当时状态，现以 `src/` 为准。
- 2026-11-20 变更（十四）：文件头伪装改为默认开启。新产物默认把前 16 字节覆盖为 zip PK 前缀（`--honest` 保留诚实 SQLite 头；`--disguise` 兼容保留但已无实际效果，与 `--honest` 互斥）。append 仍按目标原有头状态恢复，旗标不参与。CLI 测试扩到 54 项（默认 PK / `--honest` / 两种头的 append 状态保持 / 互斥 / 伪装头下失败回滚），GUI 核心 20 项与互通 3 项同步按新默认校验。
- 2026-11-20 变更（十五）：`.gitignore` 分组整理，并新增 `gui/vendor/fluentui/` —— 该目录仅作本地样式参考，不参与构建/运行（打包已排除），不随仓库提交。
- 2026-11-20 变更（十六）：GUI 打包确认走标准 asar：`resources/app.asar`（应用代码）+ `resources/app.asar.unpacked/node_modules/sqlite3/.../node_sqlite3.node`（原生模块由 packager 自动解包）。修复 `make-package.js` 未 ignore `gui/.electron-zip/` 导致 158 MB Electron zip 被打进 app.asar（170 MB → 12 MB）；同时排除 `make-package.js` / `package-lock.json` / `README.md`。打包版 `MiscJar.exe --selftest` 退出码 0，全部状态断言通过。
- 2026-11-20 变更（十七）：接入 GitHub Actions。`.github/workflows/ci.yml`（push / PR：Windows + Node 24，跑根目录 `npm test`）；`.github/workflows/release.yml`（`v*` tag 或手动触发：全量测试 → `npm run package` → 打包版 selftest 验收 → 生成 `MiscJar-<tag>-win32-x64.zip` + `SHA256SUMS.txt` → 用 `gh` 创建/更新 Release）。新增 `gui/prepare-assets.js`：`start` / `selftest` / `package` 前把 `src/codec.js` / `src/zipentry.js` / `miscJar.png` 复制进 `gui/`（副本已 gitignore）；`make-package.js` 在本地 Electron zip 缺失时改为在线下载（CI 友好）。
- 2026-11-20 变更（十八）：CI / Release 修正并扩到六平台。action 升到 `actions/checkout@v7` / `actions/setup-node@v7`（消除 Node 20 弃用告警）。**CI 与 Release 都是六平台 matrix**：`windows-latest`、`windows-11-arm`、`macos-15-intel`、`macos-15`、`ubuntu-24.04`、`ubuntu-24.04-arm`，各在原生平台跑测试 + 打包 + 打包版 selftest；Release 额外上传 zip / tar.gz 到草稿 Release，publish job 汇总 `SHA256SUMS.txt` 后正式发布。`make-package.js` 支持 `[platform] [arch]` 参数与三平台 Electron 缓存目录。`node-gyp` 以 `^12.1.0` 覆盖 sqlite3 自带的 8.x（VS2026 支持；Windows arm64 无预编译，走源码编译）。新增 `test/check-selftest.js` 统一本地与 CI 的 selftest 断言校验。
- 2026-11-20 变更（十九）：六平台 CI / Release 首次全绿并发布 v0.1.0。修掉三处远端问题：(1) Linux 缺 Chromium 运行库，且 `chrome-sandbox` 的 SUID 检查发生在 `main.js` 之前 → apt 补全依赖，`test/run.js` 与打包版 selftest 在 Linux 用命令行 `--no-sandbox --disable-dev-shm-usage`（`app.commandLine` 太晚）；(2) `windows-11-arm` 上可见窗口让 selftest 挂起 → selftest 改隐藏窗口 + 180s 看门狗 + 页面加载/截图/executeJavaScript 超时 + 增量写 `result.log`，测试入口各套件加超时；(3) 远端排障困难 → CI / Release 失败时把 `test-output.log` 与 `result.log` 转成 annotation。v0.1.0 Release 已发布六个平台产物 + `SHA256SUMS.txt`（Windows / macOS 为 zip，Linux 为 tar.gz）。Linux 用户若遇 SUID sandbox 报错，需 `chown root:root chrome-sandbox` + `chmod 4755`，或加 `--no-sandbox`。
- 本地已初始化 git（origin `git@github.com:kaikaiiiiiii/MiscJar.git`，默认分支 `master`）；CI 见 `.github/workflows/`：push / PR 跑 `npm test`，`v*` tag 触发六平台打包发版。
- 已验证的错误路径：路径不存在 / 缺少参数 / 未知选项 / 选项缺值 / 多余位置参数 / 源文件读失败（EPERM）/ 产物路径无效 / 非 SQLite 文件 / 缺 `files` 表 / 内容损坏 —— 全部为「一行人话 + 退出码 1 + 不留半成品」。
- `package.json` 已含 `name` / `version` / `license` / `repository` / `engines` 与 `scripts.test`；发布版本号以此为准（Release 工作流会校验 tag 与 `version` 一致）。
- 格式版本用 `PRAGMA user_version`；演进只能靠新增列/表保持向后兼容。
