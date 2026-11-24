'use strict'

/**
 * preload 桥接层：唯一出口 window.audioServices
 * 原则：只暴露编排级接口，不暴露 fs / path / child_process 裸对象，
 *      也不把 ffmpeg 进程对象交给渲染层。
 *
 * 安全边界（对应市场审核意见）：
 * - 所有接受路径的方法先过 guard（会话级白名单：只认用户选择 / 拖入 / 文件关联得到的路径）
 * - run / runCapture 的参数先过 argswhitelist（默认拒绝未登记 flag）
 * - 删除与覆盖只允许「本次会话产出」与插件临时目录
 * - 打开外链只允许 ffmpeg 下载相关站点
 */

const { probe, probeMany } = require('./lib/probe')
const fpm = require('./lib/ffmpeg')
const binaries = require('./lib/binaries')
const previewer = require('./lib/previewer')
const fsx = require('./lib/fsx')
const exts = require('./lib/exts')
const guard = require('./lib/guard')
const { getConfig, setConfig } = require('./lib/config')

const VERSION = '1.4.2'

/** 允许 openExternal 打开的站点（与设置页硬编码的三个下载地址对应） */
const EXTERNAL_HOSTS = new Set(['evermeet.cx', 'www.evermeet.cx', 'gyan.dev', 'www.gyan.dev', 'ffmpeg.org', 'www.ffmpeg.org'])
/** getPath 允许的约定名 */
const PATH_NAMES = new Set(['home', 'desktop', 'documents', 'downloads', 'pictures', 'music', 'videos', 'userData', 'appData', 'temp', 'logs', 'exe'])

function utoolsApi() {
  return (typeof window !== 'undefined' ? window.utools : globalThis.utools) || {}
}

/**
 * @param {string} name getPath 的约定名
 * @returns {string} 系统目录；不可用时空字符串
 */
function safeGetPath(name) {
  const api = utoolsApi()
  try {
    return api.getPath ? api.getPath(name) || '' : ''
  } catch (_) {
    return ''
  }
}

/**
 * 把渲染层拖入的 File 还原成绝对路径，并登记为已授权。
 * Electron 32+ 移除了 File.path，退回 webUtils。
 * @param {File} file 拖入的文件对象
 * @returns {string} 绝对路径；取不到时空字符串
 */
function pathForFile(file) {
  if (!file) return ''
  let p = ''
  try {
    if (typeof file.path === 'string' && file.path) p = file.path
  } catch (_) {}
  if (!p) {
    try {
      const { webUtils } = require('electron')
      if (webUtils && typeof webUtils.getPathForFile === 'function') p = webUtils.getPathForFile(file) || ''
    } catch (_) {}
  }
  if (p) guard.grantPaths([p])
  return p
}

/**
 * 打开文件选择框。返回的路径全部登记为已授权。
 * @param {{title?: string, filters?: Array<{name: string, extensions: string[]}>}} [opts]
 * @returns {string[]} 选中的绝对路径
 */
function chooseFiles(opts = {}) {
  const api = utoolsApi()
  if (typeof api.showOpenDialog !== 'function') return []
  const filters = Array.isArray(opts.filters) && opts.filters.length
    ? opts.filters
        .filter((f) => f && Array.isArray(f.extensions))
        .slice(0, 8)
        .map((f) => ({
          name: String(f.name || '文件').slice(0, 40),
          extensions: f.extensions
            .map((e) => String(e).trim())
            .filter((e) => e === '*' || /^[a-z0-9]{1,8}$/i.test(e))
            .slice(0, 40)
        }))
        .filter((f) => f.extensions.length)
    : [
        { name: '音频', extensions: exts.AUDIO_EXTS },
        { name: '视频', extensions: exts.VIDEO_EXTS },
        { name: '全部文件', extensions: ['*'] }
      ]
  const res = api.showOpenDialog({
    title: String(opts.title || '选择音频 / 视频文件').slice(0, 80),
    filters: filters.length ? filters : [{ name: '全部文件', extensions: ['*'] }],
    properties: ['openFile', 'multiSelections']
  })
  const list = Array.isArray(res) ? res.filter((p) => typeof p === 'string' && p) : []
  if (list.length) guard.grantPaths(list)
  return list
}

/**
 * 选择目录。返回值登记为可写目录。
 * @param {string} [title] 对话框标题
 * @returns {string} 目录绝对路径；取消时空字符串
 */
function chooseDir(title = '选择输出目录') {
  const api = utoolsApi()
  if (typeof api.showOpenDialog !== 'function') return ''
  const res = api.showOpenDialog({
    title: String(title).slice(0, 80),
    properties: ['openDirectory', 'createDirectory']
  })
  const dir = Array.isArray(res) && res.length ? res[0] : ''
  if (dir) guard.grantDir(dir)
  return dir
}

/**
 * 从宿主的进入事件里取出文件路径。
 * 只认 files / over（文件关联、拖到主输入框），文本类 payload 一律忽略——
 * 否则「输入框里的文本恰好是个路径」也会被当成授权依据。
 * @param {object} action 宿主传给 onPluginEnter 的 action
 * @returns {string[]} 绝对路径列表
 */
function enterPathsOf(action) {
  if (!action || (action.type !== 'files' && action.type !== 'over')) return []
  const raw = Array.isArray(action.payload) ? action.payload : [action.payload]
  return raw.map((p) => (p && typeof p.path === 'string' ? p.path : '')).filter(Boolean)
}

/** 页面订阅回调（同一时刻只有一个，页面重新挂载会覆盖） */
let enterListener = null
/** 页面还没订阅时先存着，订阅时补发一次，避免「事件早于 React 挂载」丢文件 */
let pendingEnter = []

/**
 * 把一批已授权的路径交给页面。
 * @param {string[]} list 绝对路径
 * @returns {void}
 */
function deliverEnter(list) {
  if (typeof enterListener !== 'function') return
  try {
    enterListener(list.slice())
  } catch (err) {
    console.warn('[audio-batch] onEnterFiles 回调异常：', (err && err.message) || err)
  }
}

/**
 * 宿主「进入插件」回调：登记白名单 + 转发给页面。
 *
 * 为什么整个插件只有这里注册 onPluginEnter：宿主实现是
 * `onPluginEnter: (e) => { window.utools.__event__.onPluginEnter = e }`——**单槽赋值**，
 * 后注册的直接覆盖先注册的。preload 与页面各注册一次的话，两者只有一个会收到事件：
 * 要么 preload 拿不到 payload（授权失效，文件加不进来），要么页面拿不到（列表不更新）。
 * 所以由 preload 独占监听并转发，页面只能用 onEnterFiles 订阅，不要自己再调宿主接口。
 * @param {object} action 宿主事件
 * @returns {void}
 */
function handlePluginEnter(action) {
  const list = enterPathsOf(action)
  if (!list.length) return
  guard.grantPaths(list)
  if (typeof enterListener === 'function') deliverEnter(list)
  else pendingEnter = list
}

/**
 * 页面订阅「带文件进入插件」。preload 是宿主事件的唯一监听者，这里只做转发。
 * @param {(paths: string[]) => void} cb 收到路径时的回调
 * @returns {() => void} 取消订阅
 */
function onEnterFiles(cb) {
  if (typeof cb !== 'function') return () => {}
  enterListener = cb
  if (pendingEnter.length) {
    const list = pendingEnter
    pendingEnter = []
    deliverEnter(list)
  }
  return () => {
    if (enterListener === cb) enterListener = null
  }
}

/**
 * 在文件管理器中定位。只允许已授权/已产出的路径。
 * @param {string} target 绝对路径
 * @returns {boolean} 是否真的打开了
 */
function openInFolder(target) {
  const res = guard.assertOpen(target)
  if (!res.ok) {
    console.warn('[audio-batch] openInFolder 被拒绝：', res.message)
    return false
  }
  const api = utoolsApi()
  if (typeof api.shellShowItemInFolder === 'function') api.shellShowItemInFolder(res.path)
  return true
}

/**
 * 用默认程序打开文件。只允许已授权/已产出的**文件**。
 * @param {string} target 绝对路径
 * @returns {boolean} 是否真的打开了
 */
function openPath(target) {
  const res = guard.assertOpen(target)
  if (!res.ok || res.kind !== 'file') {
    console.warn('[audio-batch] openPath 被拒绝：', (res && res.message) || '不是文件')
    return false
  }
  const api = utoolsApi()
  if (typeof api.shellOpenPath === 'function') api.shellOpenPath(res.path)
  return true
}

/**
 * 打开外链。仅 https + 白名单主机（防止被用来触发任意协议）。
 * @param {string} url 待打开的链接
 * @returns {boolean} 是否真的打开了
 */
function openExternal(url) {
  const raw = String(url || '').trim()
  if (!raw || raw.length > 512) return false
  let u
  try {
    u = new URL(raw)
  } catch (_) {
    return false
  }
  if (u.protocol !== 'https:') return false
  if (u.username || u.password) return false
  if (u.port && u.port !== '443') return false
  const host = u.hostname.toLowerCase().replace(/\.$/, '')
  if (!EXTERNAL_HOSTS.has(host)) return false
  const api = utoolsApi()
  if (typeof api.shellOpenExternal !== 'function') return false
  api.shellOpenExternal(u.href)
  return true
}

/**
 * 单个文件探测。未授权直接抛错（GUI 路径会 catch 显示）。
 * @param {string} file 绝对路径
 * @returns {Promise<object>} probe 结果
 * @throws {Error} 路径未授权时抛出
 */
async function probeOne(file) {
  const res = guard.assertReadFile(file)
  if (!res.ok) throw Object.assign(new Error(res.message), { code: res.code })
  return probe(res.path)
}

/**
 * 批量探测。逐个容错：未授权的文件返回带 error 的结果，不影响其它文件。
 * @param {string[]} files 绝对路径数组
 * @param {(info: object, index: number, total: number) => void} [onOne] 每完成一个回调
 * @returns {Promise<object[]>} 与入参一一对应的探测结果
 */
async function probeManyGuarded(files, onOne) {
  const list = Array.isArray(files) ? files : []
  const out = []
  for (const file of list) {
    const res = guard.assertReadFile(file)
    let info
    if (!res.ok) {
      const name = String(file || '').split(/[\\/]/).pop() || ''
      info = { ok: false, path: String(file || ''), name, error: res.message, denied: true }
    } else {
      try {
        info = await probe(res.path)
      } catch (err) {
        info = { ok: false, path: res.path, name: res.path.split(/[\\/]/).pop(), error: (err && err.message) || '探测失败' }
      }
    }
    out.push(info)
    if (typeof onOne === 'function') onOne(info, out.length - 1, list.length)
  }
  return out
}

/**
 * 即时预览：读已授权文件，输出固定落在插件临时目录，尺寸做夹取。
 * @param {{input: string, kind?: string, width?: number, height?: number, seconds?: number, duration?: number, mode?: string, token?: string}} opts
 * @returns {Promise<object>} 预览结果
 * @throws {Error} 输入未授权时抛出
 */
async function renderPreviewGuarded(opts = {}) {
  const res = guard.assertReadFile(opts.input)
  if (!res.ok) throw new Error(res.message)
  const clamp = (v, min, max, fallback) => {
    const n = Math.round(Number(v))
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback
  }
  return previewer.render({
    ...opts,
    input: res.path,
    kind: opts.kind === 'waveform' ? 'waveform' : 'spectrum',
    width: clamp(opts.width, 320, 4096, 1280),
    height: clamp(opts.height, 200, 2160, 640)
  })
}

/**
 * 通知（截断超长正文）。
 * @param {string} body 正文
 * @returns {void} 无返回值
 */
function notify(body) {
  const api = utoolsApi()
  if (typeof api.showNotification === 'function') api.showNotification(String(body || '').slice(0, 500))
}

/**
 * 复制文本（截断 1MB）。
 * @param {string} text 文本
 * @returns {boolean} 是否成功
 */
function copyText(text) {
  const api = utoolsApi()
  const value = String(text || '')
  if (value.length > 1024 * 1024) return false
  if (typeof api.copyText === 'function') return api.copyText(value)
  return false
}

/**
 * 取系统目录。名字必须来自白名单枚举，并把目录登记为可写。
 * @param {string} name home / desktop / downloads 等
 * @returns {string} 绝对路径；不可用时空字符串
 */
function getPath(name) {
  const key = String(name || '')
  if (!PATH_NAMES.has(key)) return ''
  const dir = safeGetPath(key)
  if (dir) guard.grantDir(dir)
  return dir
}

window.audioServices = {
  version: VERSION,

  /** 前端能力探测：旧 preload 没有这个字段，前端据此降级 */
  caps: { guard: 1, asyncBinaries: 1, enterFiles: 1 },

  // 探测
  probe: probeOne,
  probeMany: probeManyGuarded,

  // 执行（参数白名单在 lib/ffmpeg.js 的 run/capture 入口统一校验）
  run: fpm.run,
  runCapture: fpm.capture,
  cancelTask: (id) => (/^[a-zA-Z0-9:_-]{1,64}$/.test(String(id || '')) ? fpm.cancel(String(id)) : false),
  isRunning: (id) => (/^[a-zA-Z0-9:_-]{1,64}$/.test(String(id || '')) ? fpm.isRunning(String(id)) : false),

  // 频谱/波形即时预览（临时文件，不落到素材目录）
  renderPreview: renderPreviewGuarded,

  // 扩展名常量（页面用它拼对话框过滤条件）
  // 输出命名规则不在这里：唯一实现是前端 src/core/paths.js，preload 不再留旧副本。
  AUDIO_EXTS: exts.AUDIO_EXTS,
  VIDEO_EXTS: exts.VIDEO_EXTS,
  MEDIA_EXTS: exts.MEDIA_EXTS,

  // 文件与目录
  exists: fsx.exists,
  isDir: fsx.isDir,
  removeFile: fsx.removeFile,
  renameFile: fsx.renameFile,
  makeTempText: fsx.makeTempText,
  cleanupTemp: fsx.cleanupTemp,
  tempDir: fsx.tempDir,
  listMedia: fsx.listMedia,
  coverDataUrl: fsx.coverDataUrl,

  // 白名单：**不提供任何「写白名单」的接口**。授权只发生在 preload 内部的用户手势里
  // （pathForFile / chooseFiles / chooseDir / getPath / 宿主 payload），页面无权发放通行证。
  // checkDir 只读校验，用来在 MCP 里提前拒绝未授权的输出目录。
  checkDir: (dir) => guard.assertWriteDir(dir),
  /** 订阅「带文件进入插件」（文件关联 / 拖到主输入框），路径已由 preload 授权 */
  onEnterFiles,

  // 配置
  getConfig,
  setConfig,

  // 二进制（优先系统 ffmpeg，其次 uTools 内置）
  // getBinaries 保持同步（读缓存快照），旧前端不会因为改成 Promise 而崩
  getBinaries: () => binaries.summary(),
  /** 异步版：确保探测缓存就绪后再返回（首次打开设置弹窗用） */
  getBinariesAsync: () => binaries.summaryAsync(),
  /** 强制重新探测，返回 Promise<summary> */
  refreshBinaries: () => binaries.refresh(),
  /** 设置弹窗：列出机器上所有可用的 ffmpeg（异步，结果缓存 5 分钟） */
  scanBinaries: (force) => binaries.scan(Boolean(force)),
  /** 设置弹窗：切换用哪个（custom 会先校验路径与版本，失败返回 {ok:false}） */
  setFfmpegPreference: (pref) => binaries.setPreference(pref || {}),
  /** 设置弹窗：手动添加路径到列表（会先校验文件名、可执行性与版本） */
  addFfmpegPath: (target) => binaries.addExtra(target),
  removeFfmpegPath: (target) => binaries.removeExtra(target),

  // 系统
  platform: () => process.platform,
  pathForFile,
  chooseFiles,
  chooseDir,
  openInFolder,
  openPath,
  openExternal,
  notify,
  copyText,
  getPath,
  getDownloadsPath: () => safeGetPath('downloads')
}

// 启动时无条件授权：临时目录 + 下载/桌面（输出位置的三个默认来源）+ 配置里的自定义输出目录
for (const dir of [fsx.tempDir(), safeGetPath('downloads'), safeGetPath('desktop')]) {
  if (dir) guard.grantDir(dir)
}
try {
  const cfg = getConfig()
  if (cfg && cfg.outputDir) guard.grantDir(cfg.outputDir)
} catch (_) {}

// 宿主 onPluginEnter 是单槽赋值，整个插件只在这里注册；页面通过 onEnterFiles 订阅。
// 必须在模块加载时就注册：preload 先于页面脚本执行，晚注册会被页面覆盖（或漏掉首次事件）。
const hostApi = utoolsApi()
if (typeof hostApi.onPluginEnter === 'function') hostApi.onPluginEnter(handlePluginEnter)

console.log(`[audio-batch] preload v${VERSION} ready`)
