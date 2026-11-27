# 1.0.0 审核意见整改记录

- **对应意见**：`review-list.md`（1.0.0 审核：3 条必须整改 + 3 条建议整改）
- **状态**：全部完成，`pnpm check` 380 项断言 + `pnpm build` 通过
- **范围**：`preload/` 的授权与参数校验、配置读写、二进制探测、批量探测调度；渲染层只改了配置写入点与提示

## 总览

| # | 意见 | 类型 | 结论 | 主要落点 |
|---|---|---|---|---|
| M1 | `getPath` 把 home / documents / userData 等登记为可读写 | 必须 | 已整改 | `preload/index.js` `getPath`、`guard.js` |
| M2 | `setConfig({outputDir})` 给下个会话发写通行证 | 必须 | 已整改 | `index.js` `setConfigGuarded`、`config.js` |
| M3 | 任意文本写临时目录 + concat 列表未校验条目 | 必须 | 已整改 | `fsx.js` `makeConcatList`、`argswhitelist.js` |
| S1 | `setConfig` 整份合并进同步库，无键名/类型/体积限制 | 建议 | 已整改 | `config.js` 两张键表 |
| S2 | 启动强制全量跑 `-version` | 建议 | 已整改 | `binaries.js` 盘缓存 |
| S3 | `probeMany` 串行、无上限、不可取消 | 建议 | 已整改 | `pool.js`、`index.js` |

---

## M1 · `getPath` 扩权

**意见**：`PATH_NAMES` 里包含 home、documents、pictures、music、videos、userData、appData、exe，而 `getPath` 对每个 key 都 `grantDir`，等于把该目录同时登记为可读与可写。页面调一次 `getPath('home')` 就能 `assertReadDir` 放行整个家目录（`listMedia` 还能递归枚举），也能往家目录直接子级写文件。

**根因**：`grantDir` 一份实现同时写 `readDirs` 与 `writeDirs`，而 `getPath` 没区分「输出位置」与「用户选中的目录」。

**修复**：

1. `PATH_NAMES` 收敛到 `['desktop','downloads']`，其余名字一律返回空字符串——不返回路径，也不授权
2. 新增 `guard.grantWriteDir(dir)`：只写 `writeDirs`。`getPath` / `chooseDir` / 启动授权 / 恢复自定义输出目录四处改用它
3. `guard.grantDir`（读 + 写）只保留给用户手势选中的目录
4. `assertReadDir` 去掉 `writeDirs.has(...)`——写授权不再等于可枚举（见 [A1](#a1--写授权不等于可读复核阶段追加)）

**回归防线**：`guard.test.mjs` 断言「只写目录可写、可探测重名、但不可列举、其中文件不可读」；`api-surface.test.mjs` 断言 `getPath('desktop')` 后 `listMedia` 返回空、`probe` 报 `EREAD_DENIED`、`getPath('home'/'documents')` 返回空串。

## M2 · `setConfig({outputDir})` 通行证

**意见**：`setConfig` 只把 `outputDir` 从同步库剥离写本机配置，既不校验路径也不校验是否经过用户选择；启动时对 `cfg.outputDir` 无条件 `grantDir`。页面调一次 `setConfig({outputDir:'/Users/xxx'})`，下次启动该目录就成为可写白名单。

**根因**：授权状态没有可信来源校验，配置值被当作授权依据。

**修复**：

1. 桥接层 `setConfig` 改名 `setConfigGuarded`：`outputDir` 只在「本次会话已授权（`assertWriteDir` 通过）」或「与已存值一致」时才落地，其余丢弃
2. 启动恢复白名单只对**真实存在的目录**授权（`fsx.isRealDir` 过滤失效值）
3. 复核阶段补：`migrate()` 不再把同步库里的 `outputDir` 搬进本机，`LOCAL_VERSION` 升到 2 并丢弃 v1 本机文件里的该值（见 [A2](#a2--老版本-outputdir-残留复核阶段追加)）

**回归防线**：`config.test.mjs` 断言「同步库 outputDir 不迁移」「v1 本机 outputDir 被丢弃」「相对路径被拒」；`api-surface.test.mjs` 覆盖 `setConfigGuarded` 的接口面。

## M3 · concat 列表绕过输入白名单

**意见**：`makeTempText` 接受渲染层给的任意文本（上限 4MB）写进临时目录，而 `-f concat` 的校验只看列表文件「在临时目录 + 扩展名 .txt」，不解析条目。渲染层可以写一份列出家目录任意音频的列表，让 ffmpeg 读到未经 `assertReadFile` 授权的文件。

**根因**：临时目录里的 `.txt` 被当作可信输入，列表内容没有逐条校验。

**修复**：

1. 删除 `makeTempText`，改为 `fsx.makeConcatList(paths)`：只接受路径数组，逐条 `assertReadFile`，任一条未授权整份失败（不静默剔除），上限 200 条，单引号按 `'\''` 转义
2. `argswhitelist` 的 `-f concat` 校验：必须紧跟 `-safe 0 -i <插件临时目录里的 .txt>`；`checkConcatEntries()` 逐行解析 `file '...'`，还原转义后各自 `assertRead`
3. 同时收口其它路径型参数：`-attach` / `-passlogfile` / `-filter_complex_script` 等根本不在 flag 表里

**回归防线**：`args.test.mjs` 覆盖「concat 列表含未授权条目」「条目格式非法」「列表文件不在临时目录」三类反例；`features-args.test.mjs` 用 17 个功能的真实参数全量过白名单。

---

## S1 · 配置键表校验

**意见**：`setConfig` 把渲染层对象整份合并进 dbStorage，键名、类型、体积都没限制。

**修复**：`config.js` 新增 `SYNC_SCHEMA`(12) / `LOCAL_SCHEMA`(5) 两张键表，成为配置键的唯一来源；`normalizeValue` 逐键校验类型与取值域（枚举、区间夹取、字符串长度、文件名非法字符、数组上限），`pickValid` **遍历键表**而不是入参（天然挡掉 `__proto__` / `constructor`）。写入超过 8KB 整份拒写；读侧 `getConfig()` 用同一套表归正，畸形值回落 `DEFAULTS`。

细节与键表见 [reference/config-and-storage.md](./reference/config-and-storage.md)。

**回归防线**：`config.test.mjs` 断言「键表 ∪ LOCAL_SCHEMA === DEFAULTS 键集」「未知键/类型错/超量/超体积」「原型污染」「同步与本机分流」。

## S2 · 探测结果持久化

**意见**：模块加载时 `setTimeout(detect(true))`，每次启动都逐个跑 `-version`。

**修复**：新增 `binaries.cache.json`（与 `config.local.json` 同目录），记录路径 + mtime + size + 版本，`versions` 表兼存负结果；`trusted()` 三重校验（文件名白名单 + 可执行位 + 身份三元组）后才采信；启动 `warmup()` 先同步读盘，命中不起子进程，超 24h 后台静默复探。顺带修正 `host` 模式短路、`detect(true)` 不再被 `inflight` 吞掉、`scan()` 复用 `-version` 结果。

**回归防线**：`binaries.test.mjs` 覆盖缓存命中、mtime 变化失效、`/bin/sh` 不被采信、损坏 JSON、目录只读、force 真重探。

## S3 · 批量探测并发与取消

**意见**：`probeManyGuarded` 逐个串行、无上限、无取消，拖几百个文件时进度长时间停住。

**修复**：新增 `preload/lib/pool.js` 的 `runPool`（滚动补槽）；`probeMany` 改成并发 3、每 200 个一批、结果同序等长；新增 `cancelProbe(jobId)` 与 `caps.probeCancel`，取消时 `AbortController` 中断 ffprobe、按进程 id 终止 ffmpeg 回退路径，未派发位置补占位并补回调；`onOne` 保证对每个入参恰好一次，渲染层的「读取中 N」不会挂住。`ffmpeg -i` 回退路径补 15s 超时。

**回归防线**：`pool.test.mjs`（并发上限/同序/取消/抛错停止派发）、`probe.test.mjs`（9 文件快于串行、取消后回调仍 N 次、旧 jobId 返回 false）。

---

## 复核阶段追加

这两条不在 fix.md 原文里，是提交前按自检 skill 复核 `dist/` 时发现的同族残留。

### A1 · 写授权不等于可读（复核阶段追加）

**现象**：实测页面调 `getPath('desktop')` 后，`listMedia` 能递归列出桌面里从未拖入的文件，`probe` 也能读——M1 只把 `PATH_NAMES` 收敛到 desktop/downloads，`grantDir` 仍然同时授读写，`assertReadDir` 又认 `writeDirs`。

**修复**：拆 `grantWriteDir`（只写）；`assertReadDir` 不看 `writeDirs`；输出位置四处改用它。`assertWriteTarget` / `assertProbe` / `assertOpen` 仍看 `writeDirs`，重名检测与「在文件夹中显示」不受影响。

**回归防线**：`guard.test.mjs` 与 `api-surface.test.mjs` 的「只写目录不可枚举」用例。

### A2 · 老版本 outputDir 残留（复核阶段追加）

**现象**：同步库里预置 `{outputDir: '<任意目录>'}`（老版本 setConfig 不校验，可能被页面写过），启动后该目录仍成为可写白名单——启动只用 `isRealDir` 过滤了「不存在」，没解决「未授权」。

**修复**：`MIGRATE_KEYS` 只含 `ffmpeg*` 与 `artistHistory`，`outputDir` 永不迁移；`LOCAL_VERSION` 升到 2，`upgradeLocal()` 丢弃 v1 本机文件里的 `outputDir`（照顾已经升级过一次的用户）；`migrate()` 不再按「本机已有 version」早退，但本机已有的键不覆盖。

**回归防线**：`config.test.mjs` 的三条迁移用例；实测脚本确认残留目录 `assertWriteDir` 返回 `EWRITE_DENIED`。

---

## 自检后追加（不是审核意见，按自查报告改的）

提交前按 `.agents/skills/utools-plugin-selfcheck` 复核 `dist/`，又提了三条建议，一并处理：

| # | 问题 | 修复 | 回归防线 |
|---|---|---|---|
| B1 | 本机目录全不可写时，`writeLocalRaw` 把 `outputDir`/`ffmpegPath` 写进 `dbStorage` 的 `config:local`，绝对路径随账号上云 | 去掉该降级键：改为进程内 `memoryLocal`，落盘失败只表示「本次会话有效」；`getConfig()` 的 `_localDegraded` 由界面提示 | `config.test.mjs` 的「本机目录不可写」用例：内存里可读、同步库零写入、不在家目录建目录 |
| B2 | `SYNC_SCHEMA.params` 允许自由文本（歌名/艺术家），虽无写入点仍是潜在上云通道 | 整键删除（`DEFAULTS`、键表、`sanitizeParams` 一并移除），同步库不再有任何自由文本字段 | 键集全等断言 + 「params 不再是配置键 / 不会被写进同步库」 |
| B3 | `renderPreview` 的 `token` 未校验就拼进进程 id，含 `/` 时 `cancelTask` 拒绝 → 预览取消不掉 | 桥接层夹到 `^[A-Za-z0-9_-]{1,40}$`；previewer 的兜底 id 改成短随机串，不再用文件名 | 代码约束记录在 [reference/security.md](./reference/security.md) |

## 验证

| 项 | 结果 |
|---|---|
| `pnpm check` | 10 个脚本、381 项断言全过（guard 38 / api-surface 29 / args 35 / features-args 97 / paths 34 / config 73 / pool 14 / binaries 25 / probe 25 / smoke 11） |
| `pnpm build` | 18 个文件、0.42MB、无 ffmpeg/ffprobe、`plugin.json` 13 个工具 |
| 自检 | 按 `.agents/skills/utools-plugin-selfcheck` 复核 `dist/`：无二进制/`.map`/开发机路径，preload 全明文，无 `eval`/外链/上报/剪贴板读取 |

## 边界：刻意没做的事

- **不缓存单文件 probe 结果**：超出审核范围，且「mtime 未变内容变」会返回旧元信息
- **不改 `findSystemBinary` 的串行枚举**：缓存命中后每个候选只剩一次 `statSync`，改并发会同时拉起多个进程，收益低风险高
- **不动 `queue.js` 的并发语义**：AGENTS 明确禁止

## 后续相关调整（与本次审核无关，但影响键名与数据面）

- 标识 `audio-batch` → `utools-audio-toolbox`：同步键 `utools-audio-toolbox:config`、临时前缀、本机兜底目录、`plugin.json` 的 feature code（未做旧数据迁移）
- `artistHistory` 从同步库移到本机（用户输入不上云），老云端值一次性搬回并删除
- 本机配置目录兜底移除 `~/` 下的隐藏目录，只留 userData / appData / 系统临时目录
