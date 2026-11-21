'use strict'

const path = require('node:path')

const AUDIO_EXTS = [
  'mp3',
  'm4a',
  'm4b',
  'aac',
  'flac',
  'wav',
  'wave',
  'ogg',
  'oga',
  'opus',
  'alac',
  'aiff',
  'aif',
  'ape',
  'wma',
  'mka',
  'caf',
  'amr'
]

/** 视频容器：全部走「视频提取音频」，不单独做视频处理 */
const VIDEO_EXTS = [
  'mp4',
  'm4v',
  'mkv',
  'mov',
  'avi',
  'webm',
  'flv',
  'wmv',
  'ts',
  'm2ts',
  'mpg',
  'mpeg',
  '3gp',
  'ogv',
  'vob',
  'rmvb'
]

const MEDIA_EXTS = [...AUDIO_EXTS, ...VIDEO_EXTS]

function extOf(file) {
  return path.extname(file || '').replace(/^\./, '').toLowerCase()
}

function stripExt(name) {
  const e = path.extname(name || '')
  return e ? name.slice(0, -e.length) : name
}

/**
 * 计算输出路径。未指定目录时落到源文件同级目录。
 * 默认不覆盖：同名冲突时追加 (1) (2) ...
 */
function resolveOutput(input, opts = {}) {
  const {
    dir = '',
    suffix = '',
    ext = '',
    name = '',
    overwrite = false
  } = opts
  const inputDir = path.dirname(input)
  const targetDir = dir && dir.trim() ? dir : inputDir
  const outExt = (ext || extOf(input) || 'm4a').replace(/^\./, '')
  const baseName = name && name.trim() ? name.trim() : stripExt(path.basename(input)) + (suffix || '')
  const safe = baseName.replace(/[/\\:*?"<>|]/g, '_').replace(/\s+$/, '')
  let out = path.join(targetDir, `${safe}.${outExt}`)

  if (!overwrite) {
    let i = 1
    while (i < 1000 && require('node:fs').existsSync(out)) {
      out = path.join(targetDir, `${safe} (${i}).${outExt}`)
      i += 1
    }
  }
  return out
}

/** 给批量合并/切分用：基于源文件生成带序号的输出名 */
function numberedOutput(input, index, opts = {}) {
  const {
    dir = '',
    suffix = '',
    ext = '',
    timeRange = null,
    digits = 3
  } = opts
  const inputDir = path.dirname(input)
  const targetDir = dir && dir.trim() ? dir : inputDir
  const outExt = (ext || extOf(input) || 'flac').replace(/^\./, '')
  const stem = stripExt(path.basename(input)) + (suffix || '')
  const seq = String(index).padStart(digits, '0')
  const tail = timeRange ? `_${timeRange}` : ''
  return path.join(targetDir, `${stem}_${seq}${tail}.${outExt}`)
}

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0))
  const mm = String(Math.floor(s / 60)).padStart(2, '0')
  const ss = String(s % 60).padStart(2, '0')
  return `${mm}-${ss}`
}

module.exports = { resolveOutput, numberedOutput, AUDIO_EXTS, VIDEO_EXTS, MEDIA_EXTS, extOf, stripExt, formatClock }
