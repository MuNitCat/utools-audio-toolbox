'use strict'

/**
 * 二进制探测：优先系统已安装的 ffmpeg（通常更新，且带 ffprobe），
 * 找不到才退回 uTools 宿主内置的 extends/ffmpeg-<arch>-<ver>。
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const config = require('./config')

const MIN_MAJOR = 4
const CACHE_TTL = 60 * 1000

let cache = null

function exeName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name
}

function isExecutable(target) {
  try {
    const st = fs.statSync(target)
    if (!st.isFile()) return false
    fs.accessSync(target, fs.constants.X_OK)
    return true
  } catch (_) {
    return false
  }
}

function pathDirs() {
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
}

const KNOWN_DIRS = {
  darwin: ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin'],
  linux: ['/usr/local/bin', '/usr/bin', '/snap/bin', '/opt/homebrew/bin'],
  win32: ['C:\\ffmpeg\\bin', 'C:\\Program Files\\ffmpeg\\bin', 'C:\\Program Files (x86)\\ffmpeg\\bin']
}

/** 用户在设置弹窗里的选择：auto 自动探测 / custom 指定路径 / host 强制用 uTools 内置 */
let override = null

function preference() {
  if (override) return override
  const cfg = config.getConfig()
  const mode = cfg.ffmpegMode === 'custom' || cfg.ffmpegMode === 'host' ? cfg.ffmpegMode : 'auto'
  return { mode, path: String(cfg.ffmpegPath || '').trim() }
}

/** 手动添加的路径（进程内缓存，config 写失败也不至于立刻丢失） */
let extraCache = null

function extras() {
  if (extraCache) return extraCache
  const list = config.getConfig().ffmpegExtras
  return Array.isArray(list) ? list : []
}

/** 目录 -> 目录下的可执行文件；已经是可执行文件就原样返回 */
function resolveBin(target, name) {
  if (!target) return ''
  try {
    const st = fs.statSync(target)
    return st.isDirectory() ? path.join(target, exeName(name)) : target
  } catch (_) {
    return ''
  }
}

function candidatesFor(name) {
  const exe = exeName(name)
  const out = []

  // 1. 用户在设置里指定的路径（可以是目录，也可以是可执行文件）
  const pref = preference()
  if (pref.path) {
    const resolved = resolveBin(pref.path, name)
    if (resolved) out.push(resolved)
  }

  // 2. 手动加进列表的路径
  for (const item of extras()) {
    const resolved = resolveBin(item, name)
    if (resolved) out.push(resolved)
  }

  // 2. PATH
  for (const dir of pathDirs()) out.push(path.join(dir, exe))

  // 3. 常见安装目录（PATH 被裁剪时的兜底，比如从 Dock 启动的 GUI 进程）
  for (const dir of KNOWN_DIRS[process.platform] || []) out.push(path.join(dir, exe))

  return [...new Set(out)]
}

function versionOf(bin) {
  try {
    const text = execFileSync(bin, ['-version'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const m = String(text).match(/version\s+([^\s]+)/i)
    return m ? m[1] : ''
  } catch (_) {
    return ''
  }
}

function majorOf(version) {
  const n = Number(String(version).replace(/^n/, '').split('.')[0])
  return Number.isFinite(n) ? n : 0
}

function findSystemBinary(name) {
  const skipped = []
  for (const bin of candidatesFor(name)) {
    if (!isExecutable(bin)) continue
    const version = versionOf(bin)
    if (!version) continue
    if (majorOf(version) < MIN_MAJOR) {
      skipped.push({ path: bin, version })
      continue
    }
    return { found: { source: 'system', path: bin, version }, skipped }
  }
  return { found: null, skipped }
}

/**
 * 探测结果（进程内缓存 60s）
 * @param {boolean} force 强制重新探测
 * @returns {{ffmpeg:{source:string,path:string,version:string}, ffprobe:object|null, skipped:Array, at:number}}
 */
function detect(force = false) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL) return cache

  const ff = findSystemBinary('ffmpeg')
  const skipped = [...ff.skipped]
  const pref = preference()

  let ffmpeg = null
  if (pref.mode === 'host') {
    // 用户显式选了「uTools 内置」
    ffmpeg = { source: 'host', path: '', version: '' }
  } else {
    ffmpeg = ff.found
  }
  if (!ffmpeg) {
    // 宿主扩展：路径由 uTools 维护，这里只做展示用标记，调用仍走 utools.runFFmpeg
    ffmpeg = { source: 'host', path: '', version: '' }
  }

  let ffprobe = null
  if (ffmpeg.source === 'system') {
    // 与 ffmpeg 同目录的 ffprobe 优先（brew / 官方静态包都是同目录）
    const sibling = path.join(path.dirname(ffmpeg.path), exeName('ffprobe'))
    if (isExecutable(sibling)) {
      const version = versionOf(sibling)
      if (version) ffprobe = { source: 'system', path: sibling, version }
    }
  }
  if (!ffprobe) {
    const probe = findSystemBinary('ffprobe')
    ffprobe = probe.found
    skipped.push(...probe.skipped)
  }

  cache = { ffmpeg, ffprobe, skipped, at: Date.now() }
  return cache
}

function refresh() {
  return detect(true)
}

/** 给渲染层看的精简信息 */
function summary() {
  const info = detect()
  const pref = preference()

  // 自定义路径被删/改权限后，实际已回退到自动探测 —— 告诉界面一声
  let customInvalid = false
  if (pref.mode === 'custom' && pref.path) {
    const bin = resolveBin(pref.path, 'ffmpeg')
    customInvalid = !(bin && isExecutable(bin))
  }

  return {
    mode: pref.mode,
    customPath: pref.path,
    customInvalid,
    ffmpeg: {
      source: info.ffmpeg.source,
      version: info.ffmpeg.version || '(uTools 内置)',
      path: info.ffmpeg.path || '(uTools 托管)'
    },
    ffprobe: info.ffprobe
      ? { source: info.ffprobe.source, version: info.ffprobe.version, path: info.ffprobe.path }
      : null,
    skipped: info.skipped
  }
}

/**
 * 枚举这台机器上所有能找到的 ffmpeg（设置弹窗用）
 * 每个候选项都跑一次 -version，比较慢，只在打开弹窗时调用
 */
function scan() {
  const items = []
  const seen = new Set()
  const pref = preference()
  const currentPath = ffmpegPath()
  const extraSet = new Set(extras().map((p) => {
    const r = resolveBin(p, 'ffmpeg')
    return r ? path.resolve(r) : ''
  }).filter(Boolean))

  for (const bin of candidatesFor('ffmpeg')) {
    if (!bin) continue
    const abs = path.resolve(bin)
    if (seen.has(abs)) continue
    seen.add(abs)
    if (!isExecutable(bin)) continue

    const version = versionOf(bin)
    const major = majorOf(version)
    const sibling = path.join(path.dirname(bin), exeName('ffprobe'))
    const ffprobe = isExecutable(sibling) ? versionOf(sibling) : ''

    items.push({
      id: abs,
      path: bin,
      dir: path.dirname(bin),
      version: version || '无法识别',
      major,
      usable: Boolean(version) && major >= MIN_MAJOR,
      ffprobe,
      source: 'system',
      extra: extraSet.has(abs),
      custom: pref.mode === 'custom' && pref.path ? abs === path.resolve(resolveBin(pref.path, 'ffmpeg') || '') : false,
      current: Boolean(currentPath) && abs === path.resolve(currentPath)
    })
  }

  // uTools 内置永远在列表里，作为兜底项
  items.push({
    id: 'host',
    path: '',
    dir: '',
    version: 'uTools 内置',
    major: 0,
    usable: true,
    ffprobe: '',
    source: 'host',
    extra: false,
    custom: false,
    current: !currentPath
  })

  return items
}

/** 校验一个路径是不是真能用的 ffmpeg */
function validatePath(target) {
  const raw = String(target || '').trim()
  if (!raw) return { ok: false, error: '请输入路径' }

  let resolved = ''
  try {
    const st = fs.statSync(raw)
    resolved = st.isDirectory() ? path.join(raw, exeName('ffmpeg')) : raw
  } catch (_) {
    return { ok: false, error: '路径不存在' }
  }

  if (!isExecutable(resolved)) return { ok: false, error: '这个路径不是可执行的 ffmpeg' }

  const version = versionOf(resolved)
  if (!version) return { ok: false, error: '无法运行 -version（可能架构不匹配或缺少执行权限）' }
  if (majorOf(version) < MIN_MAJOR) {
    return { ok: false, error: `版本过低（${version}），至少需要 ${MIN_MAJOR}.0` }
  }

  return { ok: true, path: resolved, version }
}

/** 手动添加一条路径到列表（先校验，通过了才存） */
function addExtra(target) {
  const res = validatePath(target)
  if (!res.ok) return res

  const next = [...new Set([...extras(), res.path])]
  extraCache = next
  config.setConfig({ ffmpegExtras: next })
  cache = null
  detect(true)
  return { ...res, items: scan() }
}

function removeExtra(target) {
  const abs = path.resolve(String(target || ''))
  extraCache = extras().filter((p) => path.resolve(p) !== abs)
  config.setConfig({ ffmpegExtras: extraCache })
  cache = null
  detect(true)
  return scan()
}

/** 设置弹窗里点选某一项 */
function setPreference({ mode = 'auto', path: customPath = '' } = {}) {
  const nextMode = mode === 'custom' || mode === 'host' ? mode : 'auto'
  override = { mode: nextMode, path: nextMode === 'custom' ? String(customPath || '') : '' }
  config.setConfig({
    ffmpegMode: nextMode,
    ffmpegPath: override.path
  })
  cache = null
  detect(true)
  return summary()
}

/** 当前该用哪个 ffmpeg：系统路径 / 空字符串表示走宿主 */
function ffmpegPath() {
  const pref = preference()
  if (pref.mode === 'host') return ''

  if (pref.mode === 'custom' && pref.path) {
    const bin = resolveBin(pref.path, 'ffmpeg')
    if (bin && isExecutable(bin)) return bin
    // 自定义路径失效（被删/改权限）就退回自动探测
  }

  const info = detect()
  return info.ffmpeg.source === 'system' ? info.ffmpeg.path : ''
}

function ffprobePath() {
  const bin = ffmpegPath()
  if (bin) {
    const sibling = path.join(path.dirname(bin), exeName('ffprobe'))
    if (isExecutable(sibling)) return sibling
  }
  const info = detect()
  return info.ffprobe ? info.ffprobe.path : ''
}

module.exports = {
  detect,
  refresh,
  summary,
  scan,
  setPreference,
  validatePath,
  addExtra,
  removeExtra,
  preference,
  ffmpegPath,
  ffprobePath,
  isExecutable,
  versionOf
}
