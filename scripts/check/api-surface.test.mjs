/**
 * preload 对外接口面（window.audioServices）的断言脚本。
 *
 * 目的：锁死「页面不能自己往白名单里写路径」这件事。
 * 审核标准 2.2 明确点名「授权白名单能被页面自己写入也算」违规，历史版本曾在
 * preload 暴露过 grantPaths / grantDir，等于给页面发通行证的接口。这里用三条断言兜住：
 *   1. 这两个具体名字不存在
 *   2. 任何以 grant 开头的导出都不存在（防止换个名字加回来）
 *   3. 导出键集合必须与 EXPECTED_KEYS 逐字相同（新增接口必须显式登记 → 强制 review）
 *
 * 另附「文件关联进入」的行为断言：路径由 preload 在 onPluginEnter 里授权并转发，
 * 页面只能订阅、不能授权。
 *
 * 直接 node scripts/check/api-surface.test.mjs 运行，不依赖测试框架。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const require = createRequire(import.meta.url)

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'surface-test-'))
process.env.HOME = root
process.env.USERPROFILE = root
// 关掉 binaries 的启动预热：断言只关心接口面，不该在加载时真跑一轮 -version
process.env.AUDIO_BATCH_NO_WARMUP = '1'

const work = path.join(root, 'work')
const outside = path.join(root, 'outside')
const tempDir = path.join(root, 'tmp')
const deskDir = path.join(root, 'desk')
for (const d of [work, outside, tempDir, deskDir]) fs.mkdirSync(d, { recursive: true })

const enterFile = path.join(work, 'enter.wav')
const enterFile2 = path.join(work, 'enter2.wav')
const foreign = path.join(outside, 'foreign.wav')
for (const f of [enterFile, enterFile2, foreign]) fs.writeFileSync(f, 'x')

/** 宿主 onPluginEnter 是单槽赋值：这里用同一个槽模拟，能复现「后注册覆盖先注册」 */
let hostEnterCb = null

global.window = {
  utools: {
    dbStorage: { getItem: () => null, setItem: () => {} },
    getPath: (name) => (name === 'desktop' ? deskDir : name === 'downloads' ? tempDir : root),
    getPluginTempPath: () => tempDir,
    onPluginEnter: (cb) => {
      hostEnterCb = cb
    }
  }
}

const api = require('../../preload/index.js') && global.window.audioServices
const guard = require('../../preload/lib/guard.js')

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => (cond ? (pass += 1) : fails.push(`${name}${detail ? ' → ' + String(detail).slice(0, 300) : ''}`))

/** probe 的错误码：未授权是 EREAD_DENIED，授权后就算 ffmpeg 报错也不会是这个码 */
const probeCode = async (file) => {
  try {
    await api.probe(file)
    return ''
  } catch (err) {
    return (err && err.code) || (err && err.message) || 'unknown'
  }
}

/* ---------------------- 1. 接口面：页面没有写白名单的能力 ---------------------- */

ok('preload 加载', Boolean(api && api.version), 'audioServices 为空')
ok('caps.enterFiles', Boolean(api && api.caps && api.caps.enterFiles === 1))

ok('grantPaths 不在页面上', api && typeof api.grantPaths === 'undefined', typeof (api || {}).grantPaths)
ok('grantDir 不在页面上', api && typeof api.grantDir === 'undefined', typeof (api || {}).grantDir)

const grantish = Object.keys(api || {}).filter((k) => /grant|allow|authorize|whitelist|permit/i.test(k))
ok('没有任何 grant/allow/authorize 类导出', grantish.length === 0, grantish.join(','))

/** 导出面快照：加接口会在这里失败，确认过没引入授权入口后再补进列表 */
const EXPECTED_KEYS = [
  'AUDIO_EXTS',
  'MEDIA_EXTS',
  'VIDEO_EXTS',
  'addFfmpegPath',
  'cancelProbe',
  'cancelTask',
  'caps',
  'checkDir',
  'chooseDir',
  'chooseFiles',
  'cleanupTemp',
  'copyText',
  'coverDataUrl',
  'exists',
  'getBinaries',
  'getBinariesAsync',
  'getConfig',
  'getDownloadsPath',
  'getPath',
  'isDir',
  'isRunning',
  'listMedia',
  'makeConcatList',
  'notify',
  'onEnterFiles',
  'openExternal',
  'openInFolder',
  'openPath',
  'pathForFile',
  'platform',
  'probe',
  'probeMany',
  'refreshBinaries',
  'removeFfmpegPath',
  'removeFile',
  'renameFile',
  'renderPreview',
  'run',
  'runCapture',
  'scanBinaries',
  'setConfigGuarded',
  'setFfmpegPreference',
  'tempDir',
  'version'
].sort()

const actualKeys = Object.keys(api || {}).sort()
const missing = EXPECTED_KEYS.filter((k) => !actualKeys.includes(k))
const extra = actualKeys.filter((k) => !EXPECTED_KEYS.includes(k))
ok('导出面与快照一致', missing.length === 0 && extra.length === 0, `缺少 [${missing.join(',')}] 多出 [${extra.join(',')}]`)

/* ------------------ 1b. 输出目录只写：写授权不等于可读 ------------------ */
// 审核意见：getPath('desktop') 曾把桌面同时登记为可读，页面能 listMedia 递归枚举整个桌面

const desk = api.getPath('desktop')
ok('getPath("desktop") 返回路径', desk === deskDir, String(desk))
ok('桌面被登记为可写目录', api.checkDir(desk).ok === true, JSON.stringify(api.checkDir(desk)))
fs.writeFileSync(path.join(desk, 'leak.wav'), 'x')
const deskList = api.listMedia(desk, { recursive: true })
ok('桌面不可被枚举', Array.isArray(deskList) && deskList.length === 0, JSON.stringify(deskList))
ok('桌面里的文件不可被 probe', (await probeCode(path.join(desk, 'leak.wav'))) === 'EREAD_DENIED', await probeCode(path.join(desk, 'leak.wav')))
ok('未列入白名单的名字仍返回空串', api.getPath('home') === '' && api.getPath('documents') === '')

/* -------------------------- 2. 文件关联进入：授权 + 转发 -------------------------- */

ok('preload 注册了宿主进入事件', typeof hostEnterCb === 'function')

// 事件先于页面订阅：preload 必须自己授权，并把路径暂存
if (typeof hostEnterCb === 'function') hostEnterCb({ code: 'utools-audio-toolbox', type: 'files', payload: [{ isFile: true, path: enterFile }] })
ok('未订阅时也已完成授权', (await probeCode(enterFile)) !== 'EREAD_DENIED')

// addPaths 的第一步就是 probeMany，denied 标记是界面报「未授权」的来源
const manyOk = await api.probeMany([enterFile])
ok('probeMany 未标记 denied', manyOk[0] && manyOk[0].denied !== true, JSON.stringify(manyOk[0] && manyOk[0].error))

const got = []
const off = api.onEnterFiles((paths) => got.push(paths))
ok('订阅时补发暂存的路径', got.length === 1 && got[0][0] === enterFile, JSON.stringify(got))

// 事件晚于订阅：直接转发，不重复补发
if (typeof hostEnterCb === 'function') hostEnterCb({ code: 'utools-audio-toolbox', type: 'files', payload: [{ isFile: false, path: enterFile2 }] })
ok('订阅后实时收到', got.length === 2 && got[1][0] === enterFile2, JSON.stringify(got))
ok('第二次进入的路径已授权', (await probeCode(enterFile2)) !== 'EREAD_DENIED')

// 文本类 payload 不能当授权依据（否则输入框里随手贴个路径就成了通行证）
if (typeof hostEnterCb === 'function') hostEnterCb({ code: 'utools-audio-toolbox', type: 'text', payload: foreign })
ok('text payload 不授权', (await probeCode(foreign)) === 'EREAD_DENIED', await probeCode(foreign))

const manyDenied = await api.probeMany([foreign])
ok('probeMany 对未授权路径标记 denied', manyDenied[0] && manyDenied[0].denied === true, JSON.stringify(manyDenied[0]))

/* ---------------------- 2b. 批量探测的契约（并发改造后不能变） ---------------------- */

// MCP 的 mcp.js 依赖 `infos[i]` 与入参对齐，结果必须同序等长
// 注意：授权路径会经 guard 解析成 realpath（macOS 的 /var → /private/var），比对要用同一形态
const enterReal = fs.realpathSync(enterFile)
const orderedA = await api.probeMany([foreign, enterFile])
ok(
  'probeMany 同序等长（未授权在前）',
  orderedA.length === 2 && orderedA[0].path === foreign && orderedA[1].path === enterReal,
  JSON.stringify(orderedA.map((o) => o.path))
)

const orderedB = await api.probeMany([enterFile, foreign])
ok(
  'probeMany 同序等长（未授权在后）',
  orderedB.length === 2 && orderedB[0].path === enterReal && orderedB[1].path === foreign,
  JSON.stringify(orderedB.map((o) => o.path))
)

// 第 2 参传对象时视为 options：mcp.js 只传数组，新签名不能把这类调用搞崩
const withJob = await api.probeMany([enterFile], { jobId: 'surfacetest1' })
ok('probeMany(files, {jobId}) 兼容', Array.isArray(withJob) && withJob.length === 1 && withJob[0].path === enterReal)

// 取消入口只认 jobId：未知 id、路径、对象一律 false，不能借它做别的事
ok('caps.probeCancel', Boolean(api.caps && api.caps.probeCancel === 1))
ok('cancelProbe 是函数', typeof api.cancelProbe === 'function')
ok('cancelProbe 对未知 jobId 返回 false', api.cancelProbe('nope') === false)
ok('cancelProbe 拒绝路径形态与对象', api.cancelProbe('../etc/passwd') === false && api.cancelProbe({ jobId: 'x' }) === false)

// 取消订阅后不再收到，但授权仍然有效（授权与订阅解耦）
off()
if (typeof hostEnterCb === 'function') hostEnterCb({ code: 'utools-audio-toolbox', type: 'files', payload: [{ path: path.join(work, 'third.wav') }] })
ok('退订后不再回调', got.length === 2, String(got.length))

/* --------------------------- 3. 页面不能反向写白名单 --------------------------- */

// 页面能调的接口里没有任何一个能让 outside 变成可写目录
ok('outside 目录不可写', !guard.assertWriteDir(outside).ok)
const writeMethods = Object.keys(api || {}).filter((k) => typeof api[k] === 'function')
ok('接口面里没有能授权 outside 的入口', writeMethods.every((k) => k !== 'grantPaths' && k !== 'grantDir'), writeMethods.join(','))

fs.rmSync(root, { recursive: true, force: true })

console.log(`\n通过 ${pass} 项`)
if (fails.length) {
  console.log(`失败 ${fails.length} 项：`)
  for (const f of fails) console.log('  ✗', f)
  process.exit(1)
}
console.log('✓ preload 接口面检查通过')
