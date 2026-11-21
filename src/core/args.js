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

export function outputExtOf(format) {
  const c = CONTAINERS[format]
  return c ? c.ext : 'm4a'
}

/** 编码参数：码率 / 质量 / muxer */
export function codecArgs(format, opts = {}) {
  const c = CONTAINERS[format]
  if (!c) throw new Error(`不支持的输出格式：${format}`)
  const args = ['-c:a', c.encoder]

  if (c.lossy && opts.bitrate) args.push('-b:a', `${Math.round(Number(opts.bitrate))}k`)
  if (format === 'mp3' && opts.quality !== undefined && opts.quality !== '' && opts.quality !== null) {
    args.push('-q:a', String(opts.quality))
  }
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

/** 无编码器声明的纯容器拷贝（同编码直转） */
function copyArgs(format, opts = {}) {
  const c = CONTAINERS[format]
  const args = ['-c:a', 'copy']
  if (c && c.muxer) args.push('-f', c.muxer)
  if (opts.sampleRate) args.push('-ar', String(Math.round(Number(opts.sampleRate))))
  if (opts.channels) args.push('-ac', String(Math.round(Number(opts.channels))))
  return args
}

export function metaArgs(tags = {}) {
  const args = []
  for (const [key, value] of Object.entries(tags)) {
    if (value === undefined || value === null || value === '') continue
    args.push('-metadata', `${key}=${value}`)
  }
  return args
}

/* ------------------------------ A 核心转码 ------------------------------ */

export function convert({ input, output, format, bitrate, quality, compression, sampleRate, channels, copy = false, threadCount = 0 }) {
  const args = [...BASE, '-i', input, ...AUDIO_MAP]
  args.push(...(copy ? copyArgs(format, { sampleRate, channels }) : codecArgs(format, { bitrate, quality, compression, sampleRate, channels })))
  args.push(...threads(threadCount), output)
  return args
}

/** 从视频容器里取出音轨：丢掉画面/字幕/数据流，只保留第一条音频 */
export function extractAudio({ input, output, format, bitrate, quality, sampleRate, channels, copy = false, threadCount = 0 }) {
  const args = [...BASE, '-i', input, ...AUDIO_MAP, '-sn', '-dn']
  args.push(...(copy ? copyArgs(format, { sampleRate, channels }) : codecArgs(format, { bitrate, quality, sampleRate, channels })))
  args.push(...threads(threadCount), output)
  return args
}

/** 时间裁剪。copy 模式走关键帧近似，会不准 */
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

/** 合并：copy 模式最快，但要求编码参数一致；否则走 filter_complex 重编码 */
export function mergeCopy({ listFile, output, format, threadCount = 0 }) {
  const c = CONTAINERS[format]
  const args = [...BASE, '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy']
  if (c && c.muxer) args.push('-f', c.muxer)
  args.push(...threads(threadCount), output)
  return args
}

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

/** atempo 单级只到 2.0 听感才稳，超出用串联 */
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

/** 变速 / 增益 / 淡入淡出合成一条滤镜链 */
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

/* ------------------------------ B 音频工程 ------------------------------ */

export function loudnormAnalyze({ input, targetLufs = -18, truePeak = -3, lra = 11 }) {
  const filter = `loudnorm=I=${targetLufs}:TP=${truePeak}:LRA=${lra}:print_format=json`
  return [...BASE, '-i', input, '-af', filter, '-f', 'null', '-']
}

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

/* --------------------------- C 元数据与封面 --------------------------- */

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

export function extractCover({ input, output }) {
  return [...BASE, '-i', input, '-map', '0:v:0', '-c:v', 'copy', '-frames:v', '1', output]
}

/* ------------------------------ D ASMR ------------------------------ */

export function silenceDetect({ input, noise = -35, minSilence = 0.8 }) {
  const filter = `silencedetect=noise=${Number(noise)}dB:d=${Number(minSilence)}`
  return [...BASE, '-i', input, '-af', filter, '-f', 'null', '-']
}

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

export function trimSilence({ input, output, threshold = -40, keepEdge = 0.1, format, bitrate, threadCount = 0 }) {
  const t = `start_periods=1:start_duration=0.1:start_threshold=${Number(threshold)}dB:detection=rms`
  const e = `stop_periods=-1:stop_duration=${Number(keepEdge)}:stop_threshold=${Number(threshold)}dB:detection=rms`
  const args = [...BASE, '-i', input, ...AUDIO_MAP, '-af', `silenceremove=${t},areverse,silenceremove=${e},areverse`]
  args.push(...codecArgs(format, { bitrate }), ...threads(threadCount), output)
  return args
}

/* ------------------------------ E 可视化 ------------------------------ */

export function visualize({ input, output, kind = 'spectrum', width = 1920, height = 1080 }) {
  const size = `${Math.round(width)}x${Math.round(height)}`
  const filter =
    kind === 'waveform'
      ? `showwavespic=s=${size}:colors=#4C9AFF:split_channels=0`
      : `showspectrumpic=s=${size}:legend=1:scale=log`
  return [...BASE, '-i', input, '-lavfi', filter, '-frames:v', '1', output]
}

/** 传给 ffmpeg 的 -encoders 探测，用于能力表缓存 */
export function listEncoders() {
  return [...BASE, '-encoders']
}
