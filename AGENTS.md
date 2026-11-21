# AGENTS.md

给在本仓库工作的 AI Agent / 人类协作者的工程约定。**先读完第 3 节的硬约束再动手**——那些规则每条都对应一个已经踩过的真实故障。

## 1. 这是什么

uTools 插件「音频批量处理」。React 18 + Vite 5，`preload` 是 CommonJS 桥接层，所有音视频处理走宿主提供的 `utools.runFFmpeg()`。插件打包后约 0.25MB，**不含任何二进制**。

```bash
pnpm install
pnpm dev               # 5180（strictPort）；换端口要同时改 vite.config.js 和 plugin.json 的 development.main
pnpm build             # vite build + scripts/build-plugin.mjs 校验 → dist/
```

包管理器固定 **pnpm**（`package.json` 的 `packageManager` + `pnpm-lock.yaml`），不要用 npm / yarn 安装——否则会生成第二份 lock 并把依赖装成平铺结构。`pnpm-workspace.yaml` 里放的是 pnpm 自身的配置（`allowBuilds` 放行 esbuild 的安装脚本），不是多包工作区。

`pnpm build` 有一组断言（工具名一致、无 development 字段、无 ffmpeg 二进制、<3MB、相对路径），**构建失败时先读它打印的 `✗ 构建校验失败：...`**，不要绕过。`dist/` 是产物目录，不要手改、也不要提交（已在 `.gitignore`）。

## 2. 数据流

```
UI (React)                     MCP (AI Agent)
   │                                │
   └──────────┬─────────────────────┘
              ▼
   src/core/features.js  build(inputs, params, infos) → [{ input, ops[] }]
              │                       ▲
              │                       └── src/core/mcp.js（schema + handler）
              ▼
   src/core/args.js   唯一的 ffmpeg 参数生成处
              ▼
   src/core/queue.js  串行执行、op 权重进度、取消/重试
              ▼
   window.audioServices（preload 暴露）
              ▼
   utools.runFFmpeg(args, { onProgress, onLog })
```

一句话：**参数只在 `args.js` 生成一次，`features.js` 只负责把「用户/Agent 的意图」翻译成 op 列表**。任何在别处拼 `-af` / `-c:a` 的写法都是 bug。

## 3. 硬约束（每条都有代价）

| # | 约束 | 原因 / 位置 |
|---|---|---|
| 1 | **产物里不要带 ffmpeg / ffprobe** | 带二进制会引入跨平台分包、chmod、签名、体积上限四类问题。运行时优先用**系统已安装的**（见下条），不是自带。构建脚本会拒绝产物中出现这两个文件 |
| 2 | **禁止 `aresample=...:resampler=soxr`** | 宿主 ffmpeg 7.1 的 `-h` 里列了 soxr 但实际执行必失败：`Requested resampling engine is unavailable` |
| 3 | **FLAC 合并一律重编码** | `-f concat -c copy` 写 FLAC 时 STREAMINFO 的总采样数只记第一段，播放器会按分段时长截断。见 `features.js` 的 `copyUnsafe` |
| 4 | **loudnorm 第二遍必须显式 `-ar 48000`** | `loudnorm` 内部升到 192kHz，不拉回来输出就变成 192k |
| 5 | **没有 ffprobe** | 时长/码率/采样率/标签只能解析 `ffmpeg -i` 的 stderr，见 `preload/lib/probe.js`。日志可能走 `onLog`，也可能只在异常 `message`，两处都要收 |
| 6 | **工具名单一来源** | `src/core/tool-names.js` 是唯一清单；`plugin.json.tools` 与 `registerTool()` 必须逐字一致，构建脚本断言 |
| 7 | **`registerTool` 必须在模块加载时执行** | MCP 调用会在插件未打开时静默拉起插件，只等注册完成。放进 `useEffect` / 组件挂载里会导致工具调不通。入口是 `src/core/register.js`，由 `src/main.jsx` 在 App 之前顶层 import |
| 8 | **preload 不暴露 fs / path / child_process 裸对象** | 渲染层通过 `window.audioServices` 的编排级方法操作；`preload/lib/ffmpeg.js` 也不把进程对象交出去 |
| 9 | **默认永不覆盖原文件** | 冲突时 `resolveOutput()` 追加 ` (1) (2)`；覆盖必须显式 `overwrite: true` |
| 10 | **未指定输出目录时落到源文件同级** | `preload/lib/paths.js` 的 `resolveOutput()`；这是产品决策，别改成下载目录 |
| 11 | **不要注册 `onPluginOut` 去 kill ffmpeg** | ffmpeg 由宿主 spawn，插件窗口销毁带不走它；用户明确要求关掉窗口就让任务跑完 |
| 12 | **队列串行** | 每个 `runFFmpeg` 默认 `-threads 0` 吃满核心，并行只会互相拖慢并卡死系统。仅供「CPU 占用」下调 `-threads` |
| 13 | **ffmpeg 选择要同时读「偏好」和「探测」** | `binaries.preference()` 返回 `{mode, path}`：`auto` 走探测、`custom` 用指定路径、`host` 强制内置。`setPreference()` 除了写 config，还维护一份进程内 `override`（config 写失败也不至于静默不生效）。自定义路径失效时必须回退到自动探测，并通过 `summary().customInvalid` 告诉界面 |
| 14 | **两条后端必须行为一致** | `preload/lib/binaries.js` 决定用系统 ffmpeg（`spawn` + `-progress pipe:1`）还是宿主 `utools.runFFmpeg`；`probe.js` 决定用 ffprobe 的 JSON 还是 stderr 解析。**加参数/加字段时两条路径都要能跑**，`mapProbeJson()` 的输出结构必须与 `parseProbe()` 逐字段对齐 |
| 15 | **`args.js` 的每个构造器都必须以 output 结尾** | `ffmpeg.js` 的 `withProgress()` 把 `-nostats -progress pipe:1` 插在**倒数第一个参数**之前。若输出不在末尾，参数会被插错位置（最典型的错误是插到 `-i` 与输入路径之间） |
| 16 | **视频画面与内嵌封面共用 Video 流** | ffprobe 与 `ffmpeg -i` 都把封面报成 video 流，唯一的区分是 `disposition.attached_pic` / `(attached pic)`。`probe.js` 据此区分 `hasCover` 与 `hasVideo`：**别再把任意 video 流当封面**，否则视频文件会在「标签与封面」里多出一个「导出原封面」 |

其他不可逆的细节：

- `.aac` 是 ADTS 裸流，**不能写标签/封面**；`safeFormatFor()` 会把它映射到 `m4a`。
- 封面只在 `mp3 / m4a / alac / flac / ogg` 上用 `-disposition:v:0 attached_pic`；wav/adts 会报错，`features.js` 的 `COVER_OK` 已过滤。
- mp3 写标签必须带 `-id3v2_version 3`，否则部分播放器不认。
- 删除的是「半成品输出」时才安全：`queue.js` 只在自身创建的新文件上 `removeFile`。

## 4. 改代码的套路

### 加一个功能（GUI + 可选 MCP）

1. `src/core/features.js` 的 `FEATURES` 里加对象：`{ id, group, name, desc, tool?, fields[], build() }`
2. `build` 返回 `[{ input, ops: [{ type:'ffmpeg', args, output, weight, label }] }]`
3. `args.js` 里加参数构造函数（**不要**在 features 里拼 args）
4. 需要 MCP：在 `tool-names.js` 加名字 → `mcp.js` 的 `TOOL_DEFS` 加 schema、`handlers` 加实现 → `plugin.json.tools` 同步（构建脚本会校验一致性）
5. 需要图标：`components/Icon.jsx` 加一条 path，并在 `FEATURE_ICON` 里映射

op 支持的字段：`weight`（进度权重，两遍法 0.25/0.75）、`capture`（要读 stderr）、`parse`（`loudnorm` / `silence`）、`dynamic: 'splitSegments'`（先探测再动态展开 op）、`rebuild(measured)`（把测量值注入第二遍）。

### 改 UI

- 三栏骨架在 `pages/MainPage.jsx`：`.sidebar`（内含 `.sidebar-nav` + `.sidebar-foot`）/ `.panel` / `.stage` + `.footer`。**`featureId === 'visualize'` 是例外**：整块换成 `panels/Viewer.jsx`，不渲染参数栏与底部工具栏
- 频谱/波形有两条路径，别混：
  - **即时预览**（`preload/lib/previewer.js` + `core/previewer.js`）：取中间 60 秒渲染到临时目录，读完即删，只塞 `store.preview`，**不产出文件**
  - **完整图**（`features.visualize` → 队列）：产出 PNG 到输出目录，完成后 `queue.js` 把图读成 data URL 也写进 `store.preview`（`source: 'full'`）
- 主题三档在 `store.js` 的 `applyTheme()`：**用 `matchMedia` 把 `auto` 解析成 `light`/`dark`**，再写到 `<html data-theme>`；CSS 只认 `:root` 与 `:root[data-theme='dark']` 两套变量。监听 `prefers-color-scheme` 变化，但只在 auto 模式下重算
- ⚠️ **不要用 `light-dark()`**：uTools 的渲染进程不支持，变量会变成无效值 → `background`/`border` 整条声明失效，界面直接变全透明（踩过，线上就是这个症状）。新颜色一律加进 `:root` 和 `:root[data-theme='dark']` 两块
- **新增 preload API 时，前端必须做能力检测 + 兜底**：`preload` 不热更新，开发中很容易出现「界面是新代码、preload 是旧的」，`typeof api.xxx === 'function'` 判断为假时要么降级要么明确提示「需要完全退出插件重进」，不能静默失败（FFmpeg 弹窗曾因此一直显示「尚未扫描」）
- 层级约定：`.tip-host::after` 400 > `.toast` 300 > `.modal-mask` 100。新增浮层时按这个排，别再用 90 之类的中间值——之前的 bug 就是 `toast` 的 90 低于蒙版 100，弹窗里点「复制」看不到提示
- 控件表面色用 `--surface`（浅色白、深色比背景亮一档），别用 `--bg`——深色下 `--bg` 和面板同色，按钮就看不出边界了
- 频谱/波形图在任务完成后由 `queue.js` 用 `audioServices.coverDataUrl()` 读成 **data URL** 塞进 `store.preview`，**只有 `Viewer.jsx` 渲染它**（`store.preview` 会跨功能保留，别在 `Stage` 或别处再读，否则切到别的功能时文件列表上方会莫名多出一张图）。**不要直接 `<img src="file://...">`**：开发模式页面是 `http://localhost:5180`，引用 `file://` 会被 Chromium 拦掉（生产走 `file://` 虽然能用，但两边行为不一致）
- 参数渲染是配置驱动的，`panels/Params.jsx` 的 `kindOf()` 决定用分段控件、卡片网格还是下拉；想强制某种样式就给字段加 `ui: 'segment' | 'grid'`
- 样式全在 `styles/global.css`，深浅色靠 `prefers-color-scheme` 下的 CSS 变量，**不要写死颜色**，一律用 `var(--...)`

### 加 FFmpeg 能力前先确认宿主支持

宿主 ffmpeg 7.1 有 `libmp3lame` / `libopus` / `libvorbis` / `flac` / `alac` / `pcm_*` / 内置 `aac`，**没有** `libfdk_aac`。滤镜侧 `loudnorm` `ebur128` `afftdn` `silenceremove` `silencedetect` `afade` `atempo` `volume` `alimiter` `showspectrumpic` `showwavespic` 都在。新增编码器/滤镜时先在本机跑一遍真实命令再写进 `args.js`。

## 5. 验证

改动样式/主题相关代码前，先翻 `doc/`：里面记着宿主渲染进程与浏览器的行为差异（例如不支持 `light-dark()`），踩过的不要再踩。

按代价从低到高：

1. **构建校验**：`pnpm build`（工具名、schema、体积、二进制）
2. **参数实证**：把 `args.js` 生成的数组丢给真实 ffmpeg 跑。最省事的方式是写个临时 `.mjs`，`import * as A from './src/core/args.js'`，用 `spawnSync('/opt/homebrew/bin/ffmpeg', A.convert({...}))`，再用 `ffprobe` 核对时长/编码/采样率
3. **首屏冒烟**（无浏览器时可用）：用 `vite` 的 `ssrLoadModule('/src/pages/MainPage.jsx')` + `renderToString`，断言关键 class 和文案存在。注意 `<label>` 数量、`nav-item` 数量这类结构断言
4. **真机**：uTools 开发者工具加载仓库根目录（开发模式）。**preload 改动不热更新**，必须完全退出插件重进；`src/` 下的改动有 HMR

需要读 stderr 的命令（`silencedetect`、`loudnorm print_format=json`）在 `spawnSync` 里要看 `result.stderr`，不是 stdout——踩过这个坑。

## 6. 已知坑

- `-i` 单输入必然非零退出，探测类调用要按「拿到文本即成功」处理，不要以退出码判定
- `parseProbe` 靠缩进判断 Metadata 块（条目固定 4 空格，`Duration:` 是 2 空格，用缩进切块才不会被污染）
- flac 24bit 被 ffmpeg 报成 `s32`，真值在 `profile` 的 `"24 bit"` 里
- `.aac` 的时长是「estimating from bitrate」估算值，`durationEstimated` 会是 true，进度会不精确
- `atempo` 单级听感上限按 2.0 处理（宿主实测可到 100，但大倍率会出怪声），超出用 `atempoChain()` 串联
- concat 列表文件里的路径要做单引号转义 `'\''`，否则文件名含 `'` 直接炸
- 临时文件统一 `audio-batch-` 前缀，放 `utools.getPluginTempPath()`，启动时 `cleanupTemp(24h)`

## 7. 风格

- 不引 UI 库、不引状态库、不引图标库。现有依赖只有 `react` / `react-dom`（devDeps 是 vite 和 react 插件）
- 注释写「为什么」，不写「是什么」；涉及宿主怪癖的地方必须注明现象（例如上面第 3 节的条目）
- 时间/体积格式化、stderr 解析等纯逻辑放 `src/core/format.js`，保持可单测、不依赖 `window`
- 面向用户的文案用中文；代码标识符用英文

## 8. 不要做

- ❌ 在 `features.js` 里直接拼 ffmpeg 参数
- ❌ 把 `utools.registerTool` 挪进组件生命周期
- ❌ 给渲染层暴露 `fs` / `path` / 进程对象
- ❌ 默认改成覆盖原文件、或默认输出到下载目录
- ❌ 为了「并行快一点」把队列改成并发
- ❌ 提交 `dist/`（它是产物，构建时 `emptyOutDir` 会清空）
