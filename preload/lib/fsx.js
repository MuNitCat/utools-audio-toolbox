'use strict'

/**
 * 文件系统封装。所有接受外部路径的函数都必须先过 guard（会话级白名单），
 * 且失败时返回 `{ok:false, code, message}` 而不是抛错——队列的失败清理依赖返回值。
 */

const fs = require('node:fs')
const path = require('node:path')
const { MEDIA_EXTS } = require('./exts')
const guard = require('./guard')

const TEMP_PREFIX = 'audio-batch-'
/** 封面/预览读图上限：12MB，超过直接当没有 */
const MAX_IMAGE = 12 * 1024 * 1024
/** concat 列表这类临时文本上限 */
const MAX_TEMP_TEXT = 4 * 1024 * 1024

/** UI 可显示、可读成 data URL 的图片扩展名 */
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'gif'])

const MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  bmp: 'image/bmp',
  gif: 'image/gif'
}

/**
 * @returns {object} uTools 宿主对象（SSR / 测试环境可能为空对象）
 */
function utoolsApi() {
  return (typeof window !== 'undefined' ? window.utools : globalThis.utools) || {}
}

/**
 * 建目录。内部使用，不挂到桥接层（外部要能建目录意味着任意写）。
 * @param {string} dir 绝对路径
 * @returns {boolean} 是否成功
 */
function ensureDir(dir) {
  if (!dir) return false
  try {
    fs.mkdirSync(dir, { recursive: true })
    return true
  } catch (_) {
    return false
  }
}

/**
 * 探测目标是否存在。仅允许已授权写目录与临时目录。
 * @param {string} target 绝对路径
 * @returns {boolean} 存在为 true；被拒绝或异常为 false
 */
function exists(target) {
  const res = guard.assertProbe(target)
  return Boolean(res && res.ok && res.exists)
}

/**
 * 判断是否目录。已授权的目录与已授权的文件都放行（拖入的可能是文件也可能是目录）。
 * @param {string} target 绝对路径
 * @returns {boolean}
 */
function isDir(target) {
  const allowed = guard.assertReadDir(target).ok || guard.assertReadFile(target).ok
  if (!allowed) return false
  try {
    return fs.statSync(target).isDirectory()
  } catch (_) {
    return false
  }
}

/**
 * 删除文件。只允许「本次会话产出」与插件临时目录里的文件。
 * @param {string} target 绝对路径
 * @returns {{ok: boolean, code?: string, message?: string, temp?: boolean}}
 */
function removeFile(target) {
  const res = guard.assertDelete(target)
  if (!res.ok) return res
  try {
    fs.rmSync(res.path, { force: true })
    return { ok: true, temp: Boolean(res.temp) }
  } catch (err) {
    return { ok: false, code: 'ERM_FAILED', message: `删除失败：${(err && err.message) || '未知原因'}` }
  }
}

/**
 * 插件临时目录（宿主提供优先，退回到系统临时目录下的固定子目录）。
 * @returns {string} 绝对路径
 */
function tempDir() {
  const api = utoolsApi()
  try {
    if (typeof api.getPluginTempPath === 'function') {
      const dir = api.getPluginTempPath()
      ensureDir(dir)
      return dir
    }
  } catch (_) {}
  const fallback = path.join(require('node:os').tmpdir(), 'audio-batch')
  ensureDir(fallback)
  return fallback
}

/**
 * 写一个临时文本文件（concat 列表等），只落在插件临时目录。
 * @param {string} content 文本内容
 * @param {string} [ext] 扩展名，只允许字母数字（默认 txt）
 * @returns {string} 生成的绝对路径
 * @throws {Error} 扩展名非法或内容过大时抛出
 */
function makeTempText(content, ext = 'txt') {
  const suffix = String(ext || 'txt')
  if (!/^[a-z0-9]{1,8}$/.test(suffix)) throw new Error('临时文件扩展名非法')
  const text = String(content == null ? '' : content)
  if (text.length > MAX_TEMP_TEXT) throw new Error('临时文件内容过大')
  const name = `${TEMP_PREFIX}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${suffix}`
  const file = path.join(tempDir(), name)
  fs.writeFileSync(file, text, 'utf8')
  return file
}

/**
 * 清理过期临时文件（默认 24h），只处理 audio-batch- 前缀。
 * @param {number} [maxAgeMs] 超过该时长的文件会被删
 * @returns {number} 删除数量
 */
function cleanupTemp(maxAgeMs = 24 * 3600 * 1000) {
  const dir = tempDir()
  let removed = 0
  try {
    const now = Date.now()
    for (const name of fs.readdirSync(dir)) {
      if (!name.startsWith(TEMP_PREFIX)) continue
      const full = path.join(dir, name)
      try {
        const st = fs.statSync(full)
        if (now - st.mtimeMs > maxAgeMs) {
          fs.rmSync(full, { force: true, recursive: true })
          removed += 1
        }
      } catch (_) {}
    }
  } catch (_) {}
  return removed
}

/**
 * 递归列出目录下的音频与视频文件。只允许已授权目录。
 * @param {string} dir 绝对路径
 * @param {{recursive?: boolean, exts?: string[], limit?: number}} [opts]
 * @returns {string[]} 排序后的绝对路径；目录未授权时返回空数组
 */
function listMedia(dir, opts = {}) {
  const allowed = guard.assertReadDir(dir)
  if (!allowed.ok) {
    console.warn('[audio-batch] listMedia 被拒绝：', allowed.message)
    return []
  }
  const { recursive = true, exts = MEDIA_EXTS } = opts
  const limit = Math.min(20000, Math.max(1, Number(opts.limit) || 5000))
  const allow = new Set(exts.map((e) => String(e).replace(/^\./, '').toLowerCase()))
  const out = []

  const walk = (current) => {
    if (out.length >= limit) return
    let entries = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch (_) {
      return
    }
    for (const entry of entries) {
      if (out.length >= limit) return
      if (entry.name.startsWith('.')) continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (recursive) walk(full)
        continue
      }
      const ext = path.extname(entry.name).replace(/^\./, '').toLowerCase()
      if (allow.has(ext)) out.push(full)
    }
  }

  walk(allowed.path)
  return out.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
}

/**
 * 把图片读成 data URL 给界面显示。只允许已授权/已产出的图片，未知扩展名直接返回空串
 * （以前默认 image/jpeg，会把任意文件当图片塞进 <img>）。
 * @param {string} file 绝对路径
 * @returns {string} data URL；不可用时空字符串
 */
function coverDataUrl(file) {
  const res = guard.assertReadFile(file)
  if (!res.ok) return ''
  const ext = path.extname(res.path).replace(/^\./, '').toLowerCase()
  if (!IMAGE_EXT.has(ext) || !MIME[ext]) return ''
  try {
    if (fs.statSync(res.path).size > MAX_IMAGE) return ''
    return `data:${MIME[ext]};base64,${fs.readFileSync(res.path).toString('base64')}`
  } catch (_) {
    return ''
  }
}

/**
 * 重命名/移动。源必须是本次产出或临时文件，目标必须落在已授权写目录且不存在。
 * @param {string} from 源绝对路径
 * @param {string} to 目标绝对路径
 * @returns {{ok: boolean, code?: string, message?: string}}
 */
function renameFile(from, to) {
  if (from === to) return { ok: true }
  const res = guard.assertRename(from, to)
  if (!res.ok) return res
  ensureDir(path.dirname(res.to))
  try {
    fs.renameSync(res.from, res.to)
    return { ok: true }
  } catch (err) {
    if (err && err.code === 'EXDEV') {
      try {
        fs.copyFileSync(res.from, res.to)
        fs.rmSync(res.from, { force: true })
        return { ok: true }
      } catch (copyErr) {
        return { ok: false, code: 'ERENAME_FAILED', message: `移动失败：${(copyErr && copyErr.message) || '未知原因'}` }
      }
    }
    return { ok: false, code: 'ERENAME_FAILED', message: `移动失败：${(err && err.message) || '未知原因'}` }
  }
}

/**
 * 读文本（仅 preload 内部使用，未挂到桥接层）。
 * @param {string} target 绝对路径
 * @returns {string} 内容；异常时空字符串
 */
function readText(target) {
  try {
    return fs.readFileSync(target, 'utf8')
  } catch (_) {
    return ''
  }
}

module.exports = {
  ensureDir,
  exists,
  isDir,
  removeFile,
  makeTempText,
  cleanupTemp,
  tempDir,
  listMedia,
  /** 旧名保留：老 preload 调到的是 listAudio，新代码统一用 listMedia */
  listAudio: listMedia,
  coverDataUrl,
  renameFile,
  readText,
  TEMP_PREFIX
}
