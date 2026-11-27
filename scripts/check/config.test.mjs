/**
 * config 键表与归正的断言脚本。
 *
 * 审核意见：渲染层传进来的对象不能整份合并进 dbStorage。所以这里把「键名 / 类型 / 体积」
 * 三条边界逐条钉死，并额外验证两件容易回归的事：
 * - 两张键表的键集必须与 DEFAULTS 完全一致（加字段忘了登记会在这里失败）
 * - 归正不能下沉进 readSyncRaw，否则 migrate 看不到老版本的 ffmpeg* 键
 *
 * 用临时 HOME + 内存 dbStorage，绝不碰真实用户目录。直接 node scripts/check/config.test.mjs 运行。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'config-test-'))
process.env.HOME = root
process.env.USERPROFILE = root

const KEY = 'utools-audio-toolbox:config'
const LOCAL_DIR = path.join(root, 'userData')
const LOCAL_FILE = path.join(LOCAL_DIR, 'config.local.json')

/** 内存版 dbStorage：读写都走 JSON 序列化，尽量贴近宿主的真实行为 */
const db = new Map()
/** 记录 setItem 的次数与被写的键，用来断言「没写」 */
const writes = []
global.window = {
  utools: {
    dbStorage: {
      getItem: (k) => (db.has(k) ? JSON.parse(db.get(k)) : null),
      setItem: (k, v) => {
        writes.push(k)
        db.set(k, JSON.stringify(v))
      },
      removeItem: (k) => db.delete(k)
    },
    // 本机目录固定到临时 userData：config 不再往家目录兜底，测试也不能再依赖 HOME
    getPath: (name) => path.join(root, name)
  }
}

const require = createRequire(import.meta.url)
const config = require('../../preload/lib/config.js')
const { DEFAULTS, SYNC_SCHEMA, LOCAL_SCHEMA, LOCAL_KEYS } = config

let pass = 0
const fails = []
const ok = (name, cond, detail = '') => (cond ? (pass += 1) : fails.push(`${name}${detail ? ' → ' + detail : ''}`))

/**
 * 清空同步库、本机文件与目录探测缓存，用例之间互不影响。
 * @returns {void} 无返回值
 */
function fresh() {
  db.clear()
  writes.length = 0
  fs.rmSync(LOCAL_DIR, { recursive: true, force: true })
  config.reset()
}

/**
 * @returns {object|null} 同步库里当前序列化的配置
 */
function stored() {
  const raw = db.get(KEY)
  return raw ? JSON.parse(raw) : null
}

/**
 * @returns {object|null} 本机 config.local.json 内容
 */
function localStored() {
  try {
    return JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'))
  } catch (_) {
    return null
  }
}

/* ---------------------- 1. 键表与 DEFAULTS 必须完全一致 ---------------------- */

{
  const schemaKeys = [...Object.keys(SYNC_SCHEMA), ...Object.keys(LOCAL_SCHEMA)].sort()
  const defaultsKeys = Object.keys(DEFAULTS).sort()
  ok(
    '键表与 DEFAULTS 键集全等',
    schemaKeys.length === defaultsKeys.length && schemaKeys.every((k, i) => k === defaultsKeys[i]),
    `schema=[${schemaKeys.join(',')}] defaults=[${defaultsKeys.join(',')}]`
  )
  ok(
    'LOCAL_KEYS 由 LOCAL_SCHEMA 推导',
    LOCAL_KEYS.length === Object.keys(LOCAL_SCHEMA).length && LOCAL_KEYS.includes('outputDir') && LOCAL_KEYS.includes('artistHistory'),
    LOCAL_KEYS.join(',')
  )
}

/* ---------------------- 2. 未登记的键不落库 ---------------------- */

{
  fresh()
  config.setConfig({ evil: 1, theme: 'dark' })
  const saved = stored()
  ok('未知键被丢弃', saved && saved.evil === undefined, JSON.stringify(saved))
  ok('合法键仍然写入', saved && saved.theme === 'dark')
}

{
  fresh()
  // JSON.parse 产生的 __proto__ 是自有属性（字面量写法会改原型，属于另一条分支）
  config.setConfig(JSON.parse('{"__proto__":{"polluted":1},"theme":"light"}'))
  const saved = stored() || {}
  ok('JSON 里的 __proto__ 不进库', !Object.prototype.hasOwnProperty.call(saved, '__proto__'))
  ok('原型链未被污染', ({}).polluted === undefined)
}

/* ---------------------- 3. 类型与取值域 ---------------------- */

{
  fresh()
  ok('越界整数夹取到上限', config.setConfig({ concurrency: 99 }).concurrency === 4)
  ok('非法数字串不覆盖旧值', config.setConfig({ concurrency: 'abc' }).concurrency === 4)
  ok('类型错误不覆盖旧值（布尔）', config.setConfig({ overwrite: 'yes' }).overwrite === false)
  ok('枚举外取值不覆盖旧值', config.setConfig({ outputMode: 'nope' }).outputMode === 'sibling')
  ok('字符串不得含路径分隔符', config.setConfig({ suffix: '../x' }).suffix === '')
  ok('超长字符串被拒', config.setConfig({ suffix: 'x'.repeat(65) }).suffix === '')
  ok('合法后缀保留', config.setConfig({ suffix: '_compressed' }).suffix === '_compressed')
  ok('数值型字符串可接受并夹取', config.setConfig({ targetLufs: '-23' }).targetLufs === -23)
}

/* ---------------------- 4. 枚举必须列全（历史地雷） ---------------------- */

{
  fresh()
  ok('outputMode 支持 downloads', config.setConfig({ outputMode: 'downloads' }).outputMode === 'downloads')
  ok('outputMode 支持 desktop', config.setConfig({ outputMode: 'desktop' }).outputMode === 'desktop')
  ok('outputMode 支持 custom', config.setConfig({ outputMode: 'custom' }).outputMode === 'custom')
  ok('theme 支持 auto', config.setConfig({ theme: 'auto' }).theme === 'auto')
  ok('theme 支持 dark', config.setConfig({ theme: 'dark' }).theme === 'dark')
  ok('lastGroup 接受单个大写字母', config.setConfig({ lastGroup: 'C' }).lastGroup === 'C')
  ok('lastGroup 拒绝非标识符', config.setConfig({ lastGroup: 'C;C' }).lastGroup === 'C')
}

/* ---------------------- 5. 已删除的 params 键 ---------------------- */

{
  fresh()
  // params 曾是同步键表里唯一的自由文本入口（歌名/艺术家等），但没有任何读写点，已整键删除
  ok('params 不再是配置键', !('params' in config.getConfig()), JSON.stringify(Object.keys(config.getConfig())))
  config.setConfig({ params: { title: '私密标题' } })
  ok('params 不会被写进同步库', !JSON.stringify(stored() || {}).includes('私密标题'), JSON.stringify(stored()))
}

/* ---------------------- 6. 数组类键 ---------------------- */

{
  fresh()
  ok('艺术家列表超过 5 条被截断', config.setConfig({ artistHistory: ['a', 'b', 'c', 'd', 'e', 'f'] }).artistHistory.length === 5)
  ok(
    '艺术家列表逐项过滤非字符串',
    JSON.stringify(config.setConfig({ artistHistory: [1, 'x', ''] }).artistHistory) === '["x"]',
    JSON.stringify(config.getConfig().artistHistory)
  )
  ok('隐藏功能只接受标识符', JSON.stringify(config.setConfig({ hiddenFeatures: ['visualize', 'bad id', 3] }).hiddenFeatures) === '["visualize"]')
}

{
  fresh()
  config.setConfig({ artistHistory: ['keep'] })
  ok('非数组不覆盖旧值', JSON.stringify(config.setConfig({ artistHistory: 'x' }).artistHistory) === '["keep"]')
}

/* ---------------------- 7. 本机键分流 ---------------------- */

{
  fresh()
  const cfg = config.setConfig({ outputDir: path.join(root, 'out') })
  ok('outputDir 出现在合并结果里', cfg.outputDir === path.join(root, 'out'))
  ok('outputDir 不进同步库', !stored() || stored().outputDir === undefined)
  ok('outputDir 落到本机文件', localStored() && localStored().outputDir === path.join(root, 'out'))
}

{
  fresh()
  // 先写一个合法的本机键，确保本机文件存在，再看 ffmpeg* 能不能被塞进去
  config.setConfig({ outputDir: path.join(root, 'out') })
  config.setConfig({ ffmpegPath: '/bin/sh', ffmpegMode: 'custom', ffmpegExtras: ['/bin/sh'] })
  const local = localStored() || {}
  ok('渲染层写不了 ffmpegPath', local.ffmpegPath === undefined)
  ok('渲染层写不了 ffmpegMode', local.ffmpegMode === undefined)
  ok('渲染层写不了 ffmpegExtras', local.ffmpegExtras === undefined)
  ok('ffmpeg 路径不落同步库', !JSON.stringify(stored() || {}).includes('/bin/sh'))
}

{
  fresh()
  ok('相对 outputDir 被拒', config.setConfig({ outputDir: 'relative/dir' }).outputDir === '')
}

/* ---------------------- 7b. 用户输入只留本机（artistHistory 不上云） ---------------------- */

{
  fresh()
  const cfg = config.setConfig({ artistHistory: ['Yuki', 'Mio'] })
  ok('artistHistory 出现在合并结果里', JSON.stringify(cfg.artistHistory) === '["Yuki","Mio"]', JSON.stringify(cfg.artistHistory))
  ok('artistHistory 不进同步库', !stored() || stored().artistHistory === undefined, JSON.stringify(stored()))
  ok(
    'artistHistory 落到本机文件',
    Boolean(localStored() && JSON.stringify(localStored().artistHistory) === '["Yuki","Mio"]'),
    JSON.stringify(localStored())
  )
}

{
  // 老版本把 artistHistory 存在云端：首次读取要搬回本机，并从同步库删掉
  fresh()
  db.set(KEY, JSON.stringify({ artistHistory: ['Old'], theme: 'dark' }))
  const cfg = config.getConfig()
  ok('同步库里的 artistHistory 搬到本机', JSON.stringify(cfg.artistHistory) === '["Old"]', JSON.stringify(cfg.artistHistory))
  ok('本机文件里有 artistHistory', Boolean(localStored() && localStored().artistHistory[0] === 'Old'), JSON.stringify(localStored()))
  ok('同步库里删除 artistHistory', stored() && stored().artistHistory === undefined, JSON.stringify(stored()))
  ok('同步库保留其他偏好', stored() && stored().theme === 'dark')
}

{
  // 本机目录兜底已移除家目录：即使 HOME 可写也不该在 ~ 下建 .utools-audio-toolbox
  fresh()
  config.getConfig()
  ok('不在家目录建 .utools-audio-toolbox', !fs.existsSync(path.join(root, '.utools-audio-toolbox')))
  ok('本机配置落在 userData', fs.existsSync(LOCAL_FILE) || fs.existsSync(LOCAL_DIR), LOCAL_DIR)
}

/* ---------------------- 8. 非法输入与体积 / 键数上限 ---------------------- */

{
  // 8KB 是防未来的兜底：删掉 params 后，所有单键上限之和已远小于它，正常配置触发不到。
  // 这里验证的是「不认识的键不会把内容带进同步库」。
  fresh()
  config.setConfig({ theme: 'dark' })
  config.setConfig({ params: Object.fromEntries(Array.from({ length: 64 }, (_, i) => [`k${i}`, 'x'.repeat(300)])) })
  const after = JSON.parse(db.get(KEY))
  ok('未登记键的内容不进同步库', !JSON.stringify(after).includes('x'.repeat(300)), JSON.stringify(Object.keys(after)))
  ok('既有键未被破坏', after.theme === 'dark')
}

{
  fresh()
  config.setConfig({ theme: 'dark' })
  const before = db.get(KEY)
  const wide = {}
  for (let i = 0; i < 40; i += 1) wide[`k${i}`] = i
  config.setConfig(wide)
  ok('键数超限整份拒写', db.get(KEY) === before)
}

{
  fresh()
  config.setConfig({ theme: 'dark' })
  const before = db.get(KEY)
  config.setConfig([1, 2, 3])
  config.setConfig('nope')
  ok('非纯对象整份拒写', db.get(KEY) === before)
}

/* ---------------------- 9. 迁移：legacy 绝对路径键搬到本机 ---------------------- */

{
  fresh()
  db.set(KEY, JSON.stringify({ ffmpegPath: '/opt/homebrew/bin/ffmpeg', ffmpegMode: 'custom', theme: 'dark', junk: 1 }))
  const cfg = config.getConfig()
  ok('迁移后配置能读到 ffmpegPath', cfg.ffmpegPath === '/opt/homebrew/bin/ffmpeg')
  ok('迁移后同步库不再有 ffmpegPath', stored() && stored().ffmpegPath === undefined)
  ok('迁移后保留合法的同步键', stored() && stored().theme === 'dark')
  ok('迁移顺带清掉脏键', stored() && stored().junk === undefined)
  ok('迁移结果落到本机文件', localStored() && localStored().ffmpegPath === '/opt/homebrew/bin/ffmpeg')
}

/* ---------------------- 9b. outputDir 永不从同步库迁移 ---------------------- */

{
  // 老版本的 setConfig 不校验路径，同步库里的 outputDir 可能是渲染层任意写的，
  // 而启动时会拿它恢复写白名单——所以迁移只搬 ffmpeg*，outputDir 一律丢弃
  fresh()
  const legacyOut = path.join(root, 'legacy-out')
  fs.mkdirSync(legacyOut, { recursive: true })
  db.set(KEY, JSON.stringify({ ffmpegPath: '/opt/homebrew/bin/ffmpeg', outputDir: legacyOut, theme: 'dark' }))
  const cfg = config.getConfig()
  ok('同步库里的 outputDir 不被迁移', cfg.outputDir === '', JSON.stringify(cfg.outputDir))
  ok('本机文件里没有 outputDir', !localStored() || localStored().outputDir === undefined, JSON.stringify(localStored()))
  ok('ffmpeg 路径仍然迁移（来源可证明）', localStored() && localStored().ffmpegPath === '/opt/homebrew/bin/ffmpeg')
  ok('同步库里的 outputDir 被删除', stored() && stored().outputDir === undefined)
}

{
  // 已经升级过一次的用户：本机文件是 v1，里面的 outputDir 同样来路不明，读到就丢
  fresh()
  fs.mkdirSync(LOCAL_DIR, { recursive: true })
  fs.writeFileSync(
    LOCAL_FILE,
    JSON.stringify({ version: 1, outputDir: path.join(root, 'v1-out'), ffmpegPath: '/usr/local/bin/ffmpeg' }),
    'utf8'
  )
  const cfg = config.getConfig()
  ok('v1 本机文件里的 outputDir 被丢弃', cfg.outputDir === '', JSON.stringify(cfg.outputDir))
  ok('v1 本机文件里的 ffmpegPath 保留', cfg.ffmpegPath === '/usr/local/bin/ffmpeg', cfg.ffmpegPath)
}

/* ---------------------- 10. 读侧归正：畸形老值回落到默认 ---------------------- */

{
  fresh()
  db.set(KEY, JSON.stringify({ theme: 123, artistHistory: 'x', targetLufs: 'loud', concurrency: 99, hiddenFeatures: [1] }))
  const cfg = config.getConfig()
  ok('畸形 theme 回落默认', cfg.theme === 'light', `got=${cfg.theme}`)
  ok('畸形 artistHistory 回落空数组', JSON.stringify(cfg.artistHistory) === '[]')
  ok('畸形 targetLufs 回落默认', cfg.targetLufs === -18, `got=${cfg.targetLufs}`)
  ok('越界 concurrency 读侧夹取', cfg.concurrency === 4, `got=${cfg.concurrency}`)
  ok('畸形 hiddenFeatures 回落空数组', JSON.stringify(cfg.hiddenFeatures) === '[]')
  ok('未知键不会出现在结果里', cfg.junk === undefined)
}

/* ---------------------- 11. setLocal 的边界 ---------------------- */

{
  fresh()
  config.setLocal({ ffmpegMode: 'host' })
  ok('setLocal 写入合法枚举', localStored() && localStored().ffmpegMode === 'host')
  config.setLocal({ ffmpegMode: 'evil' })
  ok('setLocal 非法枚举不覆盖旧值', localStored() && localStored().ffmpegMode === 'host')
  config.setLocal({ ffmpegExtras: ['relative/path', '/usr/local/bin/ffmpeg'] })
  const extras = (localStored() && localStored().ffmpegExtras) || []
  ok('setLocal 丢弃相对路径', extras.length === 1 && extras[0] === '/usr/local/bin/ffmpeg', JSON.stringify(extras))
  ok('setLocal 完全不写同步库', writes.length === 0 && !db.get(KEY), JSON.stringify(writes))
}

/* ---------------------- 12. 本机目录不可写：只留内存，不上云 ---------------------- */

{
  // 把三个候选目录全都弄成不可写：getPath 返回空串，TMPDIR 指向一个普通文件
  // （在其下 mkdir 会 ENOTDIR），这样 resolveLocal() 必然判定 unavailable。
  fresh()
  const blockFile = path.join(root, 'not-a-dir')
  fs.writeFileSync(blockFile, 'x')
  const savedTmp = process.env.TMPDIR
  const savedGetPath = global.window.utools.getPath
  process.env.TMPDIR = blockFile
  global.window.utools.getPath = () => ''
  config.reset()

  const saved = config.setConfig({ outputDir: '/tmp/should-stay-local' })
  ok('降级时内存里仍能读到设置', saved.outputDir === '/tmp/should-stay-local', JSON.stringify(saved.outputDir))
  ok('降级标记为真', saved._localDegraded === true)
  ok('降级时本机键不写同步库（路径不上云）', writes.length === 0 && !JSON.stringify([...db.values()]).includes('should-stay-local'), JSON.stringify([...db.values()]))
  ok('降级时不在家目录建目录', !fs.existsSync(path.join(root, '.utools-audio-toolbox')))

  process.env.TMPDIR = savedTmp
  global.window.utools.getPath = savedGetPath
  config.reset()
}

fs.rmSync(root, { recursive: true, force: true })

console.log(`\n通过 ${pass} 项`)
if (fails.length) {
  console.log(`失败 ${fails.length} 项：`)
  for (const f of fails) console.log('  ✗', f)
  process.exit(1)
}
console.log('✓ 配置键表与归正全部符合预期')
