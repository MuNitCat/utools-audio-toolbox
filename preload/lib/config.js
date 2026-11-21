'use strict'

const KEY = 'audio-batch:config'

const DEFAULTS = {
  outputMode: 'sibling',
  outputDir: '',
  suffix: '',
  overwrite: false,
  concurrency: 1,
  threads: 0,
  lastFeature: 'convert',
  lastGroup: 'A',
  params: {},
  targetLufs: -18,
  truePeak: -3,
  lra: 11,
  /** 自定义 ffmpeg 路径（目录或可执行文件）；留空则自动探测 */
  ffmpegPath: '',
  /** 'auto' 自动探测 | 'custom' 用 ffmpegPath | 'host' 强制 uTools 内置 */
  ffmpegMode: 'auto',
  /** 用户手动添加进列表的 ffmpeg 路径（已校验可执行） */
  ffmpegExtras: [],
  /** 最近用过的艺术家，最多 5 个，最新的在前 */
  artistHistory: [],
  theme: 'light'
}

function storage() {
  const api = (typeof window !== 'undefined' ? window.utools : globalThis.utools) || {}
  return api.dbStorage || null
}

function getConfig() {
  const s = storage()
  if (!s) return { ...DEFAULTS }
  try {
    const raw = s.getItem(KEY)
    if (!raw || typeof raw !== 'object') return { ...DEFAULTS }
    return { ...DEFAULTS, ...raw, params: { ...(raw.params || {}) } }
  } catch (_) {
    return { ...DEFAULTS }
  }
}

function setConfig(patch) {
  const s = storage()
  const next = { ...getConfig(), ...(patch || {}) }
  if (s) {
    try {
      s.setItem(KEY, next)
    } catch (_) {}
  }
  return next
}

module.exports = { getConfig, setConfig, DEFAULTS }
