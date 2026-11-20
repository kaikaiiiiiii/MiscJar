# 谜罐 MiscJar 归档格式规范

描述 `src/save.js` 产出、`src/load.js` 消费的归档内部结构，供第三方读写工具与格式迁移参考。

## 概览

- 归档是**一个 SQLite 3 数据库文件**，通常命名为 `.zip`（扩展名可自定义，与内部结构无关）。
- 一个数据库可以包含**多个打包批次**（`taskid` 区分）。
- 数据库中**只有两张表**：`notice`（提示文件）与 `files`（载荷）。无索引、无视图、无触发器。
- `files` 表是 append-only：只 INSERT，从不 UPDATE / DELETE。

## 文件布局

| 项 | 值 |
|---|---|
| 默认文件名 | `<源目录名>.zip`（`--out` 可覆盖） |
| 同名冲突 | 已存在时**自动改名**：`test.zip` → `test (2).zip` → `test (3).zip`…（不覆盖、不删除已有产物） |
| 文件头 | 默认前 16 字节为 zip PK 伪装头；`--honest` 保留诚实 SQLite 魔数（见「文件头」） |
| 路径来源 | 相对于**执行命令时的工作目录** |
| 类型 | SQLite 3 数据库，默认头部伪装为 zip：SQLite 客户端直接打开报 `SQLITE_NOTADB`；`--honest` 产物可直接打开 |

## 版本

格式版本记录在 SQLite 文件头的 `user_version` 字段（偏移 60-63）：

```sql
PRAGMA user_version = 1;
```

| 版本 | 载荷格式 | 提示格式 |
|---|---|---|
| 1 | zstd | gzip |

读取端应检查 `user_version`；未知版本应拒绝处理而不是猜测。

> `user_version = 1` 内的一次写入约定演进（2026-10-24）：`rpath` 统一以 `/` 分隔、打包前按 rpath 码位序排序、`g` 明确为位掩码。均为收紧写入约定、未新增表结构，新旧读写端双向兼容，故不递增版本号。

## 文件头（默认 PK 伪装，`--honest` 可选诚实头）

默认产物把**前 16 字节**原位覆盖为一个 zip local file header 前缀（`PK\x03\x04` + 固定字段；完整 local header 需 30 字节，但偏移 16 起是 page size 等真实字段，只能占用魔数这 16 字节）。`--honest` 是显式退出：产物保留诚实的 SQLite 文件头（`SQLite format 3\0`）。默认伪装自 2026-11-20 起（此前默认诚实头、`--disguise` 可选，见 `DESIGN.md` 3.9）：

| 项 | 值 |
|---|---|
| 覆盖范围 | 仅偏移 0-15（纯魔数，零信息量，可无损还原） |
| 不变字段 | page size（偏移 16-17）、`user_version`（偏移 60-63）等全部结构字段 |
| 伪装状态 | 不落库，仅由头 16 字节体现（`user_version` 仍为 1） |
| 识别效果 | 头部嗅探工具（libmagic / `file`）从 "SQLite 3.x database" 改判 "Zip archive data" |
| 不变行为 | 严格 zip 解析器仍拒绝（无 EOCD）；流扫描器仍第一个命中 page 2 提示文件 |

规则：

- `src/load.js` 自动识别两种头：伪装头归档复制到**临时文件**、还原魔数后打开，**原文件全程只读**。
- `--append` 目标无论原本是伪装头还是诚实头：先按需还原魔数 → 追加 → 按其**原有状态**恢复（追加不改变归档的伪装状态）；追加失败回滚后同样恢复。旗标（`--honest` / `--disguise`）不影响追加结果。
- 还原前先做结构预检（PK 前缀 + 偏移 60 `user_version == 1` + 合法页大小）：预检不过**不写目标文件任何字节**——指向真 zip 等外来文件的误操作不会破坏它；预检过了但验证失败也把原 16 字节原样写回。
- 检测一个文件是否本工具伪装归档：PK 前缀 + 偏移 60 大端 u32 == 1 → 疑似；还原魔数、以 SQLite 打开并验证 `notice`/`files` 表 → 确认。

## 表结构

```sql
CREATE TABLE notice(          -- 必须最先创建
  id INTEGER PRIMARY KEY,
  content BLOB                -- 提示文件的 gzip 流
);
CREATE TABLE files(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taskid TEXT,
  rpath TEXT,
  g INTEGER DEFAULT 0,        -- 标志位掩码, bit0 = 目录 (见下文"标志位分配")
  content BLOB                -- 文件内容的 zstd 流 (目录行为 NULL)
);
```

| 列名 | 类型 | 含义 |
|---|---|---|
| `notice.id` | INTEGER | 固定为 1（`INSERT OR REPLACE`） |
| `notice.content` | BLOB | 提示文件内容，**gzip 格式**（RFC 1952，头 `1f 8b 08`）；头部 FNAME 字段固定为 `readme.txt` |
| `files.id` | INTEGER | 行序号，自增，还原顺序即 id 升序 |
| `files.taskid` | TEXT | 打包批次标识，值为打包时刻的 `Date.now().toString()` |
| `files.rpath` | TEXT | 相对归档根的路径，**统一以 `/` 分隔**（2026-10-24 起；更早归档可能是写入平台的原生分隔符） |
| `files.g` | INTEGER | 标志位掩码：bit0（值 1）= 目录（`content` 为 NULL），`0` = 普通文件；位分配见下节 |
| `files.content` | BLOB | 文件内容的 **zstd 帧**（头 `28 b5 2f fd`）；目录行为 NULL |

## 标志位分配（`g`）

`g` 是**位掩码**（类似 Unix 权限位），值为 `2^a1 + 2^a2 + …`，用一个数字同时表达多个标志：

| 位 | 值 | 含义 | 状态 |
|---|---|---|---|
| bit0 | 1 | 目录（`content` 为 NULL） | v1 使用 |
| bit1 | 2 | 符号链接（`content` 拟存目标路径，方案待定） | 预留 |
| bit2+ | 4+ | 预留（权限位、特殊文件等） | 预留 |

约定：

- v1 实际写入的合法值只有 `0`（普通文件）与 `1`（目录）。
- **判断必须用位与**（`(g & 1) !== 0`），不能用真值（`if (g)`）—— 一旦未来出现 `g = 2`，真值判断会把符号链接误判成目录。
- 读取端遇到含未知位的值应**忽略未知位、按已知位处理**（前向兼容）。
- 新增标志只能占用未分配的位，不得改变已有位的含义。

## 路径规则

归档根定义为打包目标的**父目录**：

```js
root = path.dirname(source)
rpath = path.relative(root, file.a).split(path.sep).join('/')   // 统一 / 分隔
```

因此**顶层目录名会被保留**。

打包前 filelist 按 rpath 的**码位序**排序，`id` 升序 = rpath 码位序 —— 同一目录多次打包产生可比较的归档，且顺序跨平台一致。

| 磁盘绝对路径 | `root` | 存入的 `rpath` |
|---|---|---|
| `C:\x\test\hello.txt` | `C:\x` | `test/hello.txt` |
| `C:\x\test\sub\deep.bin` | `C:\x` | `test/sub/deep.bin` |

**例外 —— 打包目标是单个文件时**：`root` 变成该文件的父目录，`rpath` 只剩文件名，目录结构信息丢失。

**目录条目只为空目录显式落库**；非空目录由其子项的 `rpath` 隐含表示。

## 字节布局保证（关键）

`notice` 表**必须最先创建**，因此：

```
page 1  文件头 + schema
page 2  notice 表  ← 提示文件, 内容偏移 ∈ [4096, 8191]
page 3+ files 表   ← 载荷,   内容偏移 ≥ 8192
```

**任何载荷字节都不可能落进 page 2。** 这是 SQLite 页分配的结构性保证，与文件大小、文件数无关。

由此得到两个性质：

1. **提示文件独占 page 2**，内容偏移必然低于所有载荷（page 3+）。
2. **它是文件中偏移最低的 gzip 流。**

第 2 条很重要：载荷是压缩后的字节，**可能随机撞上 gzip 魔数 `1f 8b 08`**（25MB 载荷约 72% 概率至少一次）。但这些命中全部位于提示文件**之后**，而扫描器从头正向扫魔数，**第一个命中的一定是提示文件**。所以随机命中无害。

> 这也是 `src/save.js` 打包后要做自验证的原因。当前判据是：**提示文件落在 page 2 内**（`[pageSize, 2*pageSize)`）—— 满足它，"任何载荷字节都不可能更靠前"的结构保证即成立；不满足就拒绝产出、删除产物、退出码非零。
>
> 历史注：早期版本还逐字节扫描全文件断言"提示文件之前不存在任何 gzip 流"（判据**不能**写成"全文件恰好一处 gzip 魔数"—— 载荷随机撞上 `1f 8b 08` 的概率随体积增长，会误杀合法归档）；该扫描因纯 JS 实现太慢（实测约 13MB/s）已移除，"扫描器第一个命中提示文件"的端到端验证后续以另一种方案实现。

## 内容编码

| | 载荷（`files.content`） | 提示（`notice.content`） |
|---|---|---|
| 格式 | zstd frame (RFC 8878) | gzip (RFC 1952) |
| 魔数 | `28 b5 2f fd` | `1f 8b 08` |
| 内嵌文件名 | — | 头部 FNAME 固定为 `readme.txt`（扫描工具解出的输出名） |
| 逐文件独立压缩 | 是 | — |
| 目录条目 | 无内容 | — |

**不使用 zip 格式。** zip 是随机访问格式（EOCD 在尾部、中央目录记录绝对偏移），嵌入数据库后偏移全部失效，读取端必须做 concat 补偿（`concat = EOCD位置 - cd_size - 记录的cd_offset`）才能读对，且不同实现的补偿与选取规则不一致（有的取最低偏移的 local header，有的取最高偏移的 EOCD），导致读出的条目不可控。

gzip / zstd 都是**单向流 + 固定魔数开头**，扫描器只需按字节序列匹配，选取规则统一为"偏移最低者胜"，因此可预测。

## 批次与合并语义

- 一次 `src/save.js` 运行 = 一个批次，所有 `files` 行共享同一 `taskid`。
- `src/save.js` 默认**不覆盖**已有产物（同名自动改名，见上文）；`--append` 才追加到已有 db。
- **`--append` 只能追加到 v1 归档**（`user_version = 1` 且存在 `notice` 表）。v0 归档的 gzip 载荷落在 page 2 附近，追加进去会让提示文件不再是最靠前的那个 —— 工具在写入前直接拒绝。
- `src/load.js` 执行 `SELECT rpath, g, content FROM files`，**没有 WHERE 子句** —— 还原时会读出数据库里所有批次的所有行，按 `id` 升序。
- 由此产生的后果：**若多个批次包含同一条 `rpath`，后写入的（`id` 更大）在还原时覆盖先写入的**。数据库本身不记录「哪个批次应该胜出」这一意图。
- `src/load.js` 没有按 `taskid` 过滤或选择批次的入口。

## 写入与读取的事务边界

| 阶段 | 行为 |
|---|---|
| 写入 | prepared statement + `db.serialize()`，整个批次包在**一个** `BEGIN TRANSACTION` … `COMMIT` 之间，随后 `db.close()`。 |
| 读取 | `db.each('SELECT …')` **逐行流式**回调，内存占用与行数无关。 |

## 跨平台还原

`rpath` **统一以 `/` 存储**；`src/load.js` 在写盘前按平台修正：`win32` → `/` 变 `\`；`darwin` → `\` 变 `/`（兼容更早的 Windows 归档）；其余平台不处理（`/` 即原生分隔符）。

2026-10-24 之前的归档 `rpath` 可能是写入平台的原生分隔符（Windows 归档为字面量 `\`）。此类历史归档在 win32 / darwin 上仍可正常还原；在 Linux 上不做改写，会还原出文件名中带字面 `\` 的文件 —— 已知历史行为，仅影响旧归档。

## 向后兼容

读取端应能识别历史内容格式。`src/codec.js` 按魔数自动识别：

| 魔数 | 格式 | 说明 |
|---|---|---|
| `1f 8b 08` | gzip | 历史 v0 载荷格式 |
| `28 b5 2f fd` | zstd | v1 载荷格式 |
| `50 4b 03 04` | zip 单条目 | 实验期格式 |

v0 的 db **没有 `notice` 表**，因此不存在提示文件，也无法通过"扫描 gzip 流"投递提示 —— 这是格式升级时唯一不可回溯的差异。

---

相关文档：[`../README.md`](../README.md)（用法）· [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md)（已核实问题清单）· [`../AGENTS.md`](../AGENTS.md)（代理知识库）
