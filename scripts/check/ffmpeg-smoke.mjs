/**
 * 端到端冒烟：用真实 preload + 真实 ffmpeg 跑一条转换，
 * 顺带验证「参数白名单拒绝注入」「本次产出可删」「采集接口可用」。
 * 没有 ffmpeg 时直接 skip（exit 0）。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'

const require = createRequire(import.meta.url)

let hasFFmpeg = true
try {
  execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' })
} catch (_) {
  hasFFmpeg = false
}
if (!hasFFmpeg) {
  console.log('跳过：本机没有 ffmpeg')
  process.exit(0)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-'))
process.env.HOME = root
process.env.USERPROFILE = root

const outDir = path.join(root, 'out')
const tempDir = path.join(root, 'tmp')
fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(tempDir, { recursive: true })

const src = path.join(root, 'src.wav')
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', src])

global.window = {
  utools: {
    dbStorage: { getItem: () => null, setItem: () => {} },
    getPath: (name) => (name === 'downloads' || name === 'desktop' ? outDir : root),
    getPluginTempPath: () => tempDir
  }
}

const api = require('../../preload/index.js') && global.window.audioServices
const A = await import('../../src/core/args.js')

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => (cond ? (pass += 1) : fails.push(`${name}${detail ? ' → ' + String(detail).slice(0, 200) : ''}`))

ok('preload 加载', Boolean(api && api.version), 'audioServices 为空')
ok('caps.guard', api.caps && api.caps.guard === 1)

// 授权源文件：模拟「拖入」（preload 内部登记，页面已无权调用 grantPaths）
api.pathForFile({ path: src })
// 等异步探测就绪（真实使用中首次任务可能仍走宿主内置，行为一致）
await api.getBinariesAsync()

// 1. 正常转换
const out = path.join(outDir, 'ok.m4a')
const convertArgs = A.convert({ input: src, output: out, format: 'm4a', bitrate: 128 })
try {
  await api.run('smoke-1', convertArgs, {})
  ok('转换产出文件', fs.existsSync(out))
  const probe = execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out], { encoding: 'utf8' })
  ok('产物编码为 aac', /aac/.test(probe), probe.trim())
} catch (err) {
  ok('转换产出文件', false, err.message)
}

// 2. 本次产出可以删
const rm = api.removeFile(out)
ok('产出可删除', rm && rm.ok === true, JSON.stringify(rm))

// 3. 未授权路径不能动
const rmForeign = api.removeFile(src)
ok('源文件不可删', rmForeign && rmForeign.ok === false, JSON.stringify(rmForeign))

// 4. 参数注入被拒（未授权输入）
let rejected = false
try {
  await api.run('smoke-2', ['-hide_banner', '-nostdin', '-y', '-i', '/etc/passwd', '-c:a', 'aac', path.join(outDir, 'x.m4a')])
} catch (err) {
  rejected = err && err.code === 'EARGS_INVALID'
}
ok('未授权输入被拒', rejected)

// 5. 未知 flag 被拒
let rejectedFlag = false
try {
  await api.run('smoke-3', ['-hide_banner', '-i', src, '-f', 'lavfi', '-i', 'testsrc', path.join(outDir, 'y.m4a')])
} catch (err) {
  rejectedFlag = err && err.code === 'EARGS_INVALID'
}
ok('高危 flag 被拒', rejectedFlag)

// 6. 采集接口（silencedetect 形态）
try {
  const cap = await api.runCapture('smoke-4', A.silenceDetect({ input: src, noise: -35, minSilence: 0.5 }))
  ok('采集接口可用', cap && typeof cap.text === 'string')
} catch (err) {
  ok('采集接口可用', false, err.message)
}

// 7. 即时预览（输出固定临时目录）
try {
  const res = await api.renderPreview({ input: src, kind: 'spectrum', width: 640, height: 320, seconds: 2, token: 'smoke' })
  ok('预览返回 dataUrl', Boolean(res && res.dataUrl && res.dataUrl.startsWith('data:image/')))
} catch (err) {
  ok('预览返回 dataUrl', false, err.message)
}

// 8. 输出到未授权目录被拒
let outRejected = false
try {
  await api.run('smoke-5', A.convert({ input: src, output: '/etc/evil.m4a', format: 'm4a', bitrate: 128 }))
} catch (err) {
  outRejected = err && err.code === 'EARGS_INVALID'
}
ok('越权输出被拒', outRejected)

fs.rmSync(root, { recursive: true, force: true })

console.log(`\n通过 ${pass} 项`)
if (fails.length) {
  console.log(`失败 ${fails.length} 项：`)
  for (const f of fails) console.log('  ✗', f)
  process.exit(1)
}
console.log('✓ 端到端冒烟通过')
