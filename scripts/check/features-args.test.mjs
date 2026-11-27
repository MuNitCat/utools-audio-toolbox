/**
 * 用 17 个功能真实的 build() 产物跑白名单校验。
 * 这是「前端改了参数、preload 没跟上」的唯一防线。
 * 只校验参数，不真正调用 ffmpeg。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const require = createRequire(import.meta.url)
const guard = require('../../preload/lib/guard.js')
const { validateRunArgs, validateCaptureArgs } = require('../../preload/lib/argswhitelist.js')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'features-args-'))
const dir = path.join(root, 'in')
fs.mkdirSync(dir, { recursive: true })

const flac = path.join(dir, 'a.flac')
const flac2 = path.join(dir, 'b.flac')
const mp4 = path.join(dir, 'v.mp4')
const cover = path.join(dir, 'cover.jpg')
for (const f of [flac, flac2, mp4, cover]) fs.writeFileSync(f, 'x')

// features.js 只用到 exists（重名检测）和 makeConcatList（merge 的 concat 列表）
global.window = {
  audioServices: {
    // 真实 preload 的 exists 会看磁盘；这里用 fs 保持同样的语义（否则同格式输出会漏掉 (1)）
    exists: (file) => fs.existsSync(file)
  }
}
// concat 列表用 preload 的真实现：逐条过 assertReadFile、写进真实临时目录
const fsx = require('../../preload/lib/fsx.js')
global.window.audioServices.makeConcatList = fsx.makeConcatList

const { FEATURES, defaultParams } = await import('../../src/core/features.js')

guard.grantPaths([flac, flac2, mp4, cover])

const ctx = {
  assertRead: guard.assertReadFile,
  assertWriteTarget: guard.assertWriteTarget,
  isTemp: guard.isTemp,
  readText: fsx.readText
}

const info = {
  ok: true,
  name: 'a.flac',
  ext: 'flac',
  duration: 62.5,
  sampleRate: 44100,
  channels: 2,
  bitrate: 900,
  streamBitrate: 320,
  audioStreams: 1,
  hasVideo: false,
  tags: { title: 't', artist: 'a' }
}
const videoInfo = { ...info, name: 'v.mp4', ext: 'mp4', hasVideo: true, audioStreams: 2 }
const info2 = { ...info, name: 'b.flac' }

let pass = 0
const fails = []

/**
 * @param {string} name 用例名
 * @param {boolean} cond 断言
 * @param {string} [detail] 细节
 */
function ok(name, cond, detail = '') {
  if (cond) pass += 1
  else fails.push(`${name}${detail ? ' → ' + String(detail).slice(0, 200) : ''}`)
}

/** 参数微调：让「按格式出现的字段」都走到一次 */
const VARIANTS = [
  ['默认', {}],
  ['mp3', { format: 'mp3', bitrate: 192 }],
  ['flac 无损', { format: 'flac' }],
  ['复制模式', { copy: true }],
  ['封面', { coverPath: cover }]
]

for (const feature of FEATURES) {
  const inputs = feature.multi ? [flac, flac2] : [flac]
  const infos = feature.multi ? [info, info2] : [info]
  const useVideo = feature.id === 'extract'
  const realInputs = useVideo ? [mp4] : inputs
  const realInfos = useVideo ? [videoInfo] : infos

  for (const [label, patch] of VARIANTS) {
    const params = { ...defaultParams(feature), outputDir: '', ...patch }
    let blocks = []
    try {
      blocks = feature.build(realInputs, params, realInfos) || []
    } catch (err) {
      // extract 的 copy 需要真实编码信息之外的判断；允许它按业务报错
      ok(`${feature.id}/${label} build 不崩`, false, (err && err.message) || 'throw')
      continue
    }
    const ops = blocks.flatMap((b) => b.ops || [])
    for (const op of ops) {
      const res = op.capture ? validateCaptureArgs(op.args, ctx) : validateRunArgs(op.args, ctx)
      ok(`${feature.id}/${label} ${op.label || 'op'}`, res.ok, res.error)
    }
    if (!ops.length) ok(`${feature.id}/${label} 至少 1 个 op 或明确 skip`, Boolean(blocks[0] && blocks[0].skip), 'ops 为空且没有 skip 原因')
  }
}

// 单轨 / 多轨 / 混合三种模式分别校验
const extract = FEATURES.find((f) => f.id === 'extract')
for (const mode of ['first', 'all', 'mix']) {
  const params = { ...defaultParams(extract), trackMode: mode, outputDir: '' }
  const blocks = extract.build([mp4], params, [videoInfo])
  const ops = blocks.flatMap((b) => b.ops || [])
  ok(`extract/${mode} 有 op`, ops.length > 0)
  for (const op of ops) {
    const res = validateRunArgs(op.args, ctx)
    ok(`extract/${mode} 参数通过`, res.ok, res.error)
  }
}

// 音轨处理：只有「确定单音轨」时才禁用后两项，未知/多轨/混合都不能锁
const trackField = extract.fields.find((f) => f.key === 'trackMode')
const lockedModes = (files) =>
  trackField.options
    .filter((o) => trackField.optionDisabled(o, {}, { files }))
    .map((o) => o.value)
    .join(',')
ok('extract 单音轨锁死逐条/混合', lockedModes([{ info: { ok: true, audioStreams: 1 } }]) === 'all,mix')
ok('extract 多音轨不锁', lockedModes([{ info: { ok: true, audioStreams: 2 } }]) === '')
ok('extract 单双轨混装不锁', lockedModes([{ info: { ok: true, audioStreams: 1 } }, { info: { ok: true, audioStreams: 3 } }]) === '')
ok('extract 无文件不锁', lockedModes([]) === '')
ok('extract 音轨数未知不锁', lockedModes([{ info: { ok: true } }]) === '')

fs.rmSync(root, { recursive: true, force: true })

console.log(`\n通过 ${pass} 项`)
if (fails.length) {
  console.log(`失败 ${fails.length} 项：`)
  for (const f of fails) console.log('  ✗', f)
  process.exit(1)
}
console.log('✓ 17 个功能的参数全部通过白名单')
