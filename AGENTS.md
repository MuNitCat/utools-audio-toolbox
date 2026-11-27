# AGENTS.md

给在本仓库工作的 AI Agent / 人类协作者。**动手前先扫一遍第 3 节的硬约束**——每条都对应一个已经踩过的真实故障；来龙去脉在 `doc/reference/` 里。

## 1. 这是什么

uTools 插件「音频批量处理」。React 18 + Vite 5，`preload` 是 CommonJS 桥接层，所有音视频处理走宿主提供的 `utools.runFFmpeg()`。打包后约 0.42MB，**不含任何二进制**。

```bash
pnpm install
pnpm dev      # 5180，host 固定 127.0.0.1
pnpm build    # vite build + 构建断言 → dist/
pnpm check    # 10 个 scripts/check/*.test.mjs
```

包管理器固定 **pnpm**；`dist/` 是产物，不要手改、不要提交。构建失败先读 `✗ 构建校验失败：...`，不要绕过。

## 2. 数据流

```
features.js（意图 → op）→ args.js（唯一参数生成处）→ queue.js（2 路并行）
  → window.audioServices → argswhitelist.js（逐 token 校验）→ guard.js（路径白名单）
  → utools.runFFmpeg()
```

拖入文件后的元信息读取是另一条支路：`probeMany` → `runPool` → `probe.js`，与执行队列无关，不要合并。

详见 [doc/reference/architecture.md](doc/reference/architecture.md)。

## 3. 硬约束速查

| # | 约束 | 详见 |
|---|---|---|
| 1 | 产物里不要带 ffmpeg / ffprobe | [testing](doc/reference/testing.md) |
| 2 | 禁止 `aresample=...:resampler=soxr` | [ffmpeg](doc/reference/ffmpeg.md) |
| 3 | FLAC 合并一律重编码 | [ffmpeg](doc/reference/ffmpeg.md) |
| 4 | loudnorm 第二遍必须显式 `-ar 48000` | [ffmpeg](doc/reference/ffmpeg.md) |
| 5 | 没有 ffprobe：只能解析 `ffmpeg -i` 的 stderr | [ffmpeg](doc/reference/ffmpeg.md) |
| 6 | 工具名单一来源（`tool-names` + `TOOL_DEFS`） | [features](doc/reference/features.md) |
| 7 | `registerTool` 必须在模块加载时执行 | [features](doc/reference/features.md) |
| 8 | preload 不暴露 `fs` / `path` / `child_process` | [security](doc/reference/security.md) |
| 9 | 默认永不覆盖原文件 | [ffmpeg](doc/reference/ffmpeg.md) |
| 10 | 未指定输出目录时落到源文件同级 | [ffmpeg](doc/reference/ffmpeg.md) |
| 11 | 不要注册 `onPluginOut` 去 kill ffmpeg | [architecture](doc/reference/architecture.md) |
| 12 | 队列并行 1–4、默认 2，不要放宽 | [features](doc/reference/features.md) |
| 13 | ffmpeg 选择要同时读「偏好」和「探测」 | [features](doc/reference/features.md) |
| 14 | 两条后端（系统 / 宿主）行为必须一致 | [architecture](doc/reference/architecture.md) |
| 15 | `args.js` 每个构造器必须以 output 结尾 | [ffmpeg](doc/reference/ffmpeg.md) |
| 16 | 封面与视频画面共用 Video 流（`attached_pic`） | [ffmpeg](doc/reference/ffmpeg.md) |
| 17 | 新增桥接接口一律过 `guard.assert*` | [security](doc/reference/security.md) |
| 18 | 新增 ffmpeg flag 必须登记白名单 | [security](doc/reference/security.md) |
| 19 | 删除 / 覆盖只认本次产出 | [security](doc/reference/security.md) |
| 20 | 绝对路径与用户输入不进同步库 | [config](doc/reference/config-and-storage.md) |
| 21 | 输出命名规则只在 `src/core/paths.js` | [ffmpeg](doc/reference/ffmpeg.md) |
| 21b | 扩展名数据只有 `shared/exts.json` 一份 | [ffmpeg](doc/reference/ffmpeg.md) |
| 22 | 页面不得拥有「写白名单」的接口 | [security](doc/reference/security.md) |
| 23 | 宿主 `onPluginEnter` 只能 preload 注册 | [security](doc/reference/security.md) |
| 24 | 配置只能走键表（`SYNC_SCHEMA` / `LOCAL_SCHEMA`） | [config](doc/reference/config-and-storage.md) |
| 25 | 探测缓存只加速「同路径同 mtime/size」 | [config](doc/reference/config-and-storage.md) |
| 26 | 批量 probe 必须走 `runPool`，`onOne` 每人恰好一次 | [architecture](doc/reference/architecture.md) |
| 27 | 写授权不等于可读（`grantWriteDir` / `assertReadDir`） | [security](doc/reference/security.md) |
| 28 | 本机配置版本（`LOCAL_VERSION`）与迁移边界 | [config](doc/reference/config-and-storage.md) |

## 4. 不要做

- ❌ 在 `features.js` 里直接拼 ffmpeg 参数
- ❌ 把 `utools.registerTool` 挪进组件生命周期
- ❌ 给渲染层暴露 `fs` / `path` / 进程对象
- ❌ 默认改成覆盖原文件、或默认输出到下载目录
- ❌ 为了「并行快一点」把队列改成并发
- ❌ 提交 `dist/`

## 5. 文档

| 文档 | 内容 |
|---|---|
| [architecture](doc/reference/architecture.md) | 数据流、模块职责、两条后端、生命周期 |
| [security](doc/reference/security.md) | 授权模型、guard API、参数白名单、审核红线 |
| [config-and-storage](doc/reference/config-and-storage.md) | 配置键表、同步/本机边界、迁移、探测缓存 |
| [features](doc/reference/features.md) | 加功能 / 加 MCP 工具、字段、并发布局 |
| [ui](doc/reference/ui.md) | 三栏骨架、主题、Select、层级、调试坑 |
| [ffmpeg](doc/reference/ffmpeg.md) | 宿主能力、不可逆参数、已知坑、命名规则 |
| [testing](doc/reference/testing.md) | 构建断言、check 脚本、验证阶梯 |
| [style](doc/reference/style.md) | 依赖、分层、注释与 JSDoc |
| [doc/README](doc/README.md) | 修复日志索引（改样式/主题前先翻） |
