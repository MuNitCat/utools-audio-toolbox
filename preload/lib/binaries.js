'use strict'

/**
 * 二进制探测：优先系统已安装的 ffmpeg（通常更新，且带 ffprobe），
 * 找不到才退回 uTools 宿主内置。
 *
 * 审核要求（必须整改第 2 条）：
 * - setPreference / addExtra 必须统一走 validatePath，且校验「文件名 + -version 输出」确实是 ffmpeg
 * - 不允许只凭 isExecutable 就把任意可执行文件交给 spawn
 *
 * 性能要求（建议整改第 3 条）：探测改成异步 + 并发上限 + 结果缓存，
 * 但 ffmpegPath() 必须保持同步（ffmpeg.js / probe.js 依赖它），所以采用
 * 「同步读缓存快照、异步刷新缓存」的结构。
 *
 * 审核意见（第二版）：每次启动都强制全量跑一遍 `-version` 太浪费。所以探测结论按
 * 「路径 + mtime + size」持久化到 binaries.cache.json（与 config.local.json 同目录）：
 * - 启动只读盘（<1ms），命中就不用起任何子进程；盘缓存超 24h 时后台静默校准一次
 * - 缓存只复用「同一路径同一文件」的已验证结论，命中前必须过文件名白名单 + 可执行位 +
 *   身份三元组（见 trusted），绝不能变成绕过 -version 校验的后门
 * - 不进 dbStorage（绝对路径会随账号同步到别的电脑），本地不可写时退化为纯内存
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const config = require('./config')

const MIN_MAJOR = 4
const CACHE_TTL = 60 * 1000
const SCAN_TTL = 5 * 60 * 1000
/** scan 时同时跑几个 -version，避免一次性拉起二十个进程 */
const SCAN_CONCURRENCY = 4
/** 单个 -version 的超时 */
const VERSION_TIMEOUT = 5000

/** 盘缓存格式版本：不匹配就整份当不存在（不做迁移，直接覆盖重写） */
const CACHE_SCHEMA = 1
const CACHE_FILE = 'binaries.cache.json'
/** 盘缓存超过这个时长就在后台静默复探一次（自愈，不阻塞启动） */
const DISK_STALE = 24 * 60 * 60 * 1000
/** versions 表上限，超出按最后使用时间淘汰 */
const VERSIONS_MAX = 200
/** 盘缓存文件体积上限，超出则丢掉 versions（可重建）只保结论 */
const CACHE_MAX_BYTES = 64 * 1024

/** 探测结果缓存（同步快照来源） */
let cache = null
/** 正在进行的 detect，避免并发重复探测 */
let inflight = null
/** 当前 inflight 是否是强制探测（force=true 不能被普通探测吞掉） */
let inflightForce = false
/** scan 结果缓存 */
let scanCache = null
/** 用户偏好缓存（读配置文件有 IO，不放在每个任务的热路径上） */
let prefCache = null
/** 逐路径的 -version 结果（正结果与负结果共用，负结果也不能每次重跑） */
let versions = {}
/** 上次完整探测的落盘时间，用于 24h 自愈判定 */
let diskAt = 0
/** 写盘失败只提醒一次，避免每轮探测刷日志 */
let warnedWrite = false
/** 身份失效后的延迟复探定时器（批量任务里每个文件都会调 ffmpegPath） */
let redetectTimer = null

const ALLOWED_BASENAMES = new Set(['ffmpeg', 'ffmpeg.exe', 'ffprobe', 'ffprobe.exe'])

/**
 * @param {string} name 逻辑名（ffmpeg / ffprobe）
 * @returns {string} 平台对应的可执行文件名
 */
function exeName(name) {
  return process.platform === 'win32' ? `${name}.exe` : name
}

/**
 * @param {string} target 绝对路径
 * @returns {boolean} 是文件且有执行权限
 */
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

/**
 * 文件身份三元组的后两位：用来判断「缓存里的结论是不是还是这个文件」。
 * @param {string} file 绝对路径
 * @returns {{mtime: number, size: number}|null} 身份；不存在或不是文件时为 null
 */
function identityOf(file) {
  try {
    const st = fs.statSync(file)
    if (!st.isFile()) return null
    return { mtime: Math.round(st.mtimeMs), size: st.size }
  } catch (_) {
    return null
  }
}

/**
 * @returns {string[]} PATH 里的目录
 */
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

/**
 * 用户偏好：auto 自动探测 / custom 指定路径 / host 强制用 uTools 内置。
 * @returns {{mode: 'auto'|'custom'|'host', path: string}}
 */
function preference() {
  if (!prefCache) {
    const cfg = config.getConfig()
    const mode = cfg.ffmpegMode === 'custom' || cfg.ffmpegMode === 'host' ? cfg.ffmpegMode : 'auto'
    prefCache = { mode, path: String(cfg.ffmpegPath || '').trim() }
  }
  return prefCache
}

/** 手动添加的路径（进程内缓存，配置写失败也不至于立刻丢失） */
let extraCache = null

/**
 * @returns {string[]} 手动添加的 ffmpeg 路径
 */
function extras() {
  if (extraCache) return extraCache
  const list = config.getConfig().ffmpegExtras
  extraCache = Array.isArray(list) ? list : []
  return extraCache
}

/**
 * 目录 → 目录下的可执行文件；已经是文件就原样返回。
 * @param {string} target 目录或文件
 * @param {string} name 逻辑名
 * @returns {string} 可执行文件路径；不存在时空字符串
 */
function resolveBin(target, name) {
  if (!target) return ''
  try {
    const st = fs.statSync(target)
    return st.isDirectory() ? path.join(target, exeName(name)) : target
  } catch (_) {
    return ''
  }
}

/**
 * @param {string} name 逻辑名
 * @returns {string[]} 去重后的候选路径（用户指定 → 手动添加 → PATH → 常见目录）
 */
function candidatesFor(name) {
  const exe = exeName(name)
  const out = []

  const pref = preference()
  if (pref.path) {
    const resolved = resolveBin(pref.path, name)
    if (resolved) out.push(resolved)
  }
  for (const item of extras()) {
    const resolved = resolveBin(item, name)
    if (resolved) out.push(resolved)
  }
  for (const dir of pathDirs()) out.push(path.join(dir, exe))
  for (const dir of KNOWN_DIRS[process.platform] || []) out.push(path.join(dir, exe))

  return [...new Set(out)]
}

/**
 * 异步跑 `-version`（不做缓存，缓存逻辑在 runVersionCached）。
 * @param {string} bin 可执行文件
 * @returns {Promise<string>} 输出文本；失败为空字符串
 */
function runVersion(bin) {
  return new Promise((resolve) => {
    execFile(
      bin,
      ['-version'],
      { timeout: VERSION_TIMEOUT, maxBuffer: 64 * 1024, windowsHide: true },
      (err, stdout) => resolve(err ? '' : String(stdout || ''))
    )
  })
}

/**
 * 解析 -version 的横幅。必须匹配行首，防止 `echo "ffmpeg version 9"` 这类伪装。
 * @param {string} text -version 输出
 * @returns {{name: string, version: string, major: number}|null} 解析结果
 */
function parseBanner(text) {
  const m = String(text || '').match(/^(ffmpeg|ffprobe) version (\d+)\.(\d+)(?:\.(\d+))?/m)
  if (!m) return null
  const version = m[4] ? `${m[2]}.${m[3]}.${m[4]}` : `${m[2]}.${m[3]}`
  return { name: m[1], version, major: Number(m[2]) }
}

/**
 * @param {string} version 版本号
 * @returns {number} 主版本；无法解析为 0
 */
function majorOf(version) {
  const n = Number(String(version).replace(/^n/, '').split('.')[0])
  return Number.isFinite(n) ? n : 0
}

/* ------------------------------ 盘缓存 ------------------------------ */

/**
 * @returns {string} 盘缓存文件路径；本机目录不可写时为空字符串
 */
function cacheFilePath() {
  const dir = config.localStateDir()
  return dir ? path.join(dir, CACHE_FILE) : ''
}

/**
 * 缓存条目能否直接采信：文件名在白名单 + 可执行 + mtime/size 与缓存一致。
 * 三条缺一不可——缓存只能加速「同一路径同一文件」的已验证结论。
 * @param {{path?: string, mtime?: number, size?: number}|null} entry 缓存条目
 * @returns {boolean} 可采信为 true
 */
function trusted(entry) {
  if (!entry || !entry.path) return false
  if (!ALLOWED_BASENAMES.has(path.basename(entry.path).toLowerCase())) return false
  if (!isExecutable(entry.path)) return false
  const id = identityOf(entry.path)
  return Boolean(id && id.mtime === entry.mtime && id.size === entry.size)
}

/**
 * 把探测结论压成可落盘的形状（只存系统路径；host 结论不缓存，下次反正只做 stat）。
 * @param {object|null} entry detect 结果里的 ffmpeg / ffprobe
 * @returns {object|null} 可序列化条目
 */
function pickPersist(entry) {
  if (!entry || entry.source !== 'system' || !entry.path) return null
  return {
    source: 'system',
    path: entry.path,
    version: entry.version || '',
    mtime: entry.mtime,
    size: entry.size
  }
}

/**
 * 用盘缓存里的条目还原一个可信的 ffmpeg/ffprobe 结论。
 * @param {object} row 盘缓存里的原始条目
 * @returns {object|null} 结论；不可信时为 null
 */
function pickEntry(row) {
  if (!row || typeof row !== 'object') return null
  if (row.source && row.source !== 'system') return null
  if (typeof row.path !== 'string' || !row.path) return null
  if (!trusted(row)) return null
  return {
    source: 'system',
    path: row.path,
    version: typeof row.version === 'string' ? row.version : '',
    mtime: row.mtime,
    size: row.size
  }
}

/**
 * versions 表超上限时按最后使用时间淘汰。
 * @returns {object} 可序列化的版本表
 */
function trimVersions() {
  const entries = Object.entries(versions)
  if (entries.length <= VERSIONS_MAX) return versions
  entries.sort((a, b) => (b[1] && b[1].at ? b[1].at : 0) - (a[1] && a[1].at ? a[1].at : 0))
  const out = {}
  for (const [key, row] of entries.slice(0, VERSIONS_MAX)) out[key] = row
  return out
}

/**
 * 原子写入盘缓存（tmp + rename）。任何异常都只 warn 一次并退化为纯内存。
 * @returns {boolean} 写成功为 true
 */
function persistCache() {
  const file = cacheFilePath()
  if (!file) return false

  let payload = {
    schema: CACHE_SCHEMA,
    at: cache ? cache.at : diskAt,
    ffmpeg: cache ? pickPersist(cache.ffmpeg) : null,
    ffprobe: cache ? pickPersist(cache.ffprobe) : null,
    skipped: cache && Array.isArray(cache.skipped) ? cache.skipped : [],
    versions: trimVersions()
  }
  let text = JSON.stringify(payload)
  if (text.length > CACHE_MAX_BYTES) {
    payload = { ...payload, versions: {} }
    text = JSON.stringify(payload)
  }

  try {
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, text, 'utf8')
    fs.renameSync(tmp, file)
    return true
  } catch (_) {
    if (!warnedWrite) {
      warnedWrite = true
      console.warn('[utools-audio-toolbox] ffmpeg 探测缓存写入失败，本次退化为内存缓存')
    }
    return false
  }
}

/**
 * 启动时把盘缓存读进内存。命中条件缺一不可：目录可写、schema 匹配、
 * ffmpeg 条目可信（文件名白名单 + 可执行 + 身份一致）、custom 模式路径与配置一致。
 * @returns {boolean} 命中为 true
 */
function hydrateFromDisk() {
  const file = cacheFilePath()
  if (!file) return false

  let raw
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (_) {
    return false
  }
  if (!raw || raw.schema !== CACHE_SCHEMA) return false

  // versions 逐条过形状检查：宁可丢缓存，也不让盘上的文件决定跑哪个可执行文件
  const next = {}
  if (raw.versions && typeof raw.versions === 'object') {
    for (const [bin, row] of Object.entries(raw.versions)) {
      if (!path.isAbsolute(bin) || !row || typeof row !== 'object') continue
      if (!Number.isFinite(row.mtime) || !Number.isFinite(row.size)) continue
      next[bin] = {
        mtime: row.mtime,
        size: row.size,
        version: typeof row.version === 'string' ? row.version : '',
        name: typeof row.name === 'string' ? row.name : '',
        major: Number.isFinite(row.major) ? row.major : 0,
        at: Number.isFinite(row.at) ? row.at : 0
      }
    }
  }
  versions = next

  const pref = preference()
  if (pref.mode === 'host') return false

  const ffmpeg = pickEntry(raw.ffmpeg)
  if (!ffmpeg) return false
  if (pref.mode === 'custom' && pref.path) {
    const want = resolveBin(pref.path, 'ffmpeg')
    if (!want || path.resolve(want) !== path.resolve(ffmpeg.path)) return false
  }

  diskAt = Number.isFinite(raw.at) ? raw.at : 0
  cache = {
    ffmpeg,
    ffprobe: pickEntry(raw.ffprobe),
    skipped: Array.isArray(raw.skipped) ? raw.skipped.filter((s) => s && typeof s.path === 'string') : [],
    // at 取当前时间：盘缓存再老也不该被 60s 内存 TTL 判成过期而立刻重探，
    // 真正的过期判定用 diskAt + DISK_STALE
    at: Date.now(),
    origin: 'disk',
    diskAt
  }
  return true
}

/**
 * 跑（或复用缓存里的）`-version`，并把结果写进 versions 表。
 * 负结果（输出不匹配 / 执行失败）也记成 version:''，否则 `ffmpeg version n7.0`
 * 这类解析不了的构建每次启动都会重跑一遍。
 * @param {string} bin 可执行文件绝对路径
 * @returns {Promise<{name: string, version: string, major: number}|null>} 解析结果；不可用为 null
 */
async function runVersionCached(bin) {
  const id = identityOf(bin)
  if (!id) return null

  const row = versions[bin]
  if (row && row.mtime === id.mtime && row.size === id.size) {
    if (!row.version || !row.name) return null
    return { name: row.name, version: row.version, major: row.major || majorOf(row.version) }
  }

  const banner = parseBanner(await runVersion(bin))
  versions[bin] = {
    mtime: id.mtime,
    size: id.size,
    version: banner ? banner.version : '',
    name: banner ? banner.name : '',
    major: banner ? banner.major : 0,
    at: Date.now()
  }
  return banner
}

/**
 * 顺序找第一个可用的系统二进制（detect 用；命中即返回，不必跑完全部候选）。
 * @param {string} name ffmpeg | ffprobe
 * @returns {Promise<{found: object|null, skipped: Array}>}
 */
async function findSystemBinary(name) {
  const skipped = []
  for (const bin of candidatesFor(name)) {
    if (!isExecutable(bin)) continue
    const banner = await runVersionCached(bin)
    if (!banner || banner.name !== name) continue
    if (banner.major < MIN_MAJOR) {
      skipped.push({ path: bin, version: banner.version })
      continue
    }
    const id = identityOf(bin)
    return {
      found: {
        source: 'system',
        path: bin,
        version: banner.version,
        mtime: id ? id.mtime : 0,
        size: id ? id.size : 0
      },
      skipped
    }
  }
  return { found: null, skipped }
}

/* ------------------------------ 探测 ------------------------------ */

/**
 * 同步快照：只读缓存，绝不触发 IO。缓存没就绪时按「宿主内置」处理（安全降级）。
 * @returns {{ffmpeg: object, ffprobe: object|null, skipped: Array, at: number}}
 */
function snapshot() {
  if (cache) return cache
  return { ffmpeg: { source: 'host', path: '', version: '' }, ffprobe: null, skipped: [], at: 0 }
}

/**
 * @returns {object} host 模式的快照
 */
function hostSnapshot() {
  return { ffmpeg: { source: 'host', path: '', version: '' }, ffprobe: null, skipped: [], at: Date.now() }
}

/**
 * 探测可用的 ffmpeg / ffprobe（异步，带 inflight 去重与 60s 缓存）。
 *
 * force=true **一定**会重新探测：不会被已经在跑的普通探测吞掉（等它结束后再跑一遍）。
 * @param {boolean} [force] 强制重新探测
 * @returns {Promise<{ffmpeg: object, ffprobe: object|null, skipped: Array, at: number}>}
 */
async function detect(force = false) {
  const pref = preference()

  // host 模式短路：不枚举候选、不起子进程（原来会先跑完整探测再丢弃结果）
  if (pref.mode === 'host') {
    cache = { ...hostSnapshot(), origin: 'host' }
    return cache
  }

  // 首次调用先试盘缓存：正常路径是 warmup，但页面的 getBinariesAsync 可能更早
  if (!cache) hydrateFromDisk()
  if (!force && cache && Date.now() - cache.at < CACHE_TTL) return cache

  if (inflight) {
    if (!force || inflightForce) return inflight
    // 已有普通探测在跑：等它结束再强制重跑，避免两套 -version 并发打满进程
    try {
      await inflight
    } catch (_) {}
    // 等待期间可能已有别的强制探测接手，直接复用
    if (inflight) return inflight
  }

  const task = (async () => {
    const ff = await findSystemBinary('ffmpeg')
    const skipped = [...ff.skipped]
    const ffmpeg = ff.found || { source: 'host', path: '', version: '' }

    let ffprobe = null
    if (ffmpeg.source === 'system') {
      const sibling = path.join(path.dirname(ffmpeg.path), exeName('ffprobe'))
      if (isExecutable(sibling)) {
        const banner = await runVersionCached(sibling)
        if (banner && banner.name === 'ffprobe') {
          const id = identityOf(sibling)
          ffprobe = {
            source: 'system',
            path: sibling,
            version: banner.version,
            mtime: id ? id.mtime : 0,
            size: id ? id.size : 0
          }
        }
      }
    }
    if (!ffprobe) {
      const probe = await findSystemBinary('ffprobe')
      ffprobe = probe.found
      skipped.push(...probe.skipped)
    }

    cache = { ffmpeg, ffprobe, skipped, at: Date.now(), origin: 'detect' }
    diskAt = cache.at
    persistCache()
    return cache
  })()

  inflight = task
  inflightForce = force
  try {
    return await task
  } finally {
    if (inflight === task) {
      inflight = null
      inflightForce = false
    }
  }
}

/**
 * 身份失效（文件被删 / Homebrew 升级改了 mtime）后的延迟复探。
 * 批量任务里 ffmpegPath() 会被每个文件调用一次，这里做 5s 去抖。
 * @returns {void} 无返回值
 */
function scheduleRedetect() {
  if (redetectTimer) return
  redetectTimer = setTimeout(() => {
    redetectTimer = null
    detect(true).catch(() => {})
  }, 5000)
  if (typeof redetectTimer.unref === 'function') redetectTimer.unref()
}

/**
 * 启动预热：先同步读盘（<1ms），命中就不起子进程；未命中才异步探测。
 * 盘缓存超过 24h 时仍然先用，随后后台静默校准（runVersionCached 几乎都在命中，开销可忽略）。
 * @returns {void} 无返回值
 */
function warmup() {
  const pref = preference()
  if (pref.mode === 'host') {
    cache = { ...hostSnapshot(), origin: 'host' }
    return
  }
  if (!hydrateFromDisk()) {
    detect(false).catch(() => {})
    return
  }
  if (Date.now() - (cache.diskAt || 0) > DISK_STALE) detect(true).catch(() => {})
}

/**
 * 强制刷新并返回精简信息。
 * @returns {Promise<object>} summary 结构
 */
async function refresh() {
  await detect(true)
  return summary()
}

/**
 * 给渲染层看的精简信息（同步，读缓存快照，不会阻塞）。
 * @returns {object} 版本 / 路径 / 自定义路径是否失效
 */
function summary() {
  const info = snapshot()
  const pref = preference()

  let customInvalid = false
  if (pref.mode === 'custom' && pref.path) {
    const bin = resolveBin(pref.path, 'ffmpeg')
    customInvalid = !(bin && isExecutable(bin))
  }

  return {
    mode: pref.mode,
    customPath: pref.path,
    customInvalid,
    ready: Boolean(cache && cache.ffmpeg),
    ffmpeg: {
      source: info.ffmpeg.source,
      version: info.ffmpeg.version || '(uTools 内置)',
      path: info.ffmpeg.path || '(uTools 托管)'
    },
    ffprobe: info.ffprobe ? { source: info.ffprobe.source, version: info.ffprobe.version, path: info.ffprobe.path } : null,
    skipped: info.skipped
  }
}

/**
 * 异步版 summary：先确保缓存就绪（设置弹窗打开时用）。
 * @returns {Promise<object>} summary 结构
 */
async function summaryAsync() {
  await detect()
  return summary()
}

/**
 * 把数组切成每块 size 个。
 * @param {string[]} list 输入
 * @param {number} size 块大小
 * @returns {string[][]} 分块结果
 */
function chunk(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

/**
 * 枚举这台机器上所有能找到的 ffmpeg（设置弹窗用）。
 * 并发上限 4，结果缓存 5 分钟；每个候选的 `-version` 走 runVersionCached，
 * 文件没变就一次子进程都不起——这是「打开设置弹窗就全量扫」的根治点。
 * @param {boolean} [force] 忽略 5 分钟列表缓存（用户点「重新扫描」）
 * @returns {Promise<object[]>} 可渲染的列表项（最后一项固定是 uTools 内置）
 */
async function scan(force = false) {
  if (!force && scanCache && Date.now() - scanCache.at < SCAN_TTL) return scanCache.items

  const pref = preference()
  const currentPath = ffmpegPath()
  const extraSet = new Set(
    extras()
      .map((p) => {
        const r = resolveBin(p, 'ffmpeg')
        return r ? path.resolve(r) : ''
      })
      .filter(Boolean)
  )

  const seen = new Set()
  const bins = []
  for (const bin of candidatesFor('ffmpeg')) {
    if (!bin) continue
    const abs = path.resolve(bin)
    if (seen.has(abs) || !isExecutable(bin)) continue
    seen.add(abs)
    bins.push({ abs, bin })
  }

  const items = []
  for (const group of chunk(bins, SCAN_CONCURRENCY)) {
    const rows = await Promise.all(
      group.map(async ({ abs, bin }) => {
        const banner = await runVersionCached(bin)
        const sibling = path.join(path.dirname(bin), exeName('ffprobe'))
        const probeBanner = isExecutable(sibling) ? await runVersionCached(sibling) : null
        return {
          id: abs,
          path: bin,
          dir: path.dirname(bin),
          version: banner ? banner.version : '无法识别',
          major: banner ? banner.major : 0,
          usable: Boolean(banner) && banner.name === 'ffmpeg' && banner.major >= MIN_MAJOR,
          ffprobe: probeBanner && probeBanner.name === 'ffprobe' ? probeBanner.version : '',
          source: 'system',
          extra: extraSet.has(abs),
          custom: pref.mode === 'custom' && pref.path ? abs === path.resolve(resolveBin(pref.path, 'ffmpeg') || '') : false,
          current: Boolean(currentPath) && abs === path.resolve(currentPath)
        }
      })
    )
    items.push(...rows)
  }

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

  scanCache = { items, at: Date.now() }
  persistCache()
  return items
}

/**
 * 校验一个路径是不是真能用的 ffmpeg / ffprobe。
 * @param {string} target 文件或所在目录（必须是绝对路径）
 * @param {'ffmpeg'|'ffprobe'} [expected] 期望的程序名
 * @returns {Promise<{ok: true, path: string, version: string, major: number}|{ok: false, error: string}>}
 */
async function validatePath(target, expected = 'ffmpeg') {
  const raw = String(target || '').trim()
  if (!raw) return { ok: false, error: '请输入路径' }
  if (!path.isAbsolute(raw)) return { ok: false, error: '请填绝对路径（例如 /usr/local/bin/ffmpeg）' }

  let resolved = raw
  try {
    const st = fs.statSync(raw)
    resolved = st.isDirectory() ? path.join(raw, exeName(expected)) : raw
  } catch (_) {
    return { ok: false, error: '路径不存在' }
  }

  // 文件名白名单：挡住把任意可执行文件改个名之外的所有情况
  const base = path.basename(resolved).toLowerCase()
  if (!ALLOWED_BASENAMES.has(base)) {
    return { ok: false, error: `文件名必须是 ffmpeg 或 ffprobe（当前 ${path.basename(resolved)}）` }
  }
  if (!isExecutable(resolved)) return { ok: false, error: '这个路径不是可执行文件' }

  const banner = parseBanner(await runVersion(resolved))
  if (!banner || banner.name !== expected) {
    return { ok: false, error: '这个文件不是 ffmpeg 程序（-version 输出不匹配）' }
  }
  if (banner.major < MIN_MAJOR) {
    return { ok: false, error: `版本过低（${banner.version}），至少需要 ${MIN_MAJOR}.0` }
  }
  return { ok: true, path: resolved, version: banner.version, major: banner.major }
}

/**
 * 手动添加一条路径（先校验，通过才存进本机配置）。
 * @param {string} target 文件或目录
 * @returns {Promise<{ok: boolean, error?: string, path?: string, version?: string, items?: object[]}>}
 */
async function addExtra(target) {
  const res = await validatePath(target, 'ffmpeg')
  if (!res.ok) return res

  const next = [...new Set([...extras(), res.path])]
  extraCache = next
  config.setLocal({ ffmpegExtras: next })
  prefCache = null
  cache = null
  scanCache = null
  // 新加的路径必须重新跑一次 -version，不能沿用同名同 mtime 的旧结论
  delete versions[res.path]
  await detect(true)
  return { ...res, items: await scan(true) }
}

/**
 * 从列表移除一条路径。
 * @param {string} target 路径
 * @returns {Promise<object[]>} 更新后的 scan 列表
 */
async function removeExtra(target) {
  const abs = path.resolve(String(target || ''))
  extraCache = extras().filter((p) => path.resolve(p) !== abs)
  config.setLocal({ ffmpegExtras: extraCache })
  prefCache = null
  cache = null
  scanCache = null
  await detect(true)
  persistCache()
  return scan(true)
}

/**
 * 设置弹窗里点选某一项。custom 模式必须先通过 validatePath，失败不写配置。
 * @param {{mode?: 'auto'|'custom'|'host', path?: string}} pref 选择
 * @returns {Promise<{ok: boolean, error?: string, mode?: string, customPath?: string} & object>} summary（失败时带 ok:false）
 */
async function setPreference(pref = {}) {
  const mode = pref.mode === 'custom' || pref.mode === 'host' ? pref.mode : 'auto'
  let customPath = ''

  if (mode === 'custom') {
    const res = await validatePath(pref.path, 'ffmpeg')
    if (!res.ok) return { ok: false, error: res.error }
    customPath = res.path
  }

  if (!prefCache) prefCache = preference()
  prefCache = { mode, path: customPath }
  config.setLocal({ ffmpegMode: mode, ffmpegPath: customPath })
  cache = null
  scanCache = null
  await detect(true)
  return { ok: true, ...summary() }
}

/**
 * 当前该用哪个 ffmpeg：返回系统路径，空字符串表示走宿主。
 * 保持同步：ffmpeg.js / probe.js 在同步上下文里调用它。
 * @returns {string} 可执行文件路径或空字符串
 */
function ffmpegPath() {
  const pref = preference()
  if (pref.mode === 'host') return ''

  if (pref.mode === 'custom' && pref.path) {
    const bin = resolveBin(pref.path, 'ffmpeg')
    // 设置时已校验过；这里只复核文件还在、名字还是 ffmpeg
    if (bin && isExecutable(bin) && ALLOWED_BASENAMES.has(path.basename(bin).toLowerCase())) return bin
    // 自定义路径失效（被删/改权限）就退回自动探测
  }

  const info = snapshot()
  if (info.ffmpeg.source === 'system') {
    // 盘缓存可能跨过了 Homebrew 升级：命中前复核同路径同 mtime/size，失效按未命中处理
    if (trusted(info.ffmpeg)) return info.ffmpeg.path
    scheduleRedetect()
    return quickPathProbe('ffmpeg')
  }

  // 缓存还没就绪（刚启动、异步探测尚未返回）：做一次纯 fs 的快速探测，
  // 只查 PATH 与常见目录里有没有 ffmpeg 可执行文件，不跑 -version（保持同步契约）
  return quickPathProbe('ffmpeg')
}

/**
 * 同步快速探测：只查文件是否存在且可执行，不执行任何子进程。
 * @param {string} name ffmpeg | ffprobe
 * @returns {string} 可执行文件路径；找不到时空字符串
 */
function quickPathProbe(name) {
  for (const bin of candidatesFor(name)) {
    if (isExecutable(bin)) return bin
  }
  return ''
}

/**
 * @returns {string} ffprobe 路径；没有则空字符串（probe 会退回解析 ffmpeg 的 stderr）
 */
function ffprobePath() {
  const bin = ffmpegPath()
  if (bin) {
    const sibling = path.join(path.dirname(bin), exeName('ffprobe'))
    if (isExecutable(sibling)) return sibling
  }
  const info = snapshot()
  if (info.ffmpeg.source === 'system' && info.ffprobe && info.ffprobe.source === 'system') {
    return trusted(info.ffprobe) ? info.ffprobe.path : ''
  }
  return ''
}

/**
 * 让测试能重置进程内缓存。
 * @returns {void} 无返回值
 */
function reset() {
  cache = null
  inflight = null
  inflightForce = false
  scanCache = null
  prefCache = null
  extraCache = null
  versions = {}
  diskAt = 0
  if (redetectTimer) {
    clearTimeout(redetectTimer)
    redetectTimer = null
  }
}

module.exports = {
  detect,
  refresh,
  summary,
  summaryAsync,
  scan,
  setPreference,
  validatePath,
  addExtra,
  removeExtra,
  preference,
  ffmpegPath,
  ffprobePath,
  isExecutable,
  parseBanner,
  warmup,
  hydrateFromDisk,
  persistCache,
  trusted,
  cacheFilePath,
  reset
}

// 启动预热：先读盘缓存，命中就不起子进程（异步，不阻塞模块加载）。
// 测试用 AUDIO_BATCH_NO_WARMUP=1 关掉，避免在 await 间隙真跑一轮 PATH 探测。
if (process.env.AUDIO_BATCH_NO_WARMUP !== '1') {
  setTimeout(warmup, 0)
}
