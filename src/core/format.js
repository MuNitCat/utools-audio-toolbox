/** 纯函数：时间/体积格式化与 ffmpeg stderr 解析（静音区间、loudnorm JSON） */

/**
 * 时长格式化成时钟样式。
 * 超过 1 小时一律带上小时位（即使 withHours=false），否则 1:13:31 会显示成 13:31，
 * 和 13 分钟完全分不清。
 * @param {number} seconds 秒数，负数按 0 处理
 * @param {boolean} [withHours] 不足 1 小时时是否也补 00: 前缀
 * @returns {string} h:mm:ss 或 mm:ss
 */
export function formatClock(seconds, withHours = true) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n) => String(n).padStart(2, '0')
  if (h > 0 || withHours) return `${pad(h)}:${pad(m)}:${pad(s)}`
  return `${pad(m)}:${pad(s)}`
}

/**
 * 标题栏用的中文短描述，只保留最大两个量级（1小时13分 / 5分20秒）。
 * @param {number} seconds 秒数
 * @returns {string} 例如「2小时5分」「13分」「42秒」
 */
export function formatShort(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  if (h > 0) return `${h}小时${m}分`
  if (m > 0) return `${m}分${s}秒`
  return `${s}秒`
}

/**
 * 字节数转易读单位；大于等于 100 时省掉小数位，避免「1024.0 MB」这种抖动。
 * @param {number} bytes 字节数
 * @returns {string} 例如「512 B」「3.2 MB」
 */
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

/**
 * 时间输入框的宽松解析：支持 "90.5"、"01:23"、"1:02:03"。
 * 输入非法时返回 0 而不是抛错——调用方普遍直接拿去做 -ss / -t。
 * @param {string|number} value 用户输入
 * @returns {number} 秒数；无法解析时为 0
 */
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

/**
 * 切分命名用的时间标签。分钟位不做 60 进制进位（90 分钟就是 90-00），
 * 好处是标签唯一、能直接按字典序排序。
 * @param {number} seconds 相对片头的秒数
 * @returns {string} 形如「12-34」
 */
export function clockTag(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0))
  const mm = String(Math.floor(total / 60)).padStart(2, '0')
  const ss = String(total % 60).padStart(2, '0')
  return `${mm}-${ss}`
}

/**
 * 解析 silencedetect 的输出。start 与 end 必须配对，落单的 start 会被丢弃
 * （任务被取消时日志常被截断，不能凭半个区间猜）。
 * @param {string} text ffmpeg 的 stderr 全文
 * @returns {{start: number, end: number}[]} 静音区间，按出现顺序
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
      // 只有配到 end 才算一段；落单的 start 说明日志被截断，直接丢弃
      if (value > pendingStart) out.push({ start: pendingStart, end: value })
      pendingStart = null
    }
  }
  return out
}

/**
 * 由静音区间反推要保留的语音段。
 * 先把每个静音段两侧各收掉 pad（留一点呼吸感），收完不足 0.15s 的直接忽略；
 * 再把剩下的静音当作切点，短于 minSegment 的碎片并到前一段里。
 * @param {number} duration 总时长（秒）
 * @param {{start: number, end: number}[]} silences 静音区间
 * @param {{minSegment?: number, pad?: number}} [opts] 最短片段与静音留边
 * @returns {{start: number, end: number}[]} 语音段；没有可用切点时返回空数组
 */
export function planSegments(duration, silences, opts = {}) {
  const { minSegment = 3, pad = 0.15 } = opts
  const total = Number(duration) || 0
  if (total <= 0) return []

  const gaps = []
  for (const s of silences || []) {
    // 静音两侧各收掉 pad：切点落在静音内部，听起来不会突然断话
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

/**
 * 均分：给了 count 就按份数，否则按每段时长向上取整算份数。
 * @param {number} duration 总时长（秒）
 * @param {{segmentSeconds?: number, count?: number}} [opts] 二选一，count 优先
 * @returns {{start: number, end: number}[]} 均匀切分的片段
 */
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

/**
 * 从 loudnorm 的 stderr 里抠出那段 JSON。
 * "-inf"/"inf" 代表静音或削波，统一转成 null，避免把字符串塞进滤镜参数。
 * @param {string} text ffmpeg 的 stderr 全文
 * @returns {{input_i: number|null, input_tp: number|null, input_lra: number|null, input_thresh: number|null, target_offset: number|null}|null}
 *   解析失败返回 null（调用方会退回单遍法）
 */
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

/**
 * 归一化 ffmpeg 的进度回调。宿主和自带 ffmpeg 给的字段不完全一致，
 * percent 缺失时保留 undefined（队列会退回按权重估算）。
 * @param {{percent?: number, time?: string, speed?: string, size?: string}} progress 原始进度
 * @returns {{percent: number|undefined, time: number, speed: number, size: string}}
 */
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

/**
 * 取错误信息的最后几行（ffmpeg 真正的原因几乎都在尾部）。
 * @param {Error|{tail?: string, log?: string, message?: string}|string} err 抛出的错误或原始日志
 * @returns {string} 最多 4 行；空输入返回空字符串
 */
export function errorTail(err) {
  if (!err) return ''
  const text = err.tail || err.log || err.message || String(err)
  return String(text).trim().split(/\r?\n/).slice(-4).join('\n')
}
