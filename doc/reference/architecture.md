# 架构与数据流

## 处理流水线

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
   src/core/queue.js  2 路并行、op 权重进度、取消/重试
              ▼
   window.audioServices（preload 暴露）
              ▼
   preload/lib/argswhitelist.js   逐 token 校验（flag 白名单 + 输入/输出路径必须已授权）
              ▼
   preload/lib/guard.js           会话级路径白名单（readFiles/readDirs/writeDirs/produced）
              ▼
   utools.runFFmpeg(args, { onProgress, onLog })
```

**参数只在 `args.js` 生成一次，`features.js` 只负责把「用户/Agent 的意图」翻译成 op 列表。** 任何在别处拼 `-af` / `-c:a` 的写法都是 bug。

## 探测支路（与执行队列无关）

拖入文件后的元信息读取走另一套调度：

```
ingest.addPaths → api.probeMany(list, onOne, {jobId})
  → preload/index.js  probeManyGuarded（分批 200、并发 3、jobId 可取消）
  → preload/lib/pool.js  runPool（滚动补槽）
  → preload/lib/probe.js  probe(file, {signal, procId})
        ├─ 有 ffprobe：execFile -print_format json → mapProbeJson
        └─ 没有：capture('-i') 解析 stderr → parseProbe
```

两套调度**不要合并**：队列关心 op 权重与产出，探测关心吞吐与取消。

## 模块职责

| 路径 | 职责 |
|---|---|
| `src/core/features.js` | 功能定义（字段、默认值、`build()` 产出 op） |
| `src/core/args.js` | 唯一的 ffmpeg 参数构造处；每个构造器以 output 结尾 |
| `src/core/queue.js` | 任务队列：并行 2、权重进度、取消/重试、产出清理 |
| `src/core/paths.js` | 输出路径与命名规则的唯一实现 |
| `src/core/store.js` | 轻量状态容器 + 主题解析 + `useStore` |
| `preload/index.js` | 桥接层：授权、配置、探测、二进制、系统调用 |
| `preload/lib/guard.js` | 路径白名单（授权状态全部在这） |
| `preload/lib/argswhitelist.js` | 参数逐 token 校验（默认拒绝） |
| `preload/lib/ffmpeg.js` | 进程管理：spawn / 宿主 runFFmpeg、进度、超时、取消 |
| `preload/lib/probe.js` | 元信息探测（ffprobe JSON / ffmpeg stderr） |
| `preload/lib/binaries.js` | 找 ffmpeg/ffprobe、校验、探测缓存 |
| `preload/lib/config.js` | 配置读写：同步库 + 本机文件、键表归正、迁移 |
| `preload/lib/fsx.js` | 文件操作：临时文件、concat 列表、目录枚举、封面 data URL |
| `preload/lib/pool.js` | 通用并发池 `runPool` |

## 两条后端

`binaries.js` 决定用**系统 ffmpeg**（`spawn` + `-progress pipe:1`）还是**宿主** `utools.runFFmpeg`；
`probe.js` 决定用 **ffprobe 的 JSON** 还是解析 **`ffmpeg -i` 的 stderr**。

加参数或加字段时两条路径都要能跑：`mapProbeJson()` 的输出结构必须与 `parseProbe()` 逐字段对齐。

## 生命周期

- preload **不热更新**：改 `preload/` 后必须完全退出插件重进；`src/` 有 HMR。
- ffmpeg 由宿主 spawn，插件窗口销毁带不走它；**不要注册 `onPluginOut` 去 kill**（用户要求关窗也让任务跑完）。
- 权限状态只活在进程内（`guard` 的 Map）；重启即清空，靠用户手势重新建立。
- 探测结论会落 `binaries.cache.json`（见 [config-and-storage.md](./config-and-storage.md)），其它状态都不落盘。
