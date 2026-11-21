'use strict'

/**
 * preload 桥接层：唯一出口 window.audioServices
 * 原则：只暴露编排级接口，不暴露 fs / path / child_process 裸对象，
 *      也不把 ffmpeg 进程对象交给渲染层。
 */

const { probe, probeMany } = require('./lib/probe')
const fpm = require('./lib/ffmpeg')
const binaries = require('./lib/binaries')
const previewer = require('./lib/previewer')
const fsx = require('./lib/fsx')
const paths = require('./lib/paths')
const { getConfig, setConfig } = require('./lib/config')

const VERSION = '1.3.0'

function utoolsApi() {
  return (typeof window !== 'undefined' ? window.utools : globalThis.utools) || {}
}

/**
 * 把渲染层拖入的 File 还原成绝对路径。
 * Electron 32+ 移除了 File.path，退回 webUtils。
 */
function pathForFile(file) {
  if (!file) return ''
  try {
    if (typeof file.path === 'string' && file.path) return file.path
  } catch (_) {}
  try {
    const { webUtils } = require('electron')
    if (webUtils && typeof webUtils.getPathForFile === 'function') {
      const p = webUtils.getPathForFile(file)
      if (p) return p
    }
  } catch (_) {}
  return ''
}

function chooseFiles(opts = {}) {
  const api = utoolsApi()
  if (typeof api.showOpenDialog !== 'function') return []
  const res = api.showOpenDialog({
    title: opts.title || '选择音频 / 视频文件',
    filters:
      opts.filters || [
        { name: '音频', extensions: paths.AUDIO_EXTS },
        { name: '视频', extensions: paths.VIDEO_EXTS },
        { name: '全部文件', extensions: ['*'] }
      ],
    properties: ['openFile', 'multiSelections']
  })
  return Array.isArray(res) ? res : []
}

function chooseDir(title = '选择输出目录') {
  const api = utoolsApi()
  if (typeof api.showOpenDialog !== 'function') return ''
  const res = api.showOpenDialog({
    title,
    properties: ['openDirectory', 'createDirectory']
  })
  return Array.isArray(res) && res.length ? res[0] : ''
}

function openInFolder(target) {
  const api = utoolsApi()
  if (typeof api.shellShowItemInFolder === 'function') api.shellShowItemInFolder(target)
}

function openPath(target) {
  const api = utoolsApi()
  if (typeof api.shellOpenPath === 'function') api.shellOpenPath(target)
}

function notify(body) {
  const api = utoolsApi()
  if (typeof api.showNotification === 'function') api.showNotification(body)
}

function copyText(text) {
  const api = utoolsApi()
  if (typeof api.copyText === 'function') return api.copyText(String(text || ''))
  return false
}

window.audioServices = {
  version: VERSION,

  // 探测
  probe,
  probeMany,

  // 执行
  run: fpm.run,
  runCapture: fpm.capture,
  cancelTask: fpm.cancel,
  isRunning: fpm.isRunning,

  // 频谱/波形即时预览（临时文件，不落到素材目录）
  renderPreview: previewer.render,

  // 路径
  resolveOutput: paths.resolveOutput,
  numberedOutput: paths.numberedOutput,
  formatClock: paths.formatClock,
  extOf: paths.extOf,
  stripExt: paths.stripExt,
  AUDIO_EXTS: paths.AUDIO_EXTS,
  VIDEO_EXTS: paths.VIDEO_EXTS,
  MEDIA_EXTS: paths.MEDIA_EXTS,

  // 文件与目录
  ensureDir: fsx.ensureDir,
  exists: fsx.exists,
  isDir: fsx.isDir,
  size: fsx.size,
  removeFile: fsx.removeFile,
  makeTempText: fsx.makeTempText,
  cleanupTemp: fsx.cleanupTemp,
  tempDir: fsx.tempDir,
  listMedia: fsx.listMedia,
  /** 兼容旧调用名 */
  listAudio: fsx.listMedia,
  coverDataUrl: fsx.coverDataUrl,
  writeBase64: fsx.writeBase64,
  renameFile: fsx.renameFile,

  // 配置
  getConfig,
  setConfig,

  // 二进制（优先系统 ffmpeg，其次 uTools 内置）
  getBinaries: () => binaries.summary(),
  refreshBinaries: () => {
    binaries.refresh()
    return binaries.summary()
  },
  /** 设置弹窗：列出机器上所有可用的 ffmpeg */
  scanBinaries: () => binaries.scan(),
  /** 设置弹窗：切换用哪个（{ mode: 'custom'|'host', path }） */
  setFfmpegPreference: (pref) => binaries.setPreference(pref || {}),
  /** 设置弹窗：手动添加路径到列表（会先校验存在性与可执行性） */
  addFfmpegPath: (target) => binaries.addExtra(target),
  removeFfmpegPath: (target) => binaries.removeExtra(target),

  // 系统
  platform: () => process.platform,
  pathForFile,
  chooseFiles,
  chooseDir,
  openInFolder,
  openPath,
  openExternal: (url) => {
    const api = utoolsApi()
    if (typeof api.shellOpenExternal === 'function') api.shellOpenExternal(String(url))
  },
  notify,
  copyText,
  /** uTools 约定名：home / desktop / documents / downloads / pictures / music / videos */
  getPath: (name) => {
    const api = utoolsApi()
    try {
      return api.getPath ? api.getPath(String(name || '')) || '' : ''
    } catch (_) {
      return ''
    }
  },
  getDownloadsPath: () => {
    const api = utoolsApi()
    try {
      return api.getPath ? api.getPath('downloads') || '' : ''
    } catch (_) {
      return ''
    }
  }
}

console.log(`[audio-batch] preload v${VERSION} ready`)
