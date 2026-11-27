# 验证

按代价从低到高。

## 1. 构建与断言

```bash
pnpm build   # vite build + scripts/build-plugin.mjs
```

构建脚本会断言：工具名与 `TOOL_DEFS` 一致、产物无 `development` 字段、无 ffmpeg/ffprobe 二进制、体积 <3MB、资源用相对路径、文件关联的 `extensions` 等于 `audio + video`。**失败时先读它打印的 `✗ 构建校验失败：...`**，不要绕过。

`dist/` 是产物目录，不要手改、也不要提交（`emptyOutDir` 会清空）。

## 2. `pnpm check`

不依赖测试框架，全是 `node scripts/check/*.test.mjs`：

| 脚本 | 覆盖 |
|---|---|
| `guard.test.mjs` | 路径白名单：越权、符号链接逃逸、只写目录不可枚举、删除/重命名边界 |
| `api-surface.test.mjs` | 导出面快照（新增接口必须显式登记）、无写白名单接口、文件关联授权、probe 契约 |
| `args.test.mjs` | ffmpeg 参数白名单：未登记 flag、滤镜、concat、输出路径 |
| `features-args.test.mjs` | 17 个功能的真实参数全过一遍白名单 |
| `paths.test.mjs` | 输出命名 golden（锁死用户看到的文件名） |
| `config.test.mjs` | 配置键表与 DEFAULTS 键集全等、类型/体积边界、迁移、同步/本机分流 |
| `pool.test.mjs` | `runPool` 并发上限、同序、取消、抛错停止派发 |
| `binaries.test.mjs` | 假 ffmpeg 不能冒充、版本门槛、探测缓存的安全边界 |
| `probe.test.mjs` | 批量探测并发、同序、`onOne` 调用次数、取消 |
| `ffmpeg-smoke.mjs` | 端到端冒烟（真 ffmpeg） |

## 3. 参数实证

最省事的方式是写临时 `.mjs`：

```js
import * as A from './src/core/args.js'
import { spawnSync } from 'node:child_process'
const r = spawnSync('/opt/homebrew/bin/ffmpeg', A.convert({ input, output, format: 'm4a' }))
```

跑完用 ffprobe 核对时长 / 编码 / 采样率。

## 4. 首屏冒烟（无浏览器时）

用 vite 的 `ssrLoadModule('/src/pages/MainPage.jsx')` + `renderToString`，断言关键 class 与文案存在（`<label>` 数量、`nav-item` 数量这类结构断言）。

## 5. 真机

uTools 开发者工具加载仓库根目录（开发模式）。

- `src/` 改动有 HMR
- **preload 改动不热更新**：必须完全退出插件重进；前端对新增 API 要做 `typeof api.xxx === 'function'` 能力检测 + 兜底

## 命令与环境

```bash
pnpm install
pnpm dev     # 5180（strictPort，host 固定 127.0.0.1）
pnpm build
pnpm check
```

包管理器固定 **pnpm**（`package.json` 的 `packageManager` + `pnpm-lock.yaml`），不要用 npm / yarn 安装——会生成第二份 lock 并把依赖装成平铺结构。`pnpm-workspace.yaml` 只放 pnpm 自身配置（`allowBuilds` 放行 esbuild），不是多包工作区。

改端口/地址要同时改 `vite.config.js` 和 `plugin.json` 的 `development.main`。
