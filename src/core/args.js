/**
 * ffmpeg 参数层：所有命令的唯一真相。
 * 纯函数，不依赖 React、不依赖 utools，可单独单测（断言 args 数组即可）。
 */

const BASE = ['-hide_banner', '-nostdin', '-y']

const threads = (n) => (Number(n) > 0 ? ['-threads', String(Math.round(Number(n)))] : [])

/** 只取第一条音频流，丢掉原有 video/封面流，避免转码时把旧封面带出去 */
const AUDIO_MAP = ['-map', '0:a:0', '-vn']

export const CONTAINERS = {
  mp3: { ext: 'mp3', encoder: 'libmp3lame', lossy: true, bitrate: true, quality: true },
  m4a: { ext: 'm4a', encoder: 'aac', muxer: 'ipod', lossy: true, bitrate: true, quality: false },
  aac: { ext: 'aac', encoder: 'aac', muxer: 'adts', lossy: true, bitrate: true, quality: false },
  flac: { ext: 'flac', encoder: 'flac', lossy: false, bitrate: false, quality: true },
  wav: { ext: 'wav', encoder: 'pcm_s24le', lossy: false, bitrate: false, quality: false },
  ogg: { ext: 'ogg', encoder: 'libvorbis', lossy: true, bitrate: true, quality: true },
  opus: { ext: 'opus', encoder: 'libopus', lossy: true, bitrate: true, quality: false },
  alac: { ext: 'm4a', encoder: 'alac', muxer: 'ipod', lossy: false, bitrate: false, quality: false }
}

export const FORMAT_KEYS = Object.keys(CONTAINERS)

/**
 * 输出扩展名：alac 用 m4a 容器，其余与格式名一致。
 * @param {string} format CONTAINERS 的键
 * @returns {string} 不带点的扩展名；未知格式回退 m4a
 */
export function outputExtOf(format) {
  const c = CONTAINERS[format]
  return c ? c.ext : 'm4a'
}

/**
 * 编码参数：码率 / 质量 / muxer / 容器补充项。
 * @param {string} format CONTAINERS 的键
 * @param {{bitrate?: number, quality?: string|number, compression?: number, sampleRate?: number, channels?: number}} [opts]
 * @returns {string[]} 可直接展开进 ffmpeg 参数数组的片段
 * @throws {Error} format 不在 CONTAINERS 里时抛出
 */
export function codecArgs(format, opts = {}) {
  const c = CONTAINERS[format]
  if (!c) throw new Error(`不支持的输出格式：${format}`)
  const args = ['-c:a', c.encoder]

  // 选了 MP3 的 V 档就是 VBR 模式，此时不能再给 -b:a（两个同时出现会变成 ABR）
  const vbr = format === 'mp3' && opts.quality !== undefined && opts.quality !== '' && opts.quality !== null
  if (c.lossy && opts.bitrate && !vbr) args.push('-b:a', `${Math.round(Number(opts.bitrate))}k`)
  if (vbr) args.push('-q:a', String(opts.quality))
  if (format === 'flac' && opts.compression !== undefined && opts.compression !== '') {
    args.push('-compression_level', String(opts.compression))
  }
  if (opts.sampleRate) args.push('-ar', String(Math.round(Number(opts.sampleRate))))
  if (opts.channels) args.push('-ac', String(Math.round(Number(opts.channels))))
  if (c.muxer) args.push('-f', c.muxer)
  if (c.muxer === 'ipod') args.push('-movflags', '+faststart')
  if (format === 'mp3') args.push('-id3v2_version', '3')
  return args
}

/**
 * 无编码器声明的纯容器拷贝（同编码直转）。
 * 注意 -ar / -ac 与 -c:a copy 同时出现时由 ffmpeg 决定是否重编码，别指望这里兜底。
 * @param {string} format CONTAINERS 的键
 * @param {{sampleRate?: number, channels?: number}} [opts]
 * @returns {string[]} 参数片段
 */
function copyArgs(format, opts = {}) {
  const c = CONTAINERS[format]
  const args = ['-c:a', 'copy']
  if (c && c.muxer) args.push('-f', c.muxer)
  if (opts.sampleRate) args.push('-ar', String(Math.round(Number(opts.sampleRate))))
  if (opts.channels) args.push('-ac', String(Math.round(Number(opts.channels))))
  return args
}

/**
 * 把标签对象摊成 -metadata k=v。
 * @param {Record<string, string|number>} [tags] 空值（undefined/null/''）会被跳过
 * @returns {string[]} 参数片段
 */
export function metaArgs(tags = {}) {
  const args = []
  for (const [key, value] of Object.entries(tags)) {
    if (value === undefined || value === null || value === '') continue
    args.push('-metadata', `${key}=${value}`)
  }
  return args
}

/* -------------------------------- 转码 -------------------------------- */

/**
 * 转码 / 压缩 / 重采样共用的一条命令。
 * @param {object} opts 见下
 * @param {string} opts.input 输入文件
 * @param {string} opts.output 输出文件（必须放最后，withProgress 会依赖这个位置）
 * @param {string} opts.format 目标格式
 * @param {number} [opts.bitrate] 有损码率 kbps
 * @param {string|number} [opts.quality] MP3 VBR 质量
 * @param {number} [opts.compression] FLAC 压缩等级
 * @param {number} [opts.sampleRate] 目标采样率
 * @param {number} [opts.channels] 目标声道数
 * @param {boolean} [opts.copy] 同编码直转
 * @param {number} [opts.threadCount] > 0 时才显式传 -threads
 * @returns {string[]} 参数数组
 * @throws {Error} format 不在 CONTAINERS 里时抛出
 */
export function convert({ input, output, format, bitrate, quality, compression, sampleRate, channels, copy = false, threadCount = 0 }) {
  const args = [...BASE, '-i', input, ...AUDIO_MAP]
  args.push(...(copy ? copyArgs(format, { sampleRate, channels }) : codecArgs(format, { bitrate, quality, compression, sampleRate, channels })))
  args.push(...threads(threadCount), output)
  return args
}

/**
 * 从视频容器里取出音轨：丢掉画面/字幕/数据流。
 * track 指定第几条（0 基）；mix=true 时把全部音轨用 amix 混合成一条，
 * 这种情况只能重编码（copy 会被忽略），最后挂 alimiter 防止叠加削波。
 * @param {object} opts 见下
 * @param {string} opts.input 视频文件
 * @param {string} opts.output 音频输出文件
 * @param {string} opts.format 目标音频格式
 * @param {number} [opts.bitrate] 有损码率
 * @param {string|number} [opts.quality] MP3 VBR 质量
 * @param {number} [opts.sampleRate] 目标采样率
 * @param {number} [opts.channels] 目标声道数
 * @param {boolean} [opts.copy] 直接复制音轨（仅单轨模式生效）
 * @param {number} [opts.track] 取第几条音轨，0 基
 * @param {boolean} [opts.mix] 是否混合全部音轨
 * @param {number} [opts.trackCount] 音轨总数（mix 时决定 amix 的输入个数）
 * @param {number} [opts.threadCount] 线程数
 * @returns {string[]} 参数数组
 */
export function extractAudio({
  input,
  output,
  format,
  bitrate,
  quality,
  sampleRate,
  channels,
  copy = false,
  track = 0,
  mix = false,
  trackCount = 1,
  threadCount = 0
}) {
  const args = [...BASE, '-i', input]
  const mixing = Boolean(mix) && Number(trackCount) > 1

  if (mixing) {
    const n = Math.max(2, Math.round(Number(trackCount)))
    const ins = Array.from({ length: n }, (_, i) => `[0:a:${i}]`).join('')
    args.push(
      '-filter_complex',
      `${ins}amix=inputs=${n}:duration=longest:normalize=0,alimiter=limit=0.98:level=false[a]`,
      '-map',
      '[a]',
      '-sn',
      '-dn'
    )
    args.push(...codecArgs(format, { bitrate, quality, sampleRate, channels }))
  } else {
    args.push('-map', `0:a:${Math.max(0, Math.round(Number(track) || 0))}`, '-vn', '-sn', '-dn')
    args.push(...(copy ? copyArgs(format, { sampleRate, channels }) : codecArgs(format, { bitrate, quality, sampleRate, channels })))
  }

  args.push(...threads(threadCount), output)
  return args
}

/**
 * 时间裁剪。copy 模式只能落在关键帧上，切点会有几百毫秒误差。
 * @param {object} opts 见下
 * @param {string} opts.input 输入文件
 * @param {string} opts.output 输出文件
 * @param {number} [opts.start] 起点秒数
 * @param {number} [opts.duration] 时长；为 0 时用 end - start
 * @param {number} [opts.end] 终点秒数
 * @param {number} [opts.fadeIn] 淡入秒数
 * @param {number} [opts.fadeOut] 淡出秒数
 * @param {string} opts.format 目标格式
 * @param {number} [opts.bitrate] 有损码率
 * @param {boolean} [opts.copy] 流复制（快但切点不精确）
 * @param {number} [opts.threadCount] 线程数
 * @returns {string[]} 参数数组
 */
export function clip({ input, output, start = 0, duration = 0, end = 0, fadeIn = 0, fadeOut = 0, format, bitrate, copy = false, threadCount = 0 }) {
  const args = [...BASE]
  if (copy) {
    args.push('-ss', String(Number(start) || 0), '-i', input)
    if (duration > 0) args.push('-t', String(Number(duration)))
    else if (end > 0) args.push('-to', String(Number(end)))
    args.push(...AUDIO_MAP, ...copyArgs(format), ...threads(threadCount), output)
    return args
  }

  const len = Number(duration) > 0 ? Number(duration) : Math.max(0, Number(end) - Number(start))
  const filters = []
  if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${Number(fadeIn)}`)
  if (fadeOut > 0 && len > 0) {
    const st = Math.max(0, len - Number(fadeOut))
    filters.push(`afade=t=out:st=${st.toFixed(3)}:d=${Number(fadeOut)}`)
  }

  // -ss 放 -i 前是快速 seek（对重编码也够准），保留精确性时用 -ss 后置
  args.push('-ss', String(Number(start) || 0), '-i', input)
  if (len > 0) args.push('-t', String(len))
  args.push(...AUDIO_MAP)
  if (filters.length) args.push('-af', filters.join(','))
  args.push(...codecArgs(format, { bitrate }), ...threads(threadCount), output)
  return args
}

/**
 * 合并（流复制）：最快，但要求各段编码参数完全一致。
 * @param {object} opts 见下
 * @param {string} opts.listFile concat 列表文件路径
 * @param {string} opts.output 输出文件
 * @param {string} opts.format 目标格式
 * @param {number} [opts.threadCount] 线程数
 * @returns {string[]} 参数数组
 */
export function mergeCopy({ listFile, output, format, threadCount = 0 }) {
  const c = CONTAINERS[format]
  const args = [...BASE, '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy']
  if (c && c.muxer) args.push('-f', c.muxer)
  args.push(...threads(threadCount), output)
  return args
}

/**
 * 合并（重编码）：先把每路统一到同一采样率/声道布局，再用 concat 拼。
 * @param {object} opts 见下
 * @param {string[]} opts.inputs 输入文件（按目标顺序）
 * @param {string} opts.output 输出文件
 * @param {string} opts.format 目标格式
 * @param {number} [opts.bitrate] 有损码率
 * @param {number} [opts.sampleRate] 统一采样率，默认 48000
 * @param {number} [opts.channels] 统一声道数，默认 2
 * @param {number} [opts.threadCount] 线程数
 * @returns {string[]} 参数数组
 */
export function mergeReencode({ inputs, output, format, bitrate, sampleRate = 48000, channels = 2, threadCount = 0 }) {
  const args = [...BASE]
  for (const file of inputs) args.push('-i', file)

  const chains = inputs.map(
    (_, i) => `[${i}:a:0]aresample=${sampleRate},aformat=sample_fmts=fltp:sample_rates=${sampleRate}:channel_layouts=${channels === 1 ? 'mono' : 'stereo'}[a${i}]`
  )
  const refs = inputs.map((_, i) => `[a${i}]`).join('')
  const graph = `${chains.join(';')};${refs}concat=n=${inputs.length}:v=0:a=1[out]`

  args.push('-filter_complex', graph, '-map', '[out]')
  args.push(...codecArgs(format, { bitrate, sampleRate, channels }), ...threads(threadCount), output)
  return args
}

/**
 * atempo 单级只到 2.0 听感才稳，超出用串联（2.0 × 剩余倍率）。
 * 宿主实测能跑更大倍率，但会出怪声，所以这里主动拆。
 * @param {number} speed 目标倍率，1 表示不变
 * @returns {string[]} 滤镜片段；接近 1 时返回空数组
 */
export function atempoChain(speed) {
  const target = Number(speed)
  if (!target || Math.abs(target - 1) < 0.001) return []
  const chain = []
  let rest = target
  while (rest > 2) {
    chain.push('atempo=2.0')
    rest /= 2
  }
  while (rest < 0.5) {
    chain.push('atempo=0.5')
    rest /= 0.5
  }
  chain.push(`atempo=${rest.toFixed(4)}`)
  return chain
}

/**
 * 变速 / 增益 / 淡入淡出合成一条滤镜链，只重编码一次。
 * 增益超过 +6dB 自动挂 alimiter，否则很容易削波。
 * @param {object} opts 见下
 * @param {string} opts.input 输入文件
 * @param {string} opts.output 输出文件
 * @param {number} [opts.speed] 速度倍率
 * @param {number} [opts.gainDb] 增益 dB
 * @param {number} [opts.fadeIn] 淡入秒数
 * @param {number} [opts.fadeOut] 淡出秒数
 * @param {number} [opts.duration] 原文件时长，用于把淡出锚在变速后的结尾
 * @param {string} opts.format 目标格式
 * @param {number} [opts.bitrate] 有损码率
 * @param {number} [opts.threadCount] 线程数
 * @returns {string[]} 参数数组
 */
export function edit({ input, output, speed = 1, gainDb = 0, fadeIn = 0, fadeOut = 0, duration = 0, format, bitrate, threadCount = 0 }) {
  const filters = []
  filters.push(...atempoChain(speed))
  if (Number(gainDb) !== 0) filters.push(`volume=${Number(gainDb)}dB`)
  if (Number(gainDb) > 6) filters.push('alimiter=limit=0.98')
  if (fadeIn > 0) filters.push(`afade=t=in:st=0:d=${Number(fadeIn)}`)
  if (fadeOut > 0 && duration > 0) {
    const effective = duration / (Number(speed) || 1)
    const st = Math.max(0, effective - Number(fadeOut))
    filters.push(`afade=t=out:st=${st.toFixed(3)}:d=${Number(fadeOut)}`)
  }

  const args = [...BASE, '-i', input, ...AUDIO_MAP]
  if (filters.length) args.push('-af', filters.join(','))
  args.push(...codecArgs(format, { bitrate }), ...threads(threadCount), output)
  return args
}

/* ------------------------------ 音频工程 ------------------------------ */

/**
 * 第一遍：只测量不产出文件（-f null），stderr 里带 loudnorm 的 JSON。
 * @param {object} opts 见下
 * @param {string} opts.input 输入文件
 * @param {number} [opts.targetLufs] 目标响度
 * @param {number} [opts.truePeak] 真峰值
 * @param {number} [opts.lra] 响度范围
 * @returns {string[]} 参数数组
 */
export function loudnormAnalyze({ input, targetLufs = -18, truePeak = -3, lra = 11 }) {
  const filter = `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=${lra}:print_format=json`
  return [...BASE, '-i', input, '-af', filter, '-f', 'null', '-']
}

/**
 * 第二遍：套用测量值做线性标准化；measured 为空时退化成单遍动态模式。
 * loudnorm 内部会升到 192kHz，必须显式 -ar 48000 拉回来。
 * @param {object} opts 见下
 * @param {string} opts.input 输入文件
 * @param {string} opts.output 输出文件
 * @param {number} [opts.targetLufs] 目标响度
 * @param {number} [opts.truePeak] 真峰值
 * @param {number} [opts.lra] 响度范围
 * @param {object} [opts.measured] 第一遍的测量结果（parseLoudnorm 的输出）
 * @param {string} opts.format 目标格式
 * @param {number} [opts.bitrate] 有损码率
 * @param {number} [opts.threadCount] 线程数
 * @returns {string[]} 参数数组
 */
export function loudnormApply({ input, output, targetLufs = -18, truePeak = -3, lra = 11, measured = {}, format, bitrate, threadCount = 0 }) {
  const parts = [`I=${targetLufs}`, `TP=${truePeak}`, `LRA=${lra}`]
  if (measured && measured.input_i !== undefined) {
    parts.push(
      `measured_I=${measured.input_i}`,
      `measured_TP=${measured.input_tp}`,
      `measured_LRA=${measured.input_lra}`,
      `measured_thresh=${measured.input_thresh}`,
      `offset=${measured.target_offset}`,
      'linear=true'
    )
  }
  parts.push('print_format=summary')
  const args = [...BASE, '-i', input, ...AUDIO_MAP, '-af', `loudnorm=${parts.join(':')}`]
  // loudnorm 内部会升到 192kHz，必须显式拉回目标采样率
  args.push(...codecArgs(format, { bitrate, sampleRate: 48000 }), ...threads(threadCount), output)
  return args
}

const DENOISE_PRESETS = {
  light: { nr: '6', nf: '-30' },
  medium: { nr: '12', nf: '-25' },
  strong: { nr: '24', nf: '-20' }
}

/**
 * FFT 降噪 + 高低通。arnndn 需要外挂模型，宿主不提供，所以只用 afftdn。
 * @param {object} opts 见下
 * @param {string} opts.input 输入文件
 * @param {string} opts.output 输出文件
 * @param {'light'|'medium'|'strong'} [opts.strength] 强度档位
 * @param {number} [opts.highpass] 高通频率 Hz，0 表示不挂
 * @param {number} [opts.lowpass] 低通频率 Hz，0 表示不挂
 * @param {string} opts.format 目标格式
 * @param {number} [opts.bitrate] 有损码率
 * @param {number} [opts.threadCount] 线程数
 * @returns {string[]} 参数数组
 */
export function denoise({ input, output, strength = 'medium', highpass = 70, lowpass = 16000, format, bitrate, threadCount = 0 }) {
  const preset = DENOISE_PRESETS[strength] || DENOISE_PRESETS.medium
  const chain = []
  if (Number(highpass) > 0) chain.push(`highpass=f=${Number(highpass)}`)
  chain.push(`afftdn=nr=${preset.nr}:nf=${preset.nf}:tn=1`)
  if (Number(lowpass) > 0) chain.push(`lowpass=f=${Number(lowpass)}`)
  const args = [...BASE, '-i', input, ...AUDIO_MAP, '-af', chain.join(',')]
  args.push(...codecArgs(format, { bitrate }), ...threads(threadCount), output)
  return args
}

/* ----------------------------- 元数据与封面 ----------------------------- */

/**
 * 写标签 / 换封面，音频流一律 -c:a copy（不重编码）。
 * 封面必须以 attached_pic 附加进去，否则播放器会当成视频流。
 * @param {object} opts 见下
 * @param {string} opts.input 输入文件
 * @param {string} opts.output 输出文件
 * @param {Record<string, string>} [opts.tags] 要写入的标签
 * @param {string} [opts.coverPath] 新封面图片路径；空表示沿用原封面
 * @param {string} opts.format 输出容器
 * @param {number} [opts.threadCount] 线程数
 * @returns {string[]} 参数数组
 */
export function writeMetadata({ input, output, tags = {}, coverPath = '', format, threadCount = 0 }) {
  const args = [...BASE, '-i', input]
  const hasCover = Boolean(coverPath)
  if (hasCover) args.push('-i', coverPath)

  if (hasCover) {
    args.push('-map', '0:a:0', '-map', '1:v:0')
    // 封面在 mp3/m4a 里必须是 attached_pic，否则播放器当视频流
    if (format === 'flac') args.push('-c:v', 'copy')
    else args.push('-c:v', 'mjpeg', '-pix_fmt', 'yuvj420p')
    args.push('-disposition:v:0', 'attached_pic')
  } else {
    args.push(...AUDIO_MAP)
  }

  args.push('-c:a', 'copy', '-map_metadata', '0', ...metaArgs(tags))
  const c = CONTAINERS[format]
  if (c && c.muxer) args.push('-f', c.muxer)
  if (format === 'mp3') args.push('-id3v2_version', '3')
  args.push(...threads(threadCount), output)
  return args
}

/**
 * 取内嵌封面：只取一帧、直接复制编码，不重编码。
 * @param {object} opts 见下
 * @param {string} opts.input 输入音频
 * @param {string} opts.output 输出的图片路径
 * @returns {string[]} 参数数组
 */
export function extractCover({ input, output }) {
  return [...BASE, '-i', input, '-map', '0:v:0', '-c:v', 'copy', '-frames:v', '1', output]
}

/* -------------------------------- ASMR -------------------------------- */

/**
 * 第一遍：只探测静音区间（-f null 不产出文件），stderr 由 parseSilence 解析。
 * @param {object} opts 见下
 * @param {string} opts.input 输入文件
 * @param {number} [opts.noise] 静音阈值 dB
 * @param {number} [opts.minSilence] 多长才算分隔（秒）
 * @returns {string[]} 参数数组
 */
export function silenceDetect({ input, noise = -35, minSilence = 0.8 }) {
  const filter = `silencedetect=noise=${Number(noise)}dB:d=${Number(minSilence)}`
  return [...BASE, '-i', input, '-af', filter, '-f', 'null', '-']
}

/**
 * 切一段出来：切点按 keyframe 前置 seek，段首段尾各挂一个微淡入淡出消爆音。
 * @param {object} opts 见下
 * @param {string} opts.input 输入文件
 * @param {string} opts.output 输出文件
 * @param {number} [opts.start] 起点秒数
 * @param {number} [opts.duration] 时长秒数
 * @param {number} [opts.fadeIn] 段首淡入
 * @param {number} [opts.fadeOut] 段尾淡出
 * @param {string} opts.format 目标格式
 * @param {number} [opts.bitrate] 有损码率
 * @param {number} [opts.threadCount] 线程数
 * @returns {string[]} 参数数组
 */
export function splitSegment({ input, output, start = 0, duration = 0, fadeIn = 0.08, fadeOut = 0.15, format, bitrate, threadCount = 0 }) {
  const filters = []
  if (Number(fadeIn) > 0) filters.push(`afade=t=in:st=0:d=${Number(fadeIn)}`)
  if (Number(fadeOut) > 0 && Number(duration) > 0) {
    const st = Math.max(0, Number(duration) - Number(fadeOut))
    filters.push(`afade=t=out:st=${st.toFixed(3)}:d=${Number(fadeOut)}`)
  }
  const args = [...BASE, '-ss', String(Number(start) || 0), '-i', input]
  if (Number(duration) > 0) args.push('-t', String(Number(duration)))
  args.push(...AUDIO_MAP)
  if (filters.length) args.push('-af', filters.join(','))
  args.push(...codecArgs(format, { bitrate }), ...threads(threadCount), output)
  return args
}

/**
 * 去首尾静音：silenceremove 只能处理开头，尾巴靠 areverse 后再来一遍。
 * @param {object} opts 见下
 * @param {string} opts.input 输入文件
 * @param {string} opts.output 输出文件
 * @param {number} [opts.threshold] 静音阈值 dB
 * @param {number} [opts.keepEdge] 端点保留的静音秒数，太贴会显得突兀
 * @param {string} opts.format 目标格式
 * @param {number} [opts.bitrate] 有损码率
 * @param {number} [opts.threadCount] 线程数
 * @returns {string[]} 参数数组
 */
export function trimSilence({ input, output, threshold = -40, keepEdge = 0.1, format, bitrate, threadCount = 0 }) {
  const t = `start_periods=1:start_duration=0.1:start_threshold=${Number(threshold)}dB:detection=rms`
  const e = `stop_periods=-1:stop_duration=${Number(keepEdge)}:stop_threshold=${Number(threshold)}dB:detection=rms`
  const args = [...BASE, '-i', input, ...AUDIO_MAP, '-af', `silenceremove=${t},areverse,silenceremove=${e},areverse`]
  args.push(...codecArgs(format, { bitrate }), ...threads(threadCount), output)
  return args
}

/* ------------------------------- 可视化 ------------------------------- */

/**
 * 出图：频谱或波形，只取一帧。
 * @param {object} opts 见下
 * @param {string} opts.input 输入文件
 * @param {string} opts.output PNG 路径
 * @param {'spectrum'|'waveform'} [opts.kind] 图型
 * @param {number} [opts.width] 宽度像素
 * @param {number} [opts.height] 高度像素
 * @returns {string[]} 参数数组
 */
export function visualize({ input, output, kind = 'spectrum', width = 1920, height = 1080 }) {
  const size = `${Math.round(width)}x${Math.round(height)}`
  const filter =
    kind === 'waveform'
      ? `showwavespic=s=${size}:colors=#4C9AFF:split_channels=0`
      : `showspectrumpic=s=${size}:legend=1:scale=log`
  return [...BASE, '-i', input, '-lavfi', filter, '-frames:v', '1', output]
}

/**
 * 能力表探测：结果由 binaries 缓存，界面用来判断有哪些编码器可用。
 * @returns {string[]} 参数数组（`ffmpeg -encoders`）
 */
export function listEncoders() {
  return [...BASE, '-encoders']
}
