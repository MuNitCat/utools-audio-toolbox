import { readFile, writeFile, cp, readdir, stat, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOL_NAMES } from '../src/core/tool-names.js'
import { TOOL_DEFS } from '../src/core/tool-schemas.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dist = path.join(root, 'dist')

function fail(message) {
  console.error(`\n✗ 构建校验失败：${message}\n`)
  process.exit(1)
}

async function main() {
  // 1. plugin.json：tools 从 TOOL_DEFS 生成（唯一来源），再剥掉 development
  const raw = JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8'))
  if ('tools' in raw) {
    fail('plugin.json 不应再手写 tools：工具 schema 的唯一来源是 src/core/tool-schemas.js')
  }

  const declared = Object.keys(TOOL_DEFS)
  const missing = TOOL_NAMES.filter((n) => !declared.includes(n))
  const extra = declared.filter((n) => !TOOL_NAMES.includes(n))
  if (missing.length) fail(`tool-schemas.js 缺少工具定义：${missing.join(', ')}`)
  if (extra.length) fail(`tool-schemas.js 多出未登记的工具：${extra.join(', ')}`)

  for (const name of declared) {
    const def = TOOL_DEFS[name]
    if (!def || typeof def.description !== 'string' || !def.description.trim()) {
      fail(`工具 ${name} 缺少 description`)
    }
    const s = def.inputSchema
    if (!s || typeof s !== 'object') fail(`工具 ${name} 的 inputSchema 必须是有效 JSON Schema 对象`)
    if (s.type !== 'object' || s.additionalProperties !== false) {
      fail(`工具 ${name} 的 inputSchema 必须是 object 且 additionalProperties=false`)
    }
    if (s.required && !s.required.every((k) => k in (s.properties || {}))) {
      fail(`工具 ${name} 的 required 里有未声明的字段`)
    }
  }

  const manifest = {
    main: raw.main,
    logo: raw.logo,
    preload: raw.preload,
    pluginSetting: raw.pluginSetting,
    features: raw.features,
    tools: TOOL_DEFS
  }
  if ('development' in manifest) fail('development 字段没有被剥掉')
  await writeFile(path.join(dist, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  // 2. preload（CommonJS，独立 package.json 声明 type）
  await cp(path.join(root, 'preload'), path.join(dist, 'preload'), { recursive: true })

  // 2.1 shared/：preload 的 lib/exts.js 用 require('../../shared/exts.json') 读它，
  // 前端的 src/core/paths.js 读的是同一份文件（构建时内联进 JS）。产物里必须带上。
  await cp(path.join(root, 'shared'), path.join(dist, 'shared'), { recursive: true })

  // 3. logo
  await cp(path.join(root, 'logo.png'), path.join(dist, 'logo.png'))

  // 4. 校验产物
  const required = ['index.html', 'plugin.json', 'logo.png', 'preload/index.js', 'shared/exts.json']
  for (const file of required) {
    const full = path.join(dist, file)
    const st = await stat(full).catch(() => null)
    if (!st) fail(`产物缺少 ${file}`)
  }

  // preload 安全基线：白名单模块必须在、版本号必须和新前端匹配，防止「前端改了 preload 忘了拷」
  const preloadSrc = await readFile(path.join(dist, 'preload/index.js'), 'utf8')
  if (!preloadSrc.includes("require('./lib/guard')")) fail('preload/index.js 没有接入路径白名单（lib/guard）')
  if (!preloadSrc.includes("require('./lib/argswhitelist')") && !preloadSrc.includes("lib/ffmpeg.js")) {
    fail('preload 缺少参数白名单接入')
  }
  const guardFile = await stat(path.join(dist, 'preload/lib/guard.js')).catch(() => null)
  const whitelistFile = await stat(path.join(dist, 'preload/lib/argswhitelist.js')).catch(() => null)
  if (!guardFile || !whitelistFile) fail('产物缺少 preload/lib/guard.js 或 argswhitelist.js')

  // 扩展名数据：音频/视频清单唯一来源是 shared/exts.json，plugin.json 的文件关联列表必须与它一致。
  // 这两处以前是三份手抄（preload、前端、plugin.json），现在数据只剩一份，这里守住「清单别漂」。
  const extsRaw = JSON.parse(await readFile(path.join(root, 'shared/exts.json'), 'utf8'))
  const audio = extsRaw.audio
  const video = extsRaw.video
  for (const [label, list] of [['audio', audio], ['video', video]]) {
    if (!Array.isArray(list) || !list.length) fail(`shared/exts.json 的 ${label} 必须是非空数组`)
    const bad = list.filter((e) => typeof e !== 'string' || !/^[a-z0-9]{1,8}$/.test(e))
    if (bad.length) fail(`shared/exts.json 的 ${label} 里有非法扩展名：${bad.join(', ')}`)
    if (new Set(list).size !== list.length) fail(`shared/exts.json 的 ${label} 有重复项`)
  }
  const wantExts = [...audio, ...video]
  const filesCmd = (manifest.features || [])
    .flatMap((f) => f.cmds || [])
    .find((c) => c && c.type === 'files')
  if (!filesCmd) fail('plugin.json 的 features 里没有 files 类型的命令')
  const gotExts = filesCmd.extensions || []
  const lost = wantExts.filter((e) => !gotExts.includes(e))
  const extraExts = gotExts.filter((e) => !wantExts.includes(e))
  if (lost.length || extraExts.length) {
    fail(`plugin.json 的文件关联扩展名与 shared/exts.json 不一致：缺少 [${lost.join(', ')}] 多出 [${extraExts.join(', ')}]`)
  }

  const html = await readFile(path.join(dist, 'index.html'), 'utf8')
  if (!/src="\.\/assets\//.test(html)) fail('index.html 未使用相对路径引用资源（base 配置有误？）')

  const walk = async (dir) => {
    const out = []
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) out.push(...(await walk(full)))
      else out.push(full)
    }
    return out
  }

  const files = await walk(dist)
  const binaries = files.filter((f) => /(^|[/\\])(ffmpeg|ffprobe|ffplay)(\.exe)?$/i.test(f))
  if (binaries.length) fail(`产物里不应包含 ffmpeg 二进制：${binaries.join(', ')}`)

  let total = 0
  for (const f of files) total += (await stat(f)).size
  const mb = total / 1024 / 1024
  if (mb > 3) fail(`产物 ${mb.toFixed(2)}MB 超过 3MB 上限`)

  console.log(`✓ plugin.json 已生成（${declared.length} 个工具，无 development 字段）`)
  console.log(`✓ 扩展名数据 ${wantExts.length} 条，与 plugin.json 的文件关联列表一致`)
  console.log(`✓ 产物 ${files.length} 个文件，共 ${mb.toFixed(2)}MB`)
  console.log(`✓ 无 ffmpeg/ffprobe 二进制`)
  console.log(`\n下一步：uTools 开发者工具 → 选择目录 ${dist} → 打包`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
