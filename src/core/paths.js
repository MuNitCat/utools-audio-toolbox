/**
 * 输出命名规则与媒体扩展名。
 *
 * 这些属于业务规则，按审核建议从 preload 下沉到前端；preload 只保留 fs / 进程 / 探测能力，
 * 以及 AUDIO_EXTS / VIDEO_EXTS / MEDIA_EXTS 这几个常量（拼对话框过滤条件要用）。
 * 为了跟当年的 preload 实现逐字节一致，这里只在两处不同：
 * 1. 不支持 node:path → 自己实现 dirname / basename / extname（只处理绝对路径）
 * 2. 重名检测从 `fs.existsSync` 换成 `api.exists`（preload 会校验目标父目录是否已授权）
 *
 * preload 里的同名函数已经删掉了，这里是**唯一**实现：改命名规则只改这个文件，
 * 跑 scripts/check/paths.test.mjs（golden 断言）确认没有意外改名。
 */

/**
 * 扩展名数据在 shared/exts.json：preload/lib/exts.js 读的是同一个文件，
 * 以前两边各存一份数组靠人眼同步，现在改这里等于两边一起改。
 */
import exts from '../../shared/exts.json' with { type: 'json' }

/** 音频扩展名 */
export const AUDIO_EXTS = exts.audio

/** 视频容器：全部走「视频提取音频」，不单独做视频处理 */
export const VIDEO_EXTS = exts.video

export const MEDIA_EXTS = [...AUDIO_EXTS, ...VIDEO_EXTS]

/** 输出目录里允许出现的最多同名副本数 */
const MAX_COPY = 1000

/**
 * @returns {object|null} preload 桥接对象；SSR / 单测环境为 null
 */
function svc() {
  return typeof window !== 'undefined' ? window.audioServices : null
}

/**
 * @param {string} p 绝对路径
 * @returns {string} 所在目录
 */
function dirname(p) {
  const s = String(p || '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  if (i < 0) return '.'
  if (i === 0) return s.slice(0, 1)
  // Windows 盘符根：C:\a → C:\
  if (s[i - 1] === ':') return s.slice(0, i + 1)
  return s.slice(0, i)
}

/**
 * @param {string} p 路径
 * @returns {string} 最后一段
 */
function basename(p) {
  const s = String(p || '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i < 0 ? s : s.slice(i + 1)
}

/**
 * @param {string} file 文件名或路径
 * @returns {string} 小写扩展名，不带点
 */
export function extOf(file) {
  const name = basename(file)
  const i = name.lastIndexOf('.')
  return i <= 0 ? '' : name.slice(i + 1).toLowerCase()
}

/**
 * @param {string} name 文件名
 * @returns {string} 去掉最后一段扩展名
 */
export function stripExt(name) {
  const value = String(name == null ? '' : name)
  const dot = value.lastIndexOf('.')
  const sep = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  // 点在分隔符之前（或没有扩展名）时原样返回
  if (dot <= sep + 1) return value
  return value.slice(0, dot)
}

/**
 * 清洗文件名片段（后缀 / 扩展名 / 时间段）。出现分隔符或 `..` 一律替换，
 * 防止 `suffix: '../../x'` 把输出写到目录外。
 * @param {string} raw 原始片段
 * @returns {string} 安全片段（最长 120 字符）
 */
export function sanitizeSegment(raw) {
  return String(raw == null ? '' : raw)
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\.\./g, '_')
    .replace(/^\.+/, '')
    .replace(/\s+$/, '')
    .slice(0, 120)
}

/**
 * 拼接目录与文件名，分隔符跟随目录本身（Windows 路径用 `\`）。
 * @param {string} dir 目录
 * @param {string} name 文件名
 * @returns {string} 拼好的绝对路径
 */
function join(dir, name) {
  const sep = String(dir).includes('\\') && !String(dir).includes('/') ? '\\' : '/'
  return String(dir).replace(/[\\/]+$/, '') + sep + name
}

/**
 * 计算输出路径。未指定目录时落到源文件同级；默认不覆盖，冲突时追加 ` (1)` ` (2)`。
 * @param {string} input 输入文件绝对路径
 * @param {{dir?: string, suffix?: string, ext?: string, name?: string, overwrite?: boolean}} [opts]
 * @returns {string} 输出文件绝对路径
 */
export function resolveOutput(input, opts = {}) {
  const { dir = '', suffix = '', ext = '', name = '', overwrite = false } = opts
  const targetDir = dir && String(dir).trim() ? dir : dirname(input)
  const outExt = sanitizeSegment((ext || extOf(input) || 'm4a').replace(/^\./, '')) || 'm4a'
  const baseName =
    name && String(name).trim() ? sanitizeSegment(String(name).trim()) : stripExt(basename(input)) + sanitizeSegment(suffix)
  const safe = sanitizeSegment(baseName)
  let out = join(targetDir, `${safe}.${outExt}`)

  // 重名检测走 preload（它才知道该目录是否已授权）；旧 preload / SSR 下返回 false
  const api = svc()
  if (!overwrite && api && typeof api.exists === 'function') {
    let i = 1
    while (i < MAX_COPY && api.exists(out)) {
      out = join(targetDir, `${safe} (${i}).${outExt}`)
      i += 1
    }
  }
  return out
}

/**
 * 批量合并 / 切分用：基于源文件名生成带序号的输出名。
 * @param {string} input 输入文件绝对路径
 * @param {number} index 序号（从 1 开始）
 * @param {{dir?: string, suffix?: string, ext?: string, timeRange?: string, digits?: number}} [opts]
 * @returns {string} 输出文件绝对路径
 */
export function numberedOutput(input, index, opts = {}) {
  const { dir = '', suffix = '', ext = '', timeRange = null, digits = 3 } = opts
  const targetDir = dir && String(dir).trim() ? dir : dirname(input)
  const outExt = sanitizeSegment((ext || extOf(input) || 'flac').replace(/^\./, '')) || 'flac'
  const stem = stripExt(basename(input)) + sanitizeSegment(suffix)
  const seq = String(index).padStart(digits, '0')
  const tail = timeRange ? `_${sanitizeSegment(timeRange)}` : ''
  return join(targetDir, `${stem}_${seq}${tail}.${outExt}`)
}
