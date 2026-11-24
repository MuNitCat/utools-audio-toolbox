'use strict'

/**
 * 配置读写。
 *
 * 审核意见：ffmpegPath / ffmpegMode / ffmpegExtras / outputDir 这类**与本机绑定的绝对路径**
 * 不能写进 utools.dbStorage（会随账号同步到别的电脑，路径全部失效，还可能被云端值影响）。
 * 因此这里把配置拆成两半：
 * - 同步（dbStorage）：跨设备有意义的偏好（输出模式、后缀、响度目标、主题、侧栏勾选…）
 * - 本机（本地 json）：ffmpeg 路径、自定义输出目录
 *
 * 读取时合并成一个对象返回，前端不需要关心来源。
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const KEY = 'audio-batch:config'
/** 降级时把本机键塞进同步库的备用键（仅在本地文件不可写时使用） */
const LOCAL_KEY = 'audio-batch:config:local'
const LOCAL_FILE = 'config.local.json'
const LOCAL_VERSION = 1

/** 只允许存本机的键：绝对路径，跨设备必然失效 */
const LOCAL_KEYS = ['ffmpegPath', 'ffmpegMode', 'ffmpegExtras', 'outputDir']

const DEFAULTS = {
  outputMode: 'sibling',
  outputDir: '',
  suffix: '',
  overwrite: false,
  concurrency: 2,
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
  /** 侧边栏里被取消勾选的功能 id（只是不显示，功能本身仍可用）。 */
  hiddenFeatures: ['visualize'],
  theme: 'light'
}

/** 本机文件的缓存：目录只用探测一次 */
let localCache = { dir: '', file: '', available: false, ready: false }

/**
 * @returns {object} uTools 宿主对象
 */
function utoolsApi() {
  return (typeof window !== 'undefined' ? window.utools : globalThis.utools) || {}
}

/**
 * @returns {object|null} dbStorage 实例；宿主没提供时为 null
 */
function storage() {
  const api = utoolsApi()
  return api.dbStorage || null
}

/**
 * @param {string} dir 目录
 * @returns {boolean} 可读写为 true
 */
function probeDir(dir) {
  if (!dir) return false
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, '.probe')
    fs.writeFileSync(probe, '1')
    fs.rmSync(probe, { force: true })
    try {
      fs.chmodSync(dir, 0o700)
    } catch (_) {}
    return true
  } catch (_) {
    return false
  }
}

/**
 * 找一个可写的本机配置目录。依次尝试 userData / appData / home / 系统临时目录。
 * @returns {{dir: string, file: string, available: boolean}} 探测结果（结果缓存）
 */
function resolveLocal() {
  if (localCache.ready) return localCache
  const api = utoolsApi()
  const candidates = []
  try {
    if (typeof api.getPath === 'function') {
      candidates.push(api.getPath('userData') || '')
      const appData = api.getPath('appData') || ''
      if (appData) candidates.push(path.join(appData, 'audio-batch'))
    }
  } catch (_) {}
  candidates.push(path.join(os.homedir(), '.audio-batch'))
  candidates.push(path.join(os.tmpdir(), 'audio-batch-state'))

  for (const dir of candidates) {
    if (probeDir(dir)) {
      localCache = { dir, file: path.join(dir, LOCAL_FILE), available: true, ready: true }
      return localCache
    }
  }
  localCache = { dir: '', file: '', available: false, ready: true }
  return localCache
}

/**
 * @returns {object} 本机配置原始对象；读不到或损坏时为空对象
 */
function readLocalRaw() {
  const local = resolveLocal()
  if (!local.available) {
    const s = storage()
    try {
      const raw = s ? s.getItem(LOCAL_KEY) : null
      return raw && typeof raw === 'object' ? raw : {}
    } catch (_) {
      return {}
    }
  }
  try {
    const text = fs.readFileSync(local.file, 'utf8')
    const raw = JSON.parse(text)
    return raw && typeof raw === 'object' ? raw : {}
  } catch (_) {
    return {}
  }
}

/**
 * 原子写入本机配置（tmp + rename）。本地不可写时退回同步库，保证功能不中断。
 * @param {object} next 完整本机配置
 * @returns {boolean} 是否写成功
 */
function writeLocalRaw(next) {
  const payload = { version: LOCAL_VERSION }
  for (const key of LOCAL_KEYS) payload[key] = next[key]
  const local = resolveLocal()
  if (!local.available) {
    const s = storage()
    try {
      if (s) s.setItem(LOCAL_KEY, payload)
      return Boolean(s)
    } catch (_) {
      return false
    }
  }
  try {
    const tmp = `${local.file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    fs.renameSync(tmp, local.file)
    return true
  } catch (_) {
    return false
  }
}

/**
 * @returns {object} 同步库原始对象；损坏时为空对象
 */
function readSyncRaw() {
  const s = storage()
  if (!s) return {}
  try {
    const raw = s.getItem(KEY)
    return raw && typeof raw === 'object' ? raw : {}
  } catch (_) {
    return {}
  }
}

/**
 * 把表单残值里的路径类键剥掉（coverPath 之类不该进同步库）。
 * @param {object} params 参数对象
 * @returns {object} 清洗后的副本
 */
function sanitizeParams(params) {
  if (!params || typeof params !== 'object') return {}
  const out = {}
  for (const [k, v] of Object.entries(params)) {
    if (/(path|dir)$/i.test(k)) continue
    out[k] = v
  }
  return out
}

/**
 * @param {object} raw 任意对象
 * @returns {object} 只保留本机键的子集
 */
function pickLocal(raw) {
  const out = {}
  for (const key of LOCAL_KEYS) {
    if (raw && raw[key] !== undefined) out[key] = raw[key]
  }
  return out
}

/**
 * 一次性迁移：老版本把 ffmpeg 三键与 outputDir 写进了同步库，这里搬到本机文件并删掉同步里的副本。
 * @returns {void} 无返回值
 */
function migrate() {
  const sync = readSyncRaw()
  const hasLegacy = LOCAL_KEYS.some((k) => sync[k] !== undefined)
  if (!hasLegacy) return
  const local = readLocalRaw()
  if (local && local.version) return

  const moved = { ...local }
  for (const key of LOCAL_KEYS) {
    if (sync[key] !== undefined) moved[key] = sync[key]
  }
  writeLocalRaw(moved)

  const rest = { ...sync }
  for (const key of LOCAL_KEYS) delete rest[key]
  const s = storage()
  if (s) {
    try {
      s.setItem(KEY, rest)
    } catch (_) {}
  }
}

/**
 * 读配置（同步库 + 本机文件合并）。首次调用会做一次迁移。
 * @returns {object} 完整配置；本机文件不可用时带 `_localDegraded: true`
 */
function getConfig() {
  migrate()
  const sync = readSyncRaw()
  const local = readLocalRaw()
  const merged = { ...DEFAULTS, ...sync, ...pickLocal(local) }
  merged.params = sanitizeParams(merged.params)
  if (!resolveLocal().available) merged._localDegraded = true
  return merged
}

/**
 * 写配置。ffmpeg* 与 outputDir 会被剥离：它们只能通过 setLocal 修改，
 * 避免渲染层绕开校验直接指定可执行文件。
 * @param {object} patch 增量
 * @returns {object} 更新后的完整配置
 */
function setConfig(patch) {
  const incoming = { ...(patch || {}) }
  const localPatch = {}

  for (const key of ['ffmpegPath', 'ffmpegMode', 'ffmpegExtras']) delete incoming[key]
  if (incoming.outputDir !== undefined) {
    localPatch.outputDir = incoming.outputDir
    delete incoming.outputDir
  }
  if (incoming.params) incoming.params = sanitizeParams(incoming.params)

  const s = storage()
  if (s && Object.keys(incoming).length) {
    try {
      s.setItem(KEY, { ...readSyncRaw(), ...incoming })
    } catch (_) {}
  }
  if (Object.keys(localPatch).length) setLocal(localPatch)
  return getConfig()
}

/**
 * 写本机配置（ffmpeg 路径 / 自定义输出目录）。仅 preload 内部调用，不挂到桥接层。
 * @param {object} patch 只接受 LOCAL_KEYS 里的键
 * @returns {object} 更新后的本机配置
 */
function setLocal(patch) {
  const next = { ...readLocalRaw(), ...pickLocal(patch || {}) }
  writeLocalRaw(next)
  return next
}

module.exports = { getConfig, setConfig, setLocal, DEFAULTS, LOCAL_KEYS }
