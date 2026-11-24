/**
 * 输出命名规则的 golden 测试：把每条规则的实际产出钉死。
 *
 * 规则实现只有 `src/core/paths.js` 一份（preload 里的旧副本已删除），
 * 所以这里不再做「新旧实现对比」，而是直接断言「用户最终看到的文件名」。
 * 这些断言一旦变化，就意味着产物文件名会变，必须是有意为之。
 *
 * 直接 node scripts/check/paths.test.mjs 运行，不依赖测试框架。
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

global.window = { audioServices: { exists: (p) => fs.existsSync(p) } }

const { resolveOutput, numberedOutput } = await import('../../src/core/paths.js')

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => (cond ? (pass += 1) : fails.push(`${name}${detail ? ' → ' + detail : ''}`))

/**
 * 每个用例都用全新的临时目录，避免上一个用例的产物影响重名检测。
 * @param {string[]} [preexisting] 预先放好的文件，相对 root 的路径（用于构造重名）
 * @returns {{root: string, inDir: string, outDir: string, otherDir: string, input: string}} 目录与输入文件
 */
function fixture(preexisting = []) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paths-')))
  const inDir = path.join(root, 'in')
  const outDir = path.join(root, 'out')
  const otherDir = path.join(root, 'w')
  fs.mkdirSync(inDir, { recursive: true })
  fs.mkdirSync(outDir, { recursive: true })
  const input = path.join(inDir, 'track 01.flac')
  fs.writeFileSync(input, 'x')
  for (const rel of preexisting) {
    const full = path.join(root, rel)
    fs.mkdirSync(path.dirname(full), { recursive: true })
    fs.writeFileSync(full, 'x')
  }
  return { root, inDir, outDir, otherDir, input }
}

/**
 * @param {string} label 用例名
 * @param {object} c 用例
 * @param {(f: object) => string} c.run 产出路径
 * @param {(f: object) => string} c.dir 期望目录
 * @param {string} c.name 期望文件名
 * @param {string[]} [c.files] 预先存在的文件（相对 root）
 * @returns {void}
 */
function check(label, c) {
  const f = fixture(c.files || [])
  const out = c.run(f)
  ok(`${label}：目录`, path.dirname(out) === c.dir(f), `\n     want=${c.dir(f)}\n     got =${path.dirname(out)}`)
  ok(`${label}：文件名`, path.basename(out) === c.name, `\n     want=${c.name}\n     got =${path.basename(out)}`)
  fs.rmSync(f.root, { recursive: true, force: true })
}

/* ------------------------------ resolveOutput ------------------------------ */

check('默认落在源文件同级', {
  run: (f) => resolveOutput(f.input, { ext: 'm4a' }),
  dir: (f) => f.inDir,
  name: 'track 01.m4a'
})

check('指定输出目录', {
  run: (f) => resolveOutput(f.input, { dir: f.outDir, ext: 'm4a' }),
  dir: (f) => f.outDir,
  name: 'track 01.m4a'
})

check('带后缀', {
  run: (f) => resolveOutput(f.input, { suffix: '_norm', ext: 'm4a' }),
  dir: (f) => f.inDir,
  name: 'track 01_norm.m4a'
})

check('指定主名（覆盖原名）', {
  run: (f) => resolveOutput(f.input, { name: '自定义名字', ext: 'mp3' }),
  dir: (f) => f.inDir,
  name: '自定义名字.mp3'
})

check('扩展名带点也能归一', {
  run: (f) => resolveOutput(f.input, { ext: '.m4a' }),
  dir: (f) => f.inDir,
  name: 'track 01.m4a'
})

check('与源文件同名时自动加 (1)', {
  // ext 与源相同 → 目标就是源文件本身，必须让路
  run: (f) => resolveOutput(f.input, { ext: 'flac' }),
  dir: (f) => f.inDir,
  name: 'track 01 (1).flac'
})

check('目标已存在时递增 (1)(2)…', {
  files: ['out/track 01.m4a', 'out/track 01 (1).m4a'],
  run: (f) => resolveOutput(f.input, { dir: f.outDir, ext: 'm4a' }),
  dir: (f) => f.outDir,
  name: 'track 01 (2).m4a'
})

check('overwrite 时不再加序号（是否真覆盖交给 preload 校验）', {
  run: (f) => resolveOutput(f.input, { ext: 'mp3', overwrite: true }),
  dir: (f) => f.inDir,
  name: 'track 01.mp3'
})

check('后缀里的分隔符被清洗', {
  run: (f) => resolveOutput(f.input, { suffix: '../evil', ext: 'm4a' }),
  dir: (f) => f.inDir,
  name: 'track 01__evil.m4a'
})

check('后缀是 .. 时被清洗', {
  run: (f) => resolveOutput(f.input, { suffix: '..', ext: 'm4a' }),
  dir: (f) => f.inDir,
  name: 'track 01_.m4a'
})

check('扩展名里的斜杠被清洗', {
  run: (f) => resolveOutput(f.input, { ext: 'a/b' }),
  dir: (f) => f.inDir,
  name: 'track 01.a_b'
})

check('目录不存在也照样返回路径', {
  run: (f) => resolveOutput(f.input, { dir: f.otherDir, ext: 'm4a' }),
  dir: (f) => f.otherDir,
  name: 'track 01.m4a'
})

/* ----------------------------- numberedOutput ----------------------------- */

check('切分：默认三位序号', {
  run: (f) => numberedOutput(f.input, 2, { ext: 'flac' }),
  dir: (f) => f.inDir,
  name: 'track 01_002.flac'
})

check('切分：带时间段', {
  run: (f) => numberedOutput(f.input, 2, { ext: 'flac', timeRange: '00-30' }),
  dir: (f) => f.inDir,
  name: 'track 01_002_00-30.flac'
})

check('切分：时间段穿越被清洗', {
  run: (f) => numberedOutput(f.input, 2, { ext: 'flac', timeRange: '../../etc' }),
  dir: (f) => f.inDir,
  name: 'track 01_002_____etc.flac'
})

check('切分：后缀 + 自定义位数', {
  run: (f) => numberedOutput(f.input, 2, { suffix: '_seg', ext: 'm4a', digits: 2 }),
  dir: (f) => f.inDir,
  name: 'track 01_seg_02.m4a'
})

check('切分：指定输出目录', {
  run: (f) => numberedOutput(f.input, 2, { dir: f.outDir, ext: 'flac' }),
  dir: (f) => f.outDir,
  name: 'track 01_002.flac'
})

console.log(`\n通过 ${pass} 项`)
if (fails.length) {
  console.log(`失败 ${fails.length} 项：`)
  for (const f of fails) console.log('  ✗', f)
  process.exit(1)
}
console.log('✓ 输出命名规则全部符合预期')
