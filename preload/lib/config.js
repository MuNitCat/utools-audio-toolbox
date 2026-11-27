'use strict'

/**
 * 配置读写。
 *
 * 审核意见：ffmpegPath / ffmpegMode / ffmpegExtras / outputDir 这类**与本机绑定的绝对路径**
 * 不能写进 utools.dbStorage（会随账号同步到别的电脑，路径全部失效，还可能被云端值影响）。
 * 用户输入（artistHistory）同理不该上云。因此这里把配置拆成两半：
 * - 同步（dbStorage）：跨设备有意义、且不含用户内容的偏好（输出模式、后缀、响度目标、主题、侧栏勾选…）
 * - 本机（本地 json）：ffmpeg 路径、自定义输出目录、常用艺术家
 *
 * 读取时合并成一个对象返回，前端不需要关心来源。
 *
 * 审核意见（第二版）：渲染层传进来的对象不能整份合并进同步库。所以键名、类型、体积
 * 全部收口到下面的 `SYNC_SCHEMA` / `LOCAL_SCHEMA`：
 * - 写入：未登记的键、类型/取值不合法、超长字符串一律丢弃；整份超过 8KB 直接拒写
 * - 读取：同一套键表再归正一次，把老版本或云端同步下来的畸形值挡在合并之前
 * 两张表是配置键的**唯一来源**，加字段必须同时改表和 `DEFAULTS`（config.test.mjs 会断言）。
 */

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

const KEY = 'utools-audio-toolbox:config'
const LOCAL_FILE = 'config.local.json'
/**
 * 本机配置格式版本。v2：丢弃 v1 可能由老版本渲染层任意写入的 outputDir
 * （见 upgradeLocal / migrate 的说明）。
 */
const LOCAL_VERSION = 2

/** 同步库单次写入的体积上限（JSON 字节数）：配置是偏好不是数据库 */
const MAX_SYNC_BYTES = 8 * 1024
/** 一次 patch 允许的键数上限，挡住「塞几千个键刷库」 */
const MAX_PATCH_KEYS = 32
/** 标识符类键（功能 id / 分组 id）的格式 */
const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/
/** 文件名非法字符：suffix 含这些字符时整值拒绝（真正的清洗在 src/core/paths.js） */
const BAD_NAME_RE = /[/\\:*?"<>|\u0000-\u001f]/

const DEFAULTS = {
  outputMode: 'sibling',
  outputDir: '',
  suffix: '',
  overwrite: false,
  concurrency: 2,
  lastFeature: 'convert',
  lastGroup: 'A',
  targetLufs: -18,
  truePeak: -3,
  lra: 11,
  /** 自定义 ffmpeg 路径（目录或可执行文件）；留空则自动探测 */
  ffmpegPath: '',
  /** 'auto' 自动探测 | 'custom' 用 ffmpegPath | 'host' 强制 uTools 内置 */
  ffmpegMode: 'auto',
  /** 用户手动添加进列表的 ffmpeg 路径（已校验可执行） */
  ffmpegExtras: [],
  /** 最近用过的艺术家，最多 5 个，最新的在前。只存本机（用户输入不上云） */
  artistHistory: [],
  /** 侧边栏里被取消勾选的功能 id（只是不显示，功能本身仍可用）。 */
  hiddenFeatures: ['visualize'],
  theme: 'light'
}

/**
 * 同步库（dbStorage）允许的键。
 * 只放「跨设备有意义、且不含用户内容」的偏好：主题、输出模式、并行数、侧栏勾选…
 * **用户输入（artistHistory）与绝对路径一律不进来**，见下面的 LOCAL_SCHEMA。
 *
 * type 语义：bool 布尔；int/number 数值（越界**夹取**，老云端值优雅降级）；
 * enum 枚举；string 字符串（带 max / bad / absolute 约束）；id 标识符格式；
 * stringList 字符串数组（逐项校验，非法项丢弃）。
 *
 * ⚠️ 两处历史上踩过的坑，改动前先看：
 * - outputMode 必须列全 src/core/output.js 的四个值，漏掉 downloads/desktop 会把输出位置打回同级
 * - theme 必须含 auto（App.jsx 用 cfg.theme || 'auto'，store 的 THEMES 也含 auto）
 */
const SYNC_SCHEMA = {
  outputMode: { type: 'enum', values: ['sibling', 'downloads', 'desktop', 'custom'] },
  suffix: { type: 'string', max: 64, bad: BAD_NAME_RE },
  overwrite: { type: 'bool' },
  concurrency: { type: 'int', min: 1, max: 4 },
  lastFeature: { type: 'id' },
  lastGroup: { type: 'id' },
  targetLufs: { type: 'number', min: -70, max: 0 },
  truePeak: { type: 'number', min: -9, max: 0 },
  lra: { type: 'number', min: 1, max: 50 },
  hiddenFeatures: { type: 'stringList', max: 32, itemMax: 32, pattern: ID_RE },
  theme: { type: 'enum', values: ['auto', 'light', 'dark'] }
}

/**
 * 本机文件允许的键：绝对路径（跨设备必然失效）+ 用户输入（不该上云）。
 * artistHistory 是用户输入过的艺术家名，只留在本机，不随账号同步。
 */
const LOCAL_SCHEMA = {
  outputDir: { type: 'string', max: 1024, absolute: true },
  ffmpegPath: { type: 'string', max: 1024, absolute: true },
  ffmpegMode: { type: 'enum', values: ['auto', 'custom', 'host'] },
  ffmpegExtras: { type: 'stringList', max: 16, itemMax: 1024, absolute: true },
  artistHistory: { type: 'stringList', max: 5, itemMax: 64 }
}

/** 只允许存本机的键：直接由 LOCAL_SCHEMA 推导，避免两份清单漂移 */
const LOCAL_KEYS = Object.keys(LOCAL_SCHEMA)

/**
 * 迁移时允许从同步库搬到本机的键。**outputDir 不在其中**：
 * 老版本的 setConfig 不校验路径，同步库里的这个值无法证明来自用户手势，
 * 而启动时会拿它恢复写白名单（审核意见 #2），所以宁可丢弃让用户重选。
 * artistHistory 老版本存在云端，搬回本机后从同步库里删掉（用户要求：只在本地）。
 */
const MIGRATE_KEYS = ['ffmpegPath', 'ffmpegMode', 'ffmpegExtras', 'artistHistory']

/** 本机文件的缓存：目录只用探测一次 */
let localCache = { dir: '', file: '', available: false, ready: false }

/**
 * @param {*} value 任意值
 * @returns {boolean} 纯数据对象（非数组 / 非 null / 非类实例）为 true
 */
function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * 按 UTF-8 字节数衡量体积，用于同步库的 8KB 额度。
 * @param {*} value 可 JSON 序列化的值
 * @returns {number} 字节数；无法序列化时为 0
 */
function byteLength(value) {
  const text = JSON.stringify(value)
  if (!text) return 0
  return typeof Buffer !== 'undefined' ? Buffer.byteLength(text, 'utf8') : text.length
}

/**
 * 按键表校验并归正一个值。
 * @param {object} spec 键表条目
 * @param {*} raw 原始值
 * @returns {*} 合格值；不合格返回 undefined（调用方丢弃该键 / 回落到默认值）
 */
function normalizeValue(spec, raw) {
  if (!spec) return undefined
  switch (spec.type) {
    case 'bool':
      return typeof raw === 'boolean' ? raw : undefined
    case 'int':
    case 'number': {
      // 只接受数字或非空数字串：`Number(true)` 也能得 1，不能让类型错悄悄变成合法值
      if (typeof raw !== 'number' && !(typeof raw === 'string' && raw.trim() !== '')) return undefined
      const n = Number(raw)
      if (!Number.isFinite(n)) return undefined
      const value = spec.type === 'int' ? Math.round(n) : n
      if (spec.min !== undefined && value < spec.min) return spec.min
      if (spec.max !== undefined && value > spec.max) return spec.max
      return value
    }
    case 'enum':
      return spec.values.includes(raw) ? raw : undefined
    case 'id':
      return typeof raw === 'string' && ID_RE.test(raw) ? raw : undefined
    case 'string': {
      if (typeof raw !== 'string' || raw.length > spec.max) return undefined
      if (spec.bad && spec.bad.test(raw)) return undefined
      // 空串是合法值（表示「跟随源文件」或「自动探测」），只有非空时才要求绝对路径
      if (spec.absolute && raw && !path.isAbsolute(raw)) return undefined
      return raw
    }
    case 'stringList': {
      if (!Array.isArray(raw)) return undefined
      const out = []
      for (const item of raw) {
        if (out.length >= spec.max) break
        if (typeof item !== 'string' || !item || item.length > spec.itemMax) continue
        if (spec.pattern && !spec.pattern.test(item)) continue
        if (spec.absolute && !path.isAbsolute(item)) continue
        if (!out.includes(item)) out.push(item)
      }
      return out
    }
    default:
      return undefined
  }
}

/**
 * 从原始对象里挑出键表内的合法键。
 *
 * 遍历的是**键表**而不是入参，因此 `__proto__` / `constructor` 这类键根本没有被取值的路径，
 * 老版本遗留在库里的未知键也不会被带回来。
 * @param {object} raw 原始对象
 * @param {object} schema 键表（SYNC_SCHEMA / LOCAL_SCHEMA）
 * @returns {object} 只含合法键的副本
 */
function pickValid(raw, schema) {
  const out = {}
  if (!isPlainObject(raw)) return out
  for (const key of Object.keys(schema)) {
    if (!Object.prototype.hasOwnProperty.call(raw, key)) continue
    const value = normalizeValue(schema[key], raw[key])
    if (value !== undefined) out[key] = value
  }
  return out
}

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
 * 找一个可写的本机配置目录。依次尝试 userData / appData / 系统临时目录。
 * 刻意**不往家目录**写隐藏目录（早期版本在 `~/` 下建过配置目录，已移除）：未经告知在用户家目录建目录，
 * 属于审核会追问的隐私问题，代价只是极端环境下配置可能落到临时目录。
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
      if (appData) candidates.push(path.join(appData, 'utools-audio-toolbox'))
    }
  } catch (_) {}
  candidates.push(path.join(os.tmpdir(), 'utools-audio-toolbox-state'))

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
 * @returns {string} 本机状态目录（与 config.local.json 同目录）；不可写时为空字符串
 */
function localStateDir() {
  const local = resolveLocal()
  return local.available ? local.dir : ''
}

/**
 * 本机配置版本升级：v1 时代 outputDir 可能是老版本渲染层任意写入的（setConfig 当年不校验），
 * 而启动时会拿它恢复写白名单——等于让一个无法证明来源的路径长期持有写权限。
 * 升到 v2 时一律丢掉 outputDir，用户重新选一次即可；ffmpeg 三键不受影响。
 * @param {object} raw 本机配置原始对象
 * @returns {object} 归正后的副本（不落盘，下次写入时自然升级）
 */
function upgradeLocal(raw) {
  const next = raw && typeof raw === 'object' ? { ...raw } : {}
  if (next.version && next.version !== LOCAL_VERSION) {
    delete next.outputDir
    next.version = LOCAL_VERSION
  }
  return next
}

/**
 * 本机配置目录全不可写时的会话内兜底。
 * 绝不再写进 dbStorage：那会把 outputDir / ffmpegPath 这些绝对路径同步到账号，
 * 正是审核要求避免的。代价只是这种极端环境下重启会丢设置。
 */
let memoryLocal = null

/**
 * @returns {object} 本机配置原始对象；读不到或损坏时为空对象
 */
function readLocalRaw() {
  const local = resolveLocal()
  if (!local.available) return upgradeLocal(memoryLocal || {})
  try {
    const text = fs.readFileSync(local.file, 'utf8')
    const raw = JSON.parse(text)
    return raw && typeof raw === 'object' ? upgradeLocal(raw) : {}
  } catch (_) {
    return {}
  }
}

/**
 * 原子写入本机配置（tmp + rename）。本地不可写时只留在内存，**不退回同步库**。
 * @param {object} next 完整本机配置
 * @returns {boolean} 落盘成功为 true；降级到内存时返回 false（仅表示「本次会话有效」）
 */
function writeLocalRaw(next) {
  // 落盘只写键表内的合法值：调用方传什么都不会把畸形值写进本地文件
  const payload = { version: LOCAL_VERSION, ...pickValid(next, LOCAL_SCHEMA) }
  const local = resolveLocal()
  if (!local.available) {
    memoryLocal = payload
    return false
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
 * 读取同步库**原始**对象。
 *
 * 这里刻意不做归正：`migrate()` 依赖它还能看到老版本写进同步库的 ffmpeg* 键，
 * 一旦把归正下沉进本函数，`hasLegacy` 永远为 false，老用户的 ffmpeg 路径会被丢掉。
 * 归正只在 `getConfig()` 的合并前发生。
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
 * 一次性迁移：老版本把 ffmpeg 三键、outputDir、artistHistory 写进了同步库。
 * 这里把**可证明来源**的键搬到本机文件，并从同步库删掉整组本机键。
 *
 * - `ffmpeg*` / `artistHistory`：搬到本机（用户要求艺术家历史只在本地，别再上云）
 * - 本机已有的键不覆盖：云端旧值不该盖掉本机新值
 * - `outputDir` 永不搬：老版本 setConfig 不校验路径，这个值无法证明来自用户手势，
 *   而启动时会拿它恢复写白名单（审核意见 #2），宁可丢弃让用户重选
 *
 * 不再用「本机文件已有 version 就跳过」的早退：artistHistory 是后加的迁移项，
 * 已经迁移过一次的用户同步库里仍然留着它，必须再清一次。
 * @returns {void} 无返回值
 */
function migrate() {
  const sync = readSyncRaw()
  const legacy = LOCAL_KEYS.filter((k) => sync[k] !== undefined)
  if (!legacy.length) return
  const local = readLocalRaw()

  const moved = { ...local }
  let movedAny = false
  for (const key of legacy) {
    if (!MIGRATE_KEYS.includes(key) || moved[key] !== undefined) continue
    moved[key] = sync[key]
    movedAny = true
  }
  // 没有可搬的键就别写盘：降级环境下 writeLocalRaw 会退回同步库，白写一次没有意义
  if (movedAny) writeLocalRaw(moved)

  // 搬完之后同步库只保留键表内的合法键，历史脏键顺带清掉（含不迁移的 outputDir）
  const rest = { ...sync }
  for (const key of LOCAL_KEYS) delete rest[key]
  const s = storage()
  if (s) {
    try {
      s.setItem(KEY, pickValid(rest, SYNC_SCHEMA))
    } catch (_) {}
  }
}

/**
 * 读配置（同步库 + 本机文件合并）。首次调用会做一次迁移。
 * @returns {object} 完整配置；本机文件不可用时带 `_localDegraded: true`
 */
function getConfig() {
  migrate()
  // 两侧都按键表归正：老版本或云端同步下来的畸形值在这里被吃掉，回落到 DEFAULTS
  const sync = pickValid(readSyncRaw(), SYNC_SCHEMA)
  const local = pickValid(readLocalRaw(), LOCAL_SCHEMA)
  const merged = { ...DEFAULTS, ...sync, ...local }
  if (!resolveLocal().available) merged._localDegraded = true
  return merged
}

/**
 * 写配置。渲染层传入的对象先过键表再入库：
 * - 未登记的键、类型/取值不合法、超长字符串一律丢弃，不污染同步库
 * - 合并后超过 8KB 整份拒写（不做部分写入，避免库里出现半份配置）
 * - ffmpeg* 只能经 setLocal 由 binaries 内部修改，渲染层无权指定可执行文件
 * @param {object} patch 增量
 * @returns {object} 更新后的完整配置
 */
function setConfig(patch) {
  // 1. 先迁移：下面会用「只含键表键」的快照整份覆盖同步库，
  //    不先搬走 legacy 的绝对路径键，它们会被静默抹掉
  migrate()

  // 2. 形状检查：非纯对象或键数超限就整份拒绝，不猜调用方意图
  if (!isPlainObject(patch)) {
    if (patch !== undefined && patch !== null) console.warn('[utools-audio-toolbox] setConfig 被拒绝：参数不是纯对象')
    return getConfig()
  }
  if (Object.keys(patch).length > MAX_PATCH_KEYS) {
    console.warn(`[utools-audio-toolbox] setConfig 被拒绝：键数超过 ${MAX_PATCH_KEYS}`)
    return getConfig()
  }

  // 3. 本机键分流：outputDir / artistHistory 过类型校验后走 setLocal；
  //    ffmpeg* 只能由 binaries 内部写（AGENTS.md #20），这里静默剥离
  const localPatch = pickValid(patch, LOCAL_SCHEMA)
  delete localPatch.ffmpegPath
  delete localPatch.ffmpegMode
  delete localPatch.ffmpegExtras

  // 4. 同步键白名单
  const incoming = pickValid(patch, SYNC_SCHEMA)

  // 5. 合并后整体体积检查：超限整份拒写，保持库里的对象自洽
  const merged = { ...pickValid(readSyncRaw(), SYNC_SCHEMA), ...incoming }
  if (byteLength(merged) > MAX_SYNC_BYTES) {
    console.warn(`[utools-audio-toolbox] setConfig 被拒绝：同步配置超过 ${MAX_SYNC_BYTES} 字节`)
    return getConfig()
  }

  // 6. 落库（整份覆盖，历史脏键顺带清掉），再写本机文件
  const s = storage()
  if (s && Object.keys(incoming).length) {
    try {
      s.setItem(KEY, merged)
    } catch (_) {}
  }
  if (Object.keys(localPatch).length) setLocal(localPatch)
  return getConfig()
}

/**
 * 写本机配置（ffmpeg 路径 / 自定义输出目录）。仅 preload 内部调用，不挂到桥接层。
 * @param {object} patch 只接受 LOCAL_KEYS 里的键，非法值不覆盖旧值
 * @returns {object} 更新后的本机配置
 */
function setLocal(patch) {
  const next = { ...readLocalRaw(), ...pickValid(patch, LOCAL_SCHEMA) }
  writeLocalRaw(next)
  return next
}

/**
 * 让测试能重置目录探测缓存（真实运行不需要）。
 * @returns {void} 无返回值
 */
function reset() {
  localCache = { dir: '', file: '', available: false, ready: false }
  memoryLocal = null
}

module.exports = {
  getConfig,
  setConfig,
  setLocal,
  DEFAULTS,
  LOCAL_KEYS,
  SYNC_SCHEMA,
  LOCAL_SCHEMA,
  localStateDir,
  reset
}
