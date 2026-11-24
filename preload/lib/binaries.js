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

/** 探测结果缓存（同步快照来源） */
let cache = null
/** 正在进行的 detect，避免并发重复探测 */
let inflight = null
/** scan 结果缓存 */
let scanCache = null
/** 用户偏好缓存（读配置文件有 IO，不放在每个任务的热路径上） */
let prefCache = null

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
 * 异步跑 `-version`。
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

/**
 * 顺序找第一个可用的系统二进制（detect 用；命中即返回，不必跑完全部候选）。
 * @param {string} name ffmpeg | ffprobe
 * @returns {Promise<{found: object|null, skipped: Array}>}
 */
async function findSystemBinary(name) {
  const skipped = []
  for (const bin of candidatesFor(name)) {
    if (!isExecutable(bin)) continue
    const banner = parseBanner(await runVersion(bin))
    if (!banner || banner.name !== name) continue
    if (banner.major < MIN_MAJOR) {
      skipped.push({ path: bin, version: banner.version })
      continue
    }
    return { found: { source: 'system', path: bin, version: banner.version }, skipped }
  }
  return { found: null, skipped }
}

/**
 * 同步快照：只读缓存，绝不触发 IO。缓存没就绪时按「宿主内置」处理（安全降级）。
 * @returns {{ffmpeg: object, ffprobe: object|null, skipped: Array, at: number}}
 */
function snapshot() {
  if (cache) return cache
  return { ffmpeg: { source: 'host', path: '', version: '' }, ffprobe: null, skipped: [], at: 0 }
}

/**
 * 探测可用的 ffmpeg / ffprobe（异步，带 inflight 去重与 60s 缓存）。
 * @param {boolean} [force] 强制重新探测
 * @returns {Promise<{ffmpeg: object, ffprobe: object|null, skipped: Array, at: number}>}
 */
async function detect(force = false) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL) return cache
  if (inflight) return inflight

  inflight = (async () => {
    const ff = await findSystemBinary('ffmpeg')
    const skipped = [...ff.skipped]
    const pref = preference()

    let ffmpeg = pref.mode === 'host' ? null : ff.found
    if (!ffmpeg) ffmpeg = { source: 'host', path: '', version: '' }

    let ffprobe = null
    if (ffmpeg.source === 'system') {
      const sibling = path.join(path.dirname(ffmpeg.path), exeName('ffprobe'))
      if (isExecutable(sibling)) {
        const banner = parseBanner(await runVersion(sibling))
        if (banner && banner.name === 'ffprobe') ffprobe = { source: 'system', path: sibling, version: banner.version }
      }
    }
    if (!ffprobe) {
      const probe = await findSystemBinary('ffprobe')
      ffprobe = probe.found
      skipped.push(...probe.skipped)
    }

    cache = { ffmpeg, ffprobe, skipped, at: Date.now() }
    return cache
  })()

  try {
    return await inflight
  } finally {
    inflight = null
  }
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
    ready: Boolean(cache),
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
 * 并发上限 4，结果缓存 5 分钟（点「重新扫描」才强制刷新）。
 * @param {boolean} [force] 忽略缓存
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
        const banner = parseBanner(await runVersion(bin))
        const sibling = path.join(path.dirname(bin), exeName('ffprobe'))
        const probeBanner = isExecutable(sibling) ? parseBanner(await runVersion(sibling)) : null
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
  if (info.ffmpeg.source === 'system') return info.ffmpeg.path

  // 缓存还没就绪（刚启动、异步探测尚未返回）：做一次纯 fs 的快速探测，
  // 只查 PATH 与常见目录里有没有 ffmpeg 可执行文件，不跑 -version（保持同步契约）
  const quick = quickPathProbe('ffmpeg')
  return quick
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
  if (info.ffmpeg.source === 'system' && info.ffprobe && info.ffprobe.source === 'system') return info.ffprobe.path
  return ''
}

/**
 * 让测试能重置进程内缓存。
 * @returns {void} 无返回值
 */
function reset() {
  cache = null
  inflight = null
  scanCache = null
  prefCache = null
  extraCache = null
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
  reset
}

// 启动时预热一次，避免第一次任务因为缓存空而退回宿主（异步，不阻塞）
setTimeout(() => {
  detect(true).catch(() => {})
}, 0)
