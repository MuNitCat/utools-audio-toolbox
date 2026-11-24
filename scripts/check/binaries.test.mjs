/**
 * binaries 校验的断言脚本：确保任意可执行文件不能冒充 ffmpeg。
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

global.window = { utools: { dbStorage: { getItem: () => null, setItem: () => {} } } }
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

fs.rmSync(root, { recursive: true, force: true })

console.log(`\n通过 ${pass} 项`)
if (fails.length) {
  console.log(`失败 ${fails.length} 项：`)
  for (const f of fails) console.log('  ✗', f)
  process.exit(1)
}
console.log('✓ binaries 校验全部通过')
