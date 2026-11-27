/**
 * 批量探测的并发与取消断言。
 *
 * 审核意见：probeMany 原来逐个串行、没有上限也没有取消，拖几百个文件时进度会长时间停住。
 * 这里用一个「每次执行固定睡 0.15s」的假 ffmpeg 把三件事钉住：
 * - 结果同序等长、onOne 对每个入参恰好调用一次（渲染层靠它减计数）
 * - 真的并发（9 个文件明显快于串行）
 * - cancelProbe 能提前收敛，并且取消后每个入参仍然收到一次回调
 *
 * 直接 node scripts/check/probe.test.mjs 运行，不依赖测试框架，也不需要真实 ffmpeg。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const require = createRequire(import.meta.url)

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-test-'))
process.env.HOME = root
process.env.USERPROFILE = root
// 关掉 binaries 的启动预热：本用例要的就是「不跑真实探测」
process.env.AUDIO_BATCH_NO_WARMUP = '1'

const binDir = path.join(root, 'bin')
const mediaDir = path.join(root, 'media')
fs.mkdirSync(binDir, { recursive: true })
fs.mkdirSync(mediaDir, { recursive: true })

// 假 ffmpeg：-version 正常应答；-i 时睡 0.15s 再吐一段标准 stderr（退出码 1 是 ffmpeg -i 的常态）
const fakeFfmpeg = path.join(binDir, 'ffmpeg')
fs.writeFileSync(
  fakeFfmpeg,
  [
    '#!/bin/sh',
    'if [ "$1" = "-version" ]; then',
    '  echo "ffmpeg version 7.1"',
    '  exit 0',
    'fi',
    'sleep 0.15',
    'cat >&2 <<\'EOF\'',
    "Input #0, wav, from 'x.wav':",
    '  Duration: 00:00:01.00, start: 0.000000, bitrate: 1411 kb/s',
    '    Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 44100 Hz, stereo, s16, 1411 kb/s',
    'EOF',
    'exit 1'
  ].join('\n') + '\n'
)
fs.chmodSync(fakeFfmpeg, 0o755)

/**
 * @param {string} name 文件名
 * @returns {string} 绝对路径
 */
function makeMedia(name) {
  const file = path.join(mediaDir, name)
  fs.writeFileSync(file, 'x')
  return file
}

// 先写本机配置再加载 preload：这样 preference() 的首次调用就能拿到 custom 路径，
// 也不会触发 detect（本用例不需要真实的 ffprobe）。
const config = require('../../preload/lib/config.js')
config.setLocal({ ffmpegMode: 'custom', ffmpegPath: fakeFfmpeg })

/** 宿主 onPluginEnter 是单槽赋值，用同一个槽模拟 */
let hostEnterCb = null
global.window = {
  utools: {
    dbStorage: { getItem: () => null, setItem: () => {} },
    getPath: () => root,
    getPluginTempPath: () => root,
    onPluginEnter: (cb) => {
      hostEnterCb = cb
    }
  }
}

const api = require('../../preload/index.js') && global.window.audioServices

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => (cond ? (pass += 1) : fails.push(`${name}${detail ? ' → ' + String(detail).slice(0, 300) : ''}`))

/**
 * 把一批路径通过宿主事件授权给 guard（与真实「拖入 / 文件关联」同一条路径）。
 * @param {string[]} files 绝对路径
 * @returns {void} 无返回值
 */
function authorize(files) {
  if (typeof hostEnterCb === 'function') {
    hostEnterCb({ code: 'utools-audio-toolbox', type: 'files', payload: files.map((p) => ({ isFile: true, path: p })) })
  }
}

/* ------------------------- 1. 基线：单文件探测走假 ffmpeg ------------------------- */

const one = makeMedia('one.wav')
authorize([one])
const single = await api.probe(one)
ok('假 ffmpeg 的 stderr 能解析出音频信息', single.ok === true && single.duration === 1, JSON.stringify(single.error))
ok('探测来源标记为 ffmpeg 回退路径', single.probeSource === 'ffmpeg', single.probeSource)

/* ------------------------- 2. 并发 + 顺序 + 回调次数 ------------------------- */

const nine = Array.from({ length: 9 }, (_, i) => makeMedia(`c${i}.wav`))
authorize(nine)

const seenIndex = []
const startedAt = Date.now()
const outNine = await api.probeMany(nine, (info, index, total) => {
  seenIndex.push(index)
  ok(`onOne 的 total 正确 (#${index})`, total === 9, String(total))
})
const elapsed = Date.now() - startedAt

ok('结果同序等长', outNine.length === 9 && outNine.every((info, i) => info.path === fs.realpathSync(nine[i])), JSON.stringify(outNine.map((o) => o.name)))
ok('onOne 对每个入参调用一次', seenIndex.length === 9 && new Set(seenIndex).size === 9, JSON.stringify(seenIndex))
ok('三轮并发明显快于串行（9×0.15s）', elapsed < 1100, `${elapsed}ms`)

/* ------------------------- 3. 取消：计数收敛 + 提前结束 ------------------------- */

const many = Array.from({ length: 40 }, (_, i) => makeMedia(`k${i}.wav`))
authorize(many)

const seenMany = []
const cancelledJob = 'probe-cancel-1'
const startedCancel = Date.now()
const primary = api.probeMany(
  many,
  (info) => {
    seenMany.push(info)
  },
  { jobId: cancelledJob }
)

// 让前几个先跑起来，再取消
await new Promise((r) => setTimeout(r, 200))
const hit = api.cancelProbe(cancelledJob)
const outMany = await primary
const cancelElapsed = Date.now() - startedCancel

ok('cancelProbe 命中进行中的任务', hit === true, String(hit))
ok('取消后结果仍然同序等长', outMany.length === 40, String(outMany.length))
ok('取消后 onOne 仍调用 40 次（计数不会挂住）', seenMany.length === 40, String(seenMany.length))
ok('至少有一项被标成已取消', outMany.some((info) => info.canceled === true))
ok('取消明显早于串行跑完（40×0.15s）', cancelElapsed < 1500, `${cancelElapsed}ms`)
ok('取消后没有剩下的「读取中」占位', outMany.every((info) => info && typeof info.path === 'string'))

/* ------------------------- 4. 取消入口的边界 ------------------------- */

ok('cancelProbe 对未知 jobId 返回 false', api.cancelProbe('nope') === false)
ok('cancelProbe 拒绝路径形态', api.cancelProbe('../etc') === false)
ok('cancelProbe 拒绝对象', api.cancelProbe({ jobId: cancelledJob }) === false)

/* ------------------------- 5. 非法入参不炸 ------------------------- */

const empty = await api.probeMany([])
ok('空数组直接返回空数组', Array.isArray(empty) && empty.length === 0)
const nullish = await api.probeMany(null)
ok('null 入参退化为空数组', Array.isArray(nullish) && nullish.length === 0)

fs.rmSync(root, { recursive: true, force: true })

console.log(`\n通过 ${pass} 项`)
if (fails.length) {
  console.log(`失败 ${fails.length} 项：`)
  for (const f of fails) console.log('  ✗', f)
  process.exit(1)
}
console.log('✓ 批量探测的并发与取消符合预期')
