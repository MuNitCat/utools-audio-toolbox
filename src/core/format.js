/** 纯函数：时间/体积格式化与 ffmpeg stderr 解析（静音区间、loudnorm JSON） */

export function formatClock(seconds, withHours = true) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  if (h > 0 || withHours) return `${pad(h)}:${pad(m)}:${pad(s)}`
  return `${pad(m)}:${pad(s)}`
}

export function formatShort(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}小时${m}分`
  if (m > 0) return `${m}分${s}秒`
  return `${s}秒`
}

export function formatBytes(bytes) {
  const n = Number(bytes) || 0
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1024
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}

/** "01:23.5" / "1:02:03" / "83.5" -> 秒 */
export function parseTimeInput(value) {
  if (value === 0 || value === '0') return 0
  if (value === null || value === undefined || value === '') return 0
  const text = String(value).trim()
  if (!text) return 0
  const parts = text.split(':').map((p) => Number(p))
  if (parts.some((p) => Number.isNaN(p))) return 0
  if (parts.length === 1) return parts[0]
  if (parts.length === 2) return parts[0] * 60 + parts[1]
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2]
  return 0
}

/** 把秒数格式化成切分命名用的 mm-ss */
export function clockTag(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}-${ss}`
}

/**
 * 解析 silencedetect 输出
 * @returns {{start:number,end:number}[]}
 */
export function parseSilence(text) {
  if (!text) return []
  const out = []
  let pendingStart = null
  const re = /silence_(start|end):\s*(-?[\d.]+)/g
  let m
  while ((m = re.exec(text)) !== null) {
    const value = Number(m[2])
    if (m[1] === 'start') {
      pendingStart = Math.max(0, value)
    } else if (pendingStart !== null) {
      if (value > pendingStart) out.push({ start: pendingStart, end: value })
      pendingStart = null
    }
  }
  return out
}

/**
 * 由静音区间推导要保留的语音段
 * @param {number} duration 总时长
 * @param {{start:number,end:number}[]} silences
 * @param {{minSegment?:number, pad?:number}} opts
 */
export function planSegments(duration, silences, opts = {}) {
  const { minSegment = 3, pad = 0.15 } = opts
  const total = Number(duration) || 0
  if (total <= 0) return []

  const gaps = []
  for (const s of silences || []) {
    const start = Math.max(0, s.start + pad)
    const end = Math.min(total, s.end - pad)
    if (end - start >= 0.15) gaps.push({ start, end })
  }
  if (!gaps.length) return []

  const segs = []
  let cursor = 0
  for (const gap of gaps) {
    if (gap.start - cursor >= minSegment) segs.push({ start: cursor, end: gap.start })
    cursor = Math.max(cursor, gap.end)
  }
  if (total - cursor >= minSegment) segs.push({ start: cursor, end: total })
  return segs
}

/** 按固定时长或目标数量均分 */
export function planEvenSegments(duration, { segmentSeconds = 0, count = 0 } = {}) {
  const total = Number(duration) || 0
  if (total <= 0) return []
  let pieces = 0
  if (Number(count) > 0) pieces = Math.round(Number(count))
  else if (Number(segmentSeconds) > 0) pieces = Math.ceil(total / Number(segmentSeconds))
  if (pieces <= 0) return []
  const step = total / pieces
  const segs = []
  for (let i = 0; i < pieces; i += 1) {
    segs.push({ start: i * step, end: Math.min(total, (i + 1) * step) })
  }
  return segs
}

/** 从 loudnorm 的 stderr 里抠出那一段 JSON */
export function parseLoudnorm(text) {
  if (!text) return null
  const match = String(text).match(/\{[^{}]*"input_i"[\s\S]*?\}/)
  if (!match) return null
  try {
    const raw = JSON.parse(match[0])
    const num = (v) => (v === undefined || v === null || v === '-inf' || v === 'inf' ? null : Number(v))
    return {
      input_i: num(raw.input_i),
      input_tp: num(raw.input_tp),
      input_lra: num(raw.input_lra),
      input_thresh: num(raw.input_thresh),
      target_offset: num(raw.target_offset)
    }
  } catch (_) {
    return null
  }
}

/** 从 ffmpeg 进度里解析 时间 / 速度 */
export function parseProgress(progress) {
  if (!progress) return { percent: undefined, time: 0, speed: 0, size: '' }
  const time = parseTimeInput(progress.time)
  const speed = Number(String(progress.speed || '').replace('x', '')) || 0
  return {
    percent: typeof progress.percent === 'number' ? progress.percent : undefined,
    time,
    speed,
    size: progress.size || ''
  }
}

export function errorTail(err) {
  if (!err) return ''
  const text = err.tail || err.log || err.message || String(err)
  return String(text).trim().split(/\r?\n/).slice(-4).join('\n')
}
