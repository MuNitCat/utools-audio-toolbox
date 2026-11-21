'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { MEDIA_EXTS } = require('./paths')

const TEMP_PREFIX = 'audio-batch-'

function utoolsApi() {
  return (typeof window !== 'undefined' ? window.utools : globalThis.utools) || {}
}

function ensureDir(dir) {
  if (!dir) return false
  try {
    fs.mkdirSync(dir, { recursive: true })
    return true
  } catch (_) {
    return false
  }
}

function exists(target) {
  try {
    return fs.existsSync(target)
  } catch (_) {
    return false
  }
}

function size(target) {
  try {
    return fs.statSync(target).size
  } catch (_) {
    return 0
  }
}

function isDir(target) {
  try {
    return fs.statSync(target).isDirectory()
  } catch (_) {
    return false
  }
}

function removeFile(target) {
  try {
    fs.rmSync(target, { force: true })
    return true
  } catch (_) {
    return false
  }
}

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

/** 写临时文本文件（concat 列表等），返回绝对路径 */
function makeTempText(content, ext = 'txt') {
  const name = `${TEMP_PREFIX}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const file = path.join(tempDir(), name)
  fs.writeFileSync(file, content, 'utf8')
  return file
}

/** 清理超过 maxAgeMs 的临时文件（默认 24h） */
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
 * 列出目录下的音频与视频文件（视频只为「视频提取音频」服务，别的功能只用到它的音轨）
 * @param {string} dir
 * @param {{recursive?:boolean, exts?:string[], limit?:number}} opts
 */
function listMedia(dir, opts = {}) {
  const { recursive = true, exts = MEDIA_EXTS, limit = 5000 } = opts
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

  walk(dir)
  return out.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }))
}

const MIME = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  bmp: 'image/bmp',
  gif: 'image/gif'
}

/** 读图片成 data URL，给 UI 显示封面缩略图 */
function coverDataUrl(file) {
  try {
    if (!file || !fs.existsSync(file)) return ''
    const st = fs.statSync(file)
    if (st.size > 12 * 1024 * 1024) return ''
    const ext = path.extname(file).replace(/^\./, '').toLowerCase()
    const mime = MIME[ext] || 'image/jpeg'
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`
  } catch (_) {
    return ''
  }
}

/** 重命名/移动文件；跨磁盘时退回 copy + unlink */
function renameFile(from, to) {
  try {
    if (!from || !to || from === to) return true
    ensureDir(path.dirname(to))
    if (fs.existsSync(to)) fs.rmSync(to, { force: true })
    try {
      fs.renameSync(from, to)
    } catch (err) {
      if (err && err.code === 'EXDEV') {
        fs.copyFileSync(from, to)
        fs.rmSync(from, { force: true })
      } else {
        throw err
      }
    }
    return true
  } catch (_) {
    return false
  }
}

function writeBase64(target, b64) {  try {
    ensureDir(path.dirname(target))
    fs.writeFileSync(target, Buffer.from(String(b64).replace(/^data:[^,]+,/, ''), 'base64'))
    return true
  } catch (_) {
    return false
  }
}

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
  size,
  isDir,
  removeFile,
  makeTempText,
  cleanupTemp,
  tempDir,
  listMedia,
  /** 旧名保留：老 preload 调到的是 listAudio，新代码统一用 listMedia */
  listAudio: listMedia,
  coverDataUrl,
  writeBase64,
  renameFile,
  readText
}
