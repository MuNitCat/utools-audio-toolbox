# 配置与本地存储

## 两份配置

| | 存储 | 键前缀 | 内容 |
|---|---|---|---|
| 同步 | `utools.dbStorage`（随账号上云） | `utools-audio-toolbox:config` | 跨设备有意义的偏好，**不含路径、不含用户输入** |
| 本机 | `config.local.json` | 同目录的 `binaries.cache.json` | 绝对路径、用户输入、探测缓存 |

读取时合并成一个对象返回，前端不需要关心来源；本机文件不可用时结果带 `_localDegraded: true`，界面会提示「本次设置仅在当前会话生效」。

### 同步键（`SYNC_SCHEMA`，11 个）

| 键 | 约束 |
|---|---|
| `theme` | `auto` / `light` / `dark`（必须含 auto） |
| `outputMode` | `sibling` / `downloads` / `desktop` / `custom`（必须四个都列，漏了会把输出位置打回同级） |
| `overwrite` | 布尔 |
| `concurrency` | 1–4，越界夹取 |
| `lastFeature` / `lastGroup` | 标识符格式 |
| `hiddenFeatures` | 字符串数组，≤32 项 |
| `suffix` | ≤64 字符，含 `/ \ : * ? " < > \|` 或控制字符整值拒绝 |
| `targetLufs` / `truePeak` / `lra` | 数值区间，越界夹取 |

`suffix`、`lastGroup`、`targetLufs/truePeak/lra` 目前没有写入点，属于历史键。
`params` 曾允许自由文本（歌名/艺术家等），因没有任何读写点已整键删除——同步库里不要再出现自由文本。

### 本机键（`LOCAL_SCHEMA`，5 个）

`outputDir`、`ffmpegPath`、`ffmpegMode`、`ffmpegExtras`、`artistHistory`。

绝对路径类键与**用户输入**（`artistHistory`）只能放这里——同步库随账号上云，不要放过任何用户内容。`LOCAL_KEYS` 由 `LOCAL_SCHEMA` 推导，不要手写数组。

## 写入：`setConfig` 的顺序不能换

1. `migrate()` —— 必须在整份覆盖之前，否则会把老版本的 `ffmpeg*` 静默抹掉
2. 形状检查：非纯对象或键数 >32 整份拒绝
3. 本机键分流：`outputDir` / `artistHistory` 过类型校验后走 `setLocal`；`ffmpeg*` 只能由 binaries 内部写，静默剥离
4. 同步键：`pickValid(patch, SYNC_SCHEMA)`，未登记键与非法值静默丢弃
5. 体积：合并后超 8KB **整份拒写**（不要改成部分写入）
6. 落库 + 写本机文件

## 读取：归正只能在 `getConfig()` 做

```js
migrate()
const sync = pickValid(readSyncRaw(), SYNC_SCHEMA)
const local = pickValid(readLocalRaw(), LOCAL_SCHEMA)
const merged = { ...DEFAULTS, ...sync, ...local }
```

**不要把归正下沉进 `readSyncRaw()`**：`migrate()` 依赖它还能看到老版本写进同步库的 `ffmpeg*` 键，一旦看不到就等于丢用户的 ffmpeg 路径。

## 版本与迁移

- `LOCAL_VERSION = 2`。读到 v1 时 `upgradeLocal()` 丢弃 `outputDir`（v1 里它可能是老版本渲染层任意写入的，无法证明来自用户手势）
- `migrate()` 只搬 `MIGRATE_KEYS`（`ffmpegPath` / `ffmpegMode` / `ffmpegExtras` / `artistHistory`）：
  - `artistHistory` 老版本存在云端，搬回本机后从同步库删除（用户要求只在本地）
  - **`outputDir` 永不迁移**：来源不可证明，宁可让用户重选一次
  - 本机已有的键不覆盖；没有可搬的键就不写盘
  - 不再按「本机已有 version」早退——后加的迁移项对已迁移过的用户仍要清一次

## 本机目录

按顺序探测，第一个可写的就用：

1. `api.getPath('userData')`（宿主决定，主路径）
2. `appData/utools-audio-toolbox`
3. 系统临时目录 `utools-audio-toolbox-state`

**不要加回家目录下的配置目录**：未经告知在 `~/` 建隐藏目录属于审核会追问的隐私问题。

三者都不可写时，配置只放进程内存（`memoryLocal`），**绝不退回同步库**——那会把 `outputDir`、`ffmpegPath` 这些绝对路径同步到账号。`getConfig()` 会带 `_localDegraded: true`，界面提示「本次设置仅在当前会话生效」。

## 探测缓存 `binaries.cache.json`

```json
{ "schema": 1, "at": 0, "ffmpeg": {...}, "ffprobe": {...}, "skipped": [], "versions": {} }
```

- 只缓存「同一路径 + 同 mtime + 同 size」的已验证结论；命中前过 `trusted()`（文件名白名单 + 可执行位 + 身份三元组）
- `versions` 兼存负结果（`version: ''`），否则 `ffmpeg version n7.0` 这类解析不了的构建每次都要重跑
- 启动 `warmup()` 先同步读盘，命中就不起子进程；超 24h 后台静默复探一次
- 写盘失败只 warn 一次并退化为纯内存，**绝不写进 dbStorage**（绝对路径会随账号同步到别的电脑）
- `host` 模式直接短路，不枚举候选；`detect(true)` 必须真的重探，不能被 `inflight` 吞掉
