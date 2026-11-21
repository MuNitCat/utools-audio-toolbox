import { readFile, writeFile, cp, readdir, stat, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TOOL_NAMES } from '../src/core/tool-names.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const dist = path.join(root, 'dist')

function fail(message) {
  console.error(`\n✗ 构建校验失败：${message}\n`)
  process.exit(1)
}

async function main() {
  // 1. plugin.json：剥掉 development，只保留规范字段
  const raw = JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8'))
  const declared = Object.keys(raw.tools || {})

  const missing = TOOL_NAMES.filter((n) => !declared.includes(n))
  const extra = declared.filter((n) => !TOOL_NAMES.includes(n))
  if (missing.length) fail(`plugin.json 缺少工具声明：${missing.join(', ')}`)
  if (extra.length) fail(`plugin.json 多出未实现的工具：${extra.join(', ')}`)

  for (const name of declared) {
    const def = raw.tools[name]
    if (!def.inputSchema || typeof def.inputSchema !== 'object') {
      fail(`工具 ${name} 的 inputSchema 必须是有效 JSON Schema 对象`)
    }
  }

  const manifest = {
    main: raw.main,
    logo: raw.logo,
    preload: raw.preload,
    pluginSetting: raw.pluginSetting,
    features: raw.features,
    tools: raw.tools
  }
  if ('development' in manifest) fail('development 字段没有被剥掉')
  await writeFile(path.join(dist, 'plugin.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  // 2. preload（CommonJS，独立 package.json 声明 type）
  await cp(path.join(root, 'preload'), path.join(dist, 'preload'), { recursive: true })

  // 3. logo
  await cp(path.join(root, 'logo.png'), path.join(dist, 'logo.png'))

  // 4. 校验产物
  const required = ['index.html', 'plugin.json', 'logo.png', 'preload/index.js']
  for (const file of required) {
    const full = path.join(dist, file)
    const st = await stat(full).catch(() => null)
    if (!st) fail(`产物缺少 ${file}`)
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
  console.log(`✓ 产物 ${files.length} 个文件，共 ${mb.toFixed(2)}MB`)
  console.log(`✓ 无 ffmpeg/ffprobe 二进制`)
  console.log(`\n下一步：uTools 开发者工具 → 选择目录 ${dist} → 打包`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
