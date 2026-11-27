/**
 * ffmpeg 参数白名单（preload/lib/argswhitelist.js）的断言脚本。
 * 正例直接用 src/core/args.js 的真实产物，保证「前端改了参数、白名单没跟上」能立刻暴露。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const require = createRequire(import.meta.url)
const guard = require('../../preload/lib/guard.js')
const fsx = require('../../preload/lib/fsx.js')
const { validateRunArgs, validateCaptureArgs } = require('../../preload/lib/argswhitelist.js')
const A = await import('../../src/core/args.js')

let pass = 0
const fails = []

/**
 * @param {string} name 用例名
 * @param {boolean} cond 断言条件
 * @param {string} [detail] 失败细节
 */
function ok(name, cond, detail = '') {
  if (cond) pass += 1
  else fails.push(`${name}${detail ? ' → ' + String(detail).slice(0, 160) : ''}`)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'args-test-'))
const inputDir = path.join(root, 'in')
fs.mkdirSync(inputDir, { recursive: true })

const flac = path.join(inputDir, 'a.flac')
const mp4 = path.join(inputDir, 'v.mp4')
const cover = path.join(inputDir, 'cover.jpg')
const flac2 = path.join(inputDir, 'b.flac')
for (const f of [flac, mp4, cover, flac2]) fs.writeFileSync(f, 'x')

guard.grantPaths([flac, mp4, cover, flac2])

const ctx = {
  assertRead: guard.assertReadFile,
  assertWriteTarget: guard.assertWriteTarget,
  isTemp: guard.isTemp,
  readText: fsx.readText
}
const out = (name) => path.join(inputDir, name)

/** @param {string} name @param {string[]} args */
function expectRun(name, args) {
  const res = validateRunArgs(args, ctx)
  ok(`run: ${name}`, res.ok, res.error)
  return res
}

/** @param {string} name @param {string[]} args @param {string} hint 期望的错误关键词 */
function expectReject(name, args, hint) {
  const res = validateRunArgs(args, ctx)
  ok(`拒绝: ${name}`, !res.ok && (!hint || String(res.error).includes(hint)), res.ok ? '却通过了' : res.error)
}

/** @param {string} name @param {string[]} args */
function expectCapture(name, args) {
  const res = validateCaptureArgs(args, ctx)
  ok(`capture: ${name}`, res.ok, res.error)
}

const listFile = path.join(fsx.tempDir(), `utools-audio-toolbox-test-${process.pid}.txt`)
// 列表内容用 makeConcatList 的产出格式（file '...'），条目是已授权的 flac/flac2
fs.writeFileSync(listFile, `file '${flac.replace(/'/g, "'\\''")}'\nfile '${flac2.replace(/'/g, "'\\''")}'\n`)

// ---------------- 正例：17 个功能里所有参数构造器 ----------------
expectRun('convert m4a', A.convert({ input: flac, output: out('a.m4a'), format: 'm4a', bitrate: 192 }))
expectRun('convert mp3 VBR', A.convert({ input: flac, output: out('a.mp3'), format: 'mp3', quality: '2' }))
expectRun('extract 单轨', A.extractAudio({ input: mp4, output: out('v.m4a'), format: 'm4a', track: 0 }))
expectRun('extract copy', A.extractAudio({ input: mp4, output: out('v2.m4a'), format: 'm4a', copy: true }))
expectRun('extract mix', A.extractAudio({ input: mp4, output: out('v3.m4a'), format: 'm4a', mix: true, trackCount: 2 }))
expectRun('clip copy', A.clip({ input: flac, output: out('c.m4a'), start: 10, duration: 5, format: 'm4a', copy: true }))
expectRun('clip 重编码', A.clip({ input: flac, output: out('c2.m4a'), start: 1.5, end: 9, fadeIn: 0.3, fadeOut: 0.5, format: 'm4a' }))
expectRun('merge copy', A.mergeCopy({ listFile, output: out('m.m4a'), format: 'm4a' }))
expectRun('merge 重编码', A.mergeReencode({ inputs: [flac, flac2], output: out('m2.m4a'), format: 'm4a' }))
expectRun('edit 变速增益淡入淡出', A.edit({ input: flac, output: out('e.m4a'), speed: 1.5, gainDb: 9, fadeIn: 1, fadeOut: 2, duration: 30, format: 'm4a' }))
expectRun('denoise', A.denoise({ input: flac, output: out('d.m4a'), strength: 'strong', format: 'm4a' }))
expectRun(
  'loudnorm 第二遍',
  A.loudnormApply({
    input: flac,
    output: out('n.m4a'),
    format: 'm4a',
    measured: { input_i: -20.1, input_tp: -1.2, input_lra: 7.3, input_thresh: -30.5, target_offset: 0.2 }
  })
)
expectRun('trimSilence', A.trimSilence({ input: flac, output: out('t.m4a'), threshold: -40, keepEdge: 0.1, format: 'm4a' }))
expectRun('splitSegment', A.splitSegment({ input: flac, output: out('s.m4a'), start: 0, duration: 12, format: 'm4a' }))
expectRun('writeMetadata + 封面', A.writeMetadata({ input: flac, output: out('w.m4a'), tags: { title: '测试', artist: '某人' }, coverPath: cover, format: 'm4a' }))
expectRun('extractCover', A.extractCover({ input: flac, output: out('cover.png') }))
expectRun('visualize 频谱', A.visualize({ input: flac, output: out('spec.png'), kind: 'spectrum', width: 1280, height: 640 }))
expectRun('visualize 波形', A.visualize({ input: flac, output: out('wave.png'), kind: 'waveform', width: 1280, height: 420 }))
expectCapture('loudnorm 第一遍', A.loudnormAnalyze({ input: flac }))
expectCapture('silencedetect', A.silenceDetect({ input: flac, noise: -35, minSilence: 0.8 }))

// ---------------- 反例 ----------------
expectReject('协议输入', [...A.BASE_DUMMY || [], '-i', 'http://evil.com/a.mp3', '-c:a', 'aac', out('x.m4a')], '协议')
expectReject('未授权输入', ['-i', '/etc/passwd', '-c:a', 'aac', out('x.m4a')], '未授权')
expectReject('movie 滤镜读文件', ['-i', flac, '-filter_complex', 'movie=/etc/passwd[out]', out('x.m4a')], 'filter_complex')
expectReject('未知 flag', ['-i', flac, '-crf', '23', out('x.m4a')], '未登记')
expectReject('map_metadata 1', ['-i', flac, '-map_metadata', '1', out('x.m4a')], '只允许 0')
expectReject('f lavfi', ['-f', 'lavfi', '-i', 'testsrc', out('x.m4a')], '容器')
expectReject('输出越权', ['-i', flac, '-c:a', 'aac', '/etc/passwd.m4a'], '不在允许的目录')
expectReject('字幕滤镜', ['-i', flac, '-af', 'volume=3dB,subtitles=/x.srt', out('x.m4a')], '滤镜')
expectReject('调用方传 -progress', ['-i', flac, '-progress', 'pipe:1', out('x.m4a')], '不允许的参数')
expectReject('concat 缺参数', ['-i', flac, '-f', 'concat', out('x.m4a')], 'concat')
expectReject('双输出', ['-i', flac, out('x.m4a'), out('y.m4a')], '输出')
expectReject('attachment 注入', ['-i', flac, '-attach', out('x.bin'), out('x.m4a')], '不允许的参数')

// 非临时目录的 txt 不能当 concat 列表
const badList = path.join(inputDir, 'evil.txt')
fs.writeFileSync(badList, '/etc/passwd\n')
guard.grantPaths([badList])  // 先让它成为已授权文件，专门验证 concat 的临时目录规则
expectReject(
  'concat 列表不在临时目录',
  ['-i', flac, '-f', 'concat', '-safe', '0', '-i', badList, '-c', 'copy', out('x.m4a')],
  '临时目录'
)

// 临时目录里的列表但含未授权条目：逐条校验必须拒绝
const sneakyList = path.join(fsx.tempDir(), `utools-audio-toolbox-sneaky-${process.pid}.txt`)
fs.writeFileSync(sneakyList, `file '${flac.replace(/'/g, "'\\''")}'\nfile '/etc/secret.flac'\n`)
expectReject(
  'concat 列表含未授权条目',
  ['-i', flac, '-f', 'concat', '-safe', '0', '-i', sneakyList, '-c', 'copy', out('x.m4a')],
  '未授权'
)

// 临时目录里的列表但条目格式不对（裸路径不是 file '...' 行）
const oddList = path.join(fsx.tempDir(), `utools-audio-toolbox-odd-${process.pid}.txt`)
fs.writeFileSync(oddList, `${flac}\n${flac2}\n`)
expectReject(
  'concat 列表条目格式非法',
  ['-i', flac, '-f', 'concat', '-safe', '0', '-i', oddList, '-c', 'copy', out('x.m4a')],
  '条目'
)

fs.rmSync(root, { recursive: true, force: true })
fs.rmSync(listFile, { force: true })
fs.rmSync(sneakyList, { force: true })
fs.rmSync(oddList, { force: true })

console.log(`\n通过 ${pass} 项`)
if (fails.length) {
  console.log(`失败 ${fails.length} 项：`)
  for (const f of fails) console.log('  ✗', f)
  process.exit(1)
}
console.log('✓ args 白名单全部通过')
