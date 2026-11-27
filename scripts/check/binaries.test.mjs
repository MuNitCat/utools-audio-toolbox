/**
 * binaries 校验的断言脚本：确保任意可执行文件不能冒充 ffmpeg，
 * 并锁住探测缓存的安全边界（缓存只能复用「同路径同 mtime/size」的已验证结论）。
 * 用临时 HOME，避免配置模块往真实用户目录写文件。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'binaries-test-'))
process.env.HOME = root
process.env.USERPROFILE = root
// 关掉模块加载时的预热：否则它会在 await 让出的间隙真跑一轮 PATH 探测，用例结果随机
process.env.AUDIO_BATCH_NO_WARMUP = '1'

const require = createRequire(import.meta.url)

/** 造一个可执行的假程序 */
function fakeBin(name, body) {
  const file = path.join(root, name)
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`)
  fs.chmodSync(file, 0o755)
  return file
}

const notFfmpeg = fakeBin('ffmpeg', 'echo "hello"')
const oldFfmpeg = fakeBin('ffmpeg-old', 'echo "ffmpeg version 3.4"')
fs.renameSync(oldFfmpeg, path.join(root, 'ffmpeg-old'))
const oldAsFfmpeg = path.join(root, 'ffmpeg-old')
fs.copyFileSync(oldAsFfmpeg, path.join(root, 'ffmpeg3'))
fs.renameSync(path.join(root, 'ffmpeg3'), path.join(root, 'ffmpeg3'))
const oldVersion = (() => {
  const f = path.join(root, 'oldffmpeg')
  fs.mkdirSync(f)
  const bin = path.join(f, 'ffmpeg')
  fs.writeFileSync(bin, '#!/bin/sh\necho "ffmpeg version 3.4.13"\n')
  fs.chmodSync(bin, 0o755)
  return bin
})()
const fakeProbeDir = path.join(root, 'probe')
fs.mkdirSync(fakeProbeDir)
const fakeProbe = path.join(fakeProbeDir, 'ffprobe')
fs.writeFileSync(fakeProbe, '#!/bin/sh\necho "ffprobe version 6.1.1"\n')
fs.chmodSync(fakeProbe, 0o755)

/** 记录同步库写入的键，用来断言盘缓存没有走 dbStorage */
const dbWrites = []
global.window = {
  utools: {
    dbStorage: {
      getItem: () => null,
      setItem: (k) => dbWrites.push(k),
      removeItem: () => {}
    },
    // 本机目录固定到临时 userData：config 不再往家目录兜底
    getPath: (name) => path.join(root, name)
  }
}
const binaries = require('../../preload/lib/binaries.js')

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => (cond ? (pass += 1) : fails.push(`${name}${detail ? ' → ' + detail : ''}`))

// 1. 非 ffmpeg 文件名
const r1 = await binaries.validatePath('/bin/sh')
ok('/bin/sh 被拒（文件名）', !r1.ok && /文件名/.test(r1.error), r1.error)

// 2. 名叫 ffmpeg 但输出不对
const r2 = await binaries.validatePath(notFfmpeg)
ok('假 ffmpeg 被拒（-version 不匹配）', !r2.ok && /不是 ffmpeg/.test(r2.error), r2.error)

// 3. 版本过低
const r3 = await binaries.validatePath(oldVersion)
ok('低版本被拒', !r3.ok && /版本过低/.test(r3.error), r3.error)

// 4. 目录输入：拼 ffmpeg 后校验
const r4 = await binaries.validatePath(path.join(root, 'nope'))
ok('不存在的目录被拒', !r4.ok, r4.error)

// 5. 正常的 ffprobe（预期名 ffprobe）
const r5 = await binaries.validatePath(fakeProbeDir, 'ffprobe')
ok('ffprobe 通过', r5.ok && r5.version === '6.1.1', r5.error)

// 6. 相对路径直接拒
const r6 = await binaries.validatePath('ffmpeg')
ok('相对路径被拒', !r6.ok && /绝对路径/.test(r6.error), r6.error)

// 7. setPreference 必须走校验：/bin/sh 不能写进配置
const r7 = await binaries.setPreference({ mode: 'custom', path: '/bin/sh' })
ok('setPreference(/bin/sh) 被拒', r7.ok === false, JSON.stringify(r7))
ok('被拒后没有切到 custom', binaries.preference().mode !== 'custom')

// 8. addExtra 同样拒绝
const r8 = await binaries.addExtra(notFfmpeg)
ok('addExtra 拒绝假 ffmpeg', r8.ok === false, JSON.stringify(r8))

// 9. 系统 ffmpeg（若存在）应被识别
let sys = ''
try {
  sys = execSync('command -v ffmpeg', { encoding: 'utf8' }).trim()
} catch (_) {}
if (sys) {
  const r9 = await binaries.validatePath(sys)
  ok('系统 ffmpeg 通过', r9.ok, r9.error)
} else {
  ok('系统 ffmpeg（跳过：未安装）', true)
}

/* ------------------------- 10. 探测缓存：写盘与命中 ------------------------- */

const runsLog = path.join(root, 'runs.log')
/**
 * @returns {number} 假 ffmpeg 被执行 `-version` 的次数
 */
const cacheLog = () =>
  fs.existsSync(runsLog) ? fs.readFileSync(runsLog, 'utf8').trim().split('\n').filter(Boolean).length : 0

const goodDir = path.join(root, 'goodbin')
fs.mkdirSync(goodDir, { recursive: true })
const goodFfmpeg = path.join(goodDir, 'ffmpeg')
fs.writeFileSync(goodFfmpeg, `#!/bin/sh\necho "run $@" >> "${runsLog}"\necho "ffmpeg version 6.1.1"\n`)
fs.chmodSync(goodFfmpeg, 0o755)

const r10 = await binaries.setPreference({ mode: 'custom', path: goodFfmpeg })
ok('自定义路径切换成功', r10.ok === true, JSON.stringify(r10))
ok('盘缓存文件已生成', Boolean(binaries.cacheFilePath()) && fs.existsSync(binaries.cacheFilePath()), binaries.cacheFilePath())

const beforeHit = cacheLog()
binaries.reset()
ok('reset 后可从盘缓存恢复', binaries.hydrateFromDisk() === true)
ok('恢复的 ffmpeg 路径正确', binaries.summary().ffmpeg.path === goodFfmpeg, binaries.summary().ffmpeg.path)
await binaries.detect(false)
await binaries.scan(true)
ok('缓存命中时不再执行 -version', cacheLog() === beforeHit, `before=${beforeHit} after=${cacheLog()}`)
ok('盘缓存不写同步库', dbWrites.every((k) => !String(k).includes('binaries')), JSON.stringify(dbWrites))

/* ------------------------- 11. host 模式短路 ------------------------- */

const beforeHost = cacheLog()
const rHost = await binaries.setPreference({ mode: 'host' })
ok('host 模式切换成功', rHost.ok === true, JSON.stringify(rHost))
ok('host 模式不枚举候选也不起子进程', cacheLog() === beforeHost, `before=${beforeHost} after=${cacheLog()}`)
ok('host 模式快照为宿主内置', binaries.summary().ffmpeg.source === 'host')

/* ------------------------- 12. 身份不一致时缓存失效 ------------------------- */

await binaries.setPreference({ mode: 'custom', path: goodFfmpeg })
const future = new Date(Date.now() + 60 * 1000)
fs.utimesSync(goodFfmpeg, future, future)
binaries.reset()
ok('mtime 变了缓存不再命中', binaries.hydrateFromDisk() === false)

/* ------------------------- 13. 缓存不能绕过文件名白名单 ------------------------- */

await binaries.setPreference({ mode: 'auto' })
const shStat = fs.statSync('/bin/sh')
const evil = {
  schema: 1,
  at: Date.now(),
  ffmpeg: { source: 'system', path: '/bin/sh', version: '6.1.1', mtime: Math.round(shStat.mtimeMs), size: shStat.size },
  ffprobe: null,
  skipped: [],
  versions: {}
}
fs.writeFileSync(binaries.cacheFilePath(), JSON.stringify(evil), 'utf8')
binaries.reset()
ok('trusted 拒绝非 ffmpeg 文件名', binaries.trusted(evil.ffmpeg) === false)
ok('盘缓存里的 /bin/sh 不被采信', binaries.hydrateFromDisk() === false)

/* ------------------------- 14. 损坏与不可写 ------------------------- */

fs.writeFileSync(binaries.cacheFilePath(), '{oops', 'utf8')
binaries.reset()
ok('损坏的缓存不抛错也不采信', binaries.hydrateFromDisk() === false)

if (typeof process.getuid === 'function' && process.getuid() === 0) {
  ok('目录只读时写盘失败（跳过：root 无视权限）', true)
} else {
  const dir = path.dirname(binaries.cacheFilePath())
  fs.chmodSync(dir, 0o500)
  let persisted
  try {
    persisted = binaries.persistCache()
  } catch (err) {
    persisted = `threw:${err.message}`
  }
  ok('目录只读时写盘失败但不抛错，也不退回同步库', persisted === false, String(persisted))
  fs.chmodSync(dir, 0o700)
}

/* ------------------------- 15. force 必须真的重跑 ------------------------- */

await binaries.detect(true)
const at1 = JSON.parse(fs.readFileSync(binaries.cacheFilePath(), 'utf8')).at
await new Promise((r) => setTimeout(r, 15))
await binaries.detect(true)
const at2 = JSON.parse(fs.readFileSync(binaries.cacheFilePath(), 'utf8')).at
ok('detect(true) 连续两次都真的重跑并重新落盘', at2 > at1, `${at1} → ${at2}`)

fs.rmSync(root, { recursive: true, force: true })

console.log(`\n通过 ${pass} 项`)
if (fails.length) {
  console.log(`失败 ${fails.length} 项：`)
  for (const f of fails) console.log('  ✗', f)
  process.exit(1)
}
console.log('✓ binaries 校验全部通过')
