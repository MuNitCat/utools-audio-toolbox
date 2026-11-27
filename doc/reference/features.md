# 加功能 / 加工具

## 加一个功能（GUI + 可选 MCP）

1. `src/core/features.js` 的 `FEATURES` 里加对象：`{ id, group, name, desc, tool?, fields[], build() }`
2. `build` 返回 `[{ input, ops: [{ type:'ffmpeg', args, output, weight, label }] }]`
3. `args.js` 里加参数构造函数（**不要**在 features 里拼 args）
4. 需要 MCP：`tool-names.js` 加名字 → `tool-schemas.js` 的 `TOOL_DEFS` 加 schema → `mcp.js` 的 `handlers` 加实现。`dist/plugin.json` 的 `tools` 由构建脚本从 `TOOL_DEFS` 生成，不用手改，也不要改根 `plugin.json`
5. 需要图标：`components/Icon.jsx` 加一条 path，并在 `FEATURE_ICON` 里映射

### op 字段

| 字段 | 含义 |
|---|---|
| `weight` | 进度权重（两遍法 0.25 / 0.75） |
| `capture` | 需要读 stderr |
| `parse` | `loudnorm` / `silence` 的解析器 |
| `dynamic: 'splitSegments'` | 先探测再动态展开 op |
| `rebuild(measured)` | 把测量值注入第二遍 |

## 工具名单一来源

- 名字清单只有 `src/core/tool-names.js`
- schema 只有 `src/core/tool-schemas.js` 的 `TOOL_DEFS`
- handler 只有 `src/core/mcp.js`
- `dist/plugin.json` 的 `tools` 由 `scripts/build-plugin.mjs` 生成；根 `plugin.json` 写了 `tools` 会直接构建失败

## `registerTool` 必须在模块加载时执行

MCP 调用会在插件未打开时静默拉起插件，只等注册完成。放进 `useEffect` / 组件挂载里会导致工具调不通。入口是 `src/core/register.js`，由 `src/main.jsx` 在 App 之前顶层 import。

## 字段与界面

- 参数渲染是配置驱动的：`panels/Params.jsx` 的 `kindOf()` 决定分段控件 / 卡片网格 / 下拉；强制样式加 `ui: 'segment' | 'grid'`
- `field.hint` 可以是函数，**签名固定 `(params, ctx)`**（`ctx.files` 是已载入文件，带 probe 的 info）；`switch` 字段同样支持 `hint`
- `field.optionDisabled(option, params, ctx)` 可选项级禁用（`select` 专属）：`Params.jsx` 把结果摊平成 `option.disabled`，三个控件（segment / 卡片网格 / 下拉）都认；禁用文案放 `option.disabledTitle`。当前值落在被禁用项上时，Params 会自动拨回 `field.default`（不可用则第一个可用项）——**判定逻辑写在功能定义里，控件层只认布尔值**
- 用到「按已载入文件算状态」的禁用要判 `probing`：探测是逐个出结果的，中途的「都是单音轨」只是临时状态（见 `extract` 的 `singleTrackOnly`）
- 下拉一律用 `components/Select.jsx`，禁止原生 `<select>`；它的 `options[].disabled` 会跳过键盘 ↑↓/Home/End 高亮，`commit` 也拒绝禁用项

## 队列与并发

- 并行数 1–4、默认 2，由「应用设置 → 任务并行数」写配置 `concurrency`，`setConcurrency()` 内部夹取
- 别放宽上限：每个 `runFFmpeg` 默认 `-threads 0` 吃满核心，再多会互相拖慢并卡死系统
- `args.js` 的 `threads()` 仍支持传值，但界面已经没有入口，别加回来
- 不要为了「并行快一点」改队列语义

## ffmpeg 二进制的选择

`binaries.preference()` 返回 `{mode, path}`：

- `auto` 走探测
- `custom` 用指定的 `ffmpegPath`
- `host` 强制用 uTools 内置

`setPreference()` 必须先 `await validatePath()` 通过才写本机配置，并刷新进程内 `prefCache`；自定义路径失效时回退到自动探测，并通过 `summary().customInvalid` 告诉界面。

## 侧栏显示哪些功能

`hiddenFeatures`（id 数组）决定侧栏显示：`MainPage` 传给 `Sidebar`，`panels/OutputModal.jsx` 负责勾选。只影响显示——`getFeature(id)`、MCP 工具、队列都不看它，所以隐藏的功能仍能被 Agent 调用。

- `PINNED_FEATURE_IDS`：常驻，不列进勾选列表，读取配置时也要过滤掉
- `DEFAULT_HIDDEN_FEATURES`：首屏默认收起（目前 `visualize`），改默认值要连 `preload/lib/config.js` 的 `DEFAULTS.hiddenFeatures` 一起改
- 隐藏当前功能时要自动跳到第一个仍可见的项，否则参数面板会停在一个侧栏里找不到的功能上
