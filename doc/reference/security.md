# 安全模型（审核红线）

插件被审核的标准是「**只允许操作经用户选择 / 拖入得到的路径**」。这份文档说明代码里怎么落地，以及哪些地方一改就会重现历史问题。

## 1. 授权只发生在用户手势里

页面**没有**任何写白名单的接口（`grantPaths` / `grantDir` 不在 `window.audioServices` 上，`scripts/check/api-surface.test.mjs` 会断言导出面与快照逐字相同）。

授权来源只有五处，全在 preload 内部：

| 来源 | 触发方式 | 授权范围 |
|---|---|---|
| `pathForFile(file)` | 拖入 / `<input type=file>` | 该文件可读 + 其父目录可写（「输出到源文件同级」的依据） |
| `chooseFiles()` | 系统文件选择框 | 同上，逐个文件 |
| `chooseDir()` | 选输出目录 | 目录**只写** |
| `getPath('desktop' \| 'downloads')` | 页面调用（仅这两个名字） | 目录**只写** |
| 宿主 `onPluginEnter` 的 files/over payload | 文件关联、拖到主输入框 | 同 `pathForFile` |

`getPath` 只接受 `desktop` / `downloads`；`home`、`documents`、`userData`、`appData`、`exe` 等名字一律返回空字符串，**不返回路径也不授权**。

## 2. guard 的读写是分开的

```js
readFiles   // 用户选中的单个文件
readDirs    // 用户选中的目录（可枚举、可读其中的文件）
writeDirs   // 只能往里写
produced    // 本次会话的产出
```

| API | 语义 |
|---|---|
| `grantPaths(paths)` | 文件：`readFiles` + 父目录 `writeDirs`；目录：`readDirs` + `writeDirs` |
| `grantDir(dir)` | 读 + 写。**只给用户手势选中的目录** |
| `grantWriteDir(dir)` | 只写。输出位置一律用它 |
| `noteProduced(file)` | 登记本次产出（必须在执行**前**调用，失败/取消时半成品才删得掉） |
| `assertReadFile` | `readFiles` / `produced` / 临时文件 / **父目录在 `readDirs`** |
| `assertReadDir` | `readDirs` / 临时文件。**不看 `writeDirs`** |
| `assertWriteDir` / `assertWriteTarget` | 只认 `writeDirs`；目标已存在时只放行 produced / 临时文件（即便 `overwrite=true`） |
| `assertDelete` | 只放行 `produced` 与插件临时目录 |
| `assertRename` | 源必须是 produced / 临时文件，目标走 `assertWriteTarget` 且不允许已存在 |
| `assertProbe` | 只探测 `writeDirs` 下的存在性（前端做 `(1)(2)` 重名检测） |
| `assertOpen` | 打开文件/文件夹：已授权读、已产出、临时文件、已授权的目录 |

**写授权不等于可读**：`assertReadDir` 一旦重新认 `writeDirs`，页面调一次 `getPath('desktop')` 就能 `listMedia` 递归枚举整个桌面（这是被审核点名的原始问题）。

## 3. 参数白名单

`preload/lib/argswhitelist.js` 默认拒绝一切未登记 flag。

- `-i`：拒绝协议前缀（`http:` / `file:` 等）、相对路径、`-` 开头；每个输入必须过 `assertReadFile`，最多 32 个
- `-af`：只认 `FILTERS` 里的 18 个滤镜，且字符集先挡 `/` `'` 等（防 `movie=` 读文件）
- `-lavfi`：只认频谱 / 波形两条整串模板
- `-filter_complex`：只认 `amix` 与 `concat` 两条整串模板
- `-f concat`：必须紧跟 `-safe 0 -i <插件临时目录里的 .txt>`，并逐条解析 `file '...'` 后各自 `assertReadFile`（上限 200 条）
- 路径型参数（`-attach` / `-passlogfile` / `-filter_complex_script` / `-dump_attachment`）**根本没有登记**，不要加
- 输出：必须是绝对路径，走 `assertWriteTarget`

加 flag 时：在 `buildSpec` 登记值规则，然后跑 `node scripts/check/features-args.test.mjs`（17 个功能的真实参数会全过一遍）。

## 4. 删除与覆盖

- 删除只认 `produced` 与插件临时目录（临时目录里也只删 `utools-audio-toolbox-` 前缀的文件）
- 覆盖只放宽到 `produced`，**不会**放宽到任意已存在文件
- `ffmpeg.run` 在 spawn 之前就 `noteProduced(output)`，异常/取消时半成品删得掉

## 5. preload 的能力面

- 不暴露 `fs` / `path` / `child_process` 裸对象，也不把进程对象交出去
- 不提供「读写任意路径 / 执行任意命令 / 请求任意 URL」的通用函数
- 新增接受路径的接口，必须调用 `assertReadFile / assertWriteDir / assertWriteTarget / assertDelete` 之一（`writeBase64`、`ensureDir`、`size` 就是按这条删掉的）
- 任何会被拼进进程 id 的字符串（`renderPreview` 的 `token`）先夹到 `^[A-Za-z0-9_-]{1,40}$`，否则 `cancelTask` 的 id 正则不认，任务就取消不掉
- 对外只开 `openExternal`（https + 6 个白名单主机）、`copyText`（只写不读）、`notify`

## 6. 宿主事件单槽

`utools.onPluginEnter` 是单槽赋值（后注册覆盖先注册）。监听权归 preload（`handlePluginEnter`），页面用 `audioServices.onEnterFiles(cb)` 订阅。不要在 `App.jsx` 里再调，否则把授权回调顶掉，表现为「文件关联进来列表是空的」。

## 7. 提交前自查

```bash
# 官方自检 skill 在 .agents/skills/utools-plugin-selfcheck/SKILL.md
# 按它的流程对 dist/ 静态检查：产物卫生、preload 明文性、能力面、网络/剪贴板、同步库、logo
```

历史被拒的三类问题（都已有回归断言）：

1. `getPath` 扩权到家目录 / 文档 / 图片 → 现在只允许 desktop、downloads，且只写
2. `setConfig({outputDir})` 给下个会话发写通行证 → `setConfigGuarded` 只放行本次已授权或与已存值一致
3. 任意文本写临时目录 + concat 列表未校验 → 改为 `makeConcatList(paths)`，列表条目逐条 `assertReadFile`
