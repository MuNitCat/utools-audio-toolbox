# FFmpeg 约定与已知坑

## 宿主能力矩阵

宿主 ffmpeg 7.1 自带：`libmp3lame`、`libopus`、`libvorbis`、`flac`、`alac`、`pcm_*`、内置 `aac`；**没有 `libfdk_aac`**。

滤镜侧可用：`loudnorm` `ebur128` `afftdn` `silenceremove` `silencedetect` `afade` `atempo` `volume` `alimiter` `showspectrumpic` `showwavespic`。

新增编码器 / 滤镜前，先在本机跑一遍真实命令再写进 `args.js`。

## 不可逆的参数事实

| 约束 | 原因 |
|---|---|
| 禁止 `aresample=...:resampler=soxr` | 宿主 `-h` 里列了 soxr，但执行必失败：`Requested resampling engine is unavailable` |
| FLAC 合并一律重编码 | `-f concat -c copy` 写 FLAC 时 STREAMINFO 只记第一段采样数，播放器会按分段时长截断（`features.js` 的 `copyUnsafe`） |
| loudnorm 第二遍必须显式 `-ar 48000` | `loudnorm` 内部升到 192kHz，不拉回来输出就变 192k |
| `.aac` 不能写标签 / 封面 | ADTS 裸流，`safeFormatFor()` 会映射到 `m4a` |
| 封面只在 `mp3 / m4a / alac / flac / ogg` 上写 | `-disposition:v:0 attached_pic`，wav / adts 会报错，`COVER_OK` 已过滤 |
| mp3 写标签必须带 `-id3v2_version 3` | 否则部分播放器不认 |
| `args.js` 每个构造器必须以 output 结尾 | `ffmpeg.js` 的 `withProgress()` 把 `-nostats -progress pipe:1` 插在倒数第一个参数之前；输出不在末尾会插到 `-i` 与输入路径之间 |

## 视频画面与内嵌封面共用 Video 流

ffprobe 与 `ffmpeg -i` 都把封面报成 video 流，唯一区分是 `disposition.attached_pic` / `(attached pic)`。`probe.js` 据此区分 `hasCover` 与 `hasVideo`——别再把任意 video 流当封面，否则视频文件会在「标签与封面」里多出一个「导出原封面」。

## 没有 ffprobe 时

时长 / 码率 / 采样率 / 标签只能解析 `ffmpeg -i` 的 stderr（`probe.js` 的 `parseProbe`）。日志可能走 `onLog`，也可能只在异常的 `message` 里，两处都要收。

## 已知坑

- `-i` 单输入必然非零退出，探测类调用按「拿到文本即成功」处理，不要用退出码判定
- `parseProbe` 靠缩进切 Metadata 块（条目固定 4 空格，`Duration:` 是 2 空格），用缩进切块才不会被污染
- flac 24bit 被报成 `s32`，真值在 `profile` 的 `"24 bit"` 里
- `.aac` 的时长是「estimating from bitrate」估算值，`durationEstimated` 为 true，进度会不精确
- `atempo` 单级听感上限按 2.0 处理（宿主实测能到 100，但大倍率出怪声），超出用 `atempoChain()` 串联
- concat 列表里的路径要做单引号转义 `'\''`，否则文件名含 `'` 直接炸
- 需要读 stderr 的命令（`silencedetect`、`loudnorm print_format=json`）在 `spawnSync` 里看 `result.stderr`，不是 stdout

## 临时文件

统一 `utools-audio-toolbox-` 前缀，放 `utools.getPluginTempPath()`；启动时 `cleanupTemp(24h)`，只清这个前缀。前缀在 `fsx.TEMP_PREFIX` 与 `guard.isTemp` 两处**各自硬编码**，改名必须同时改（或用 grep 全量替换后跑一遍 `guard.test.mjs`）。

## 输出命名

规则只在 `src/core/paths.js`（`resolveOutput()` / `numberedOutput()`）。preload 里没有副本，`preload/lib/exts.js` 只剩扩展名常量。

- 默认永不覆盖原文件：冲突时追加 ` (1) (2)`
- 未指定输出目录时落到源文件同级
- 扩展名数据只有 `shared/exts.json` 一份（preload 与前端同读）。这是 preload 里唯一引用包外相对路径的地方，**改目录结构必须同步 `scripts/build-plugin.mjs` 的拷贝与 `required` 断言**；`plugin.json` 的文件关联 `extensions` 由构建脚本断言等于 `audio + video`
