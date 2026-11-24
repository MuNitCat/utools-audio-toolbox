/**
 * 路径白名单（preload/lib/guard.js）的断言脚本。
 * 直接 node scripts/check/guard.test.mjs 运行，不依赖测试框架。
 */
import { createRequire } from 'node:module'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

const require = createRequire(import.meta.url)
const guard = require('../../preload/lib/guard.js')

let pass = 0
const fails = []

/**
 * @param {string} name 用例名
 * @param {boolean} cond 断言条件
 * @param {string} [detail] 失败时打印的细节
 */
function ok(name, cond, detail = '') {
  if (cond) pass += 1
  else fails.push(`${name}${detail ? ' → ' + detail : ''}`)
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-test-'))
const work = path.join(root, 'work')
const outside = path.join(root, 'outside')
fs.mkdirSync(work, { recursive: true })
fs.mkdirSync(outside, { recursive: true })
fs.mkdirSync(path.join(work, 'sub'), { recursive: true })

const src = path.join(work, 'a.flac')
fs.writeFileSync(src, 'x')
const foreign = path.join(outside, 'secret.txt')
fs.writeFileSync(foreign, 'secret')

// 1. norm 拒绝危险路径
ok('相对路径被拒', !guard.norm('a.mp3').ok)
ok('.. 段被拒', !guard.norm(path.join(work, '..', 'etc', 'passwd')).ok)
ok('控制字符被拒', !guard.norm(`${work}/a\u0000b`).ok)
ok('设备路径被拒', !guard.norm('\\\\?\\C:\\Windows\\x').ok || process.platform !== 'win32')
ok('不存在的路径（不允许缺失）被拒', !guard.norm(path.join(work, 'nope.m4a')).ok)
ok('允许缺失时通过', guard.norm(path.join(work, 'nope.m4a'), { allowMissing: true }).ok)

// 2. 未授权时一切读/删/写都拒绝
ok('未授权读被拒', !guard.assertReadFile(src).ok)
ok('未授权删被拒', !guard.assertDelete(src).ok)
ok('未授权写被拒', !guard.assertWriteTarget(path.join(work, 'out.m4a'), { overwrite: true }).ok)
ok('未授权列目录被拒', !guard.assertReadDir(work).ok)

// 3. 授权文件 → 可读 + 父目录可写 + 但不可删
const g = guard.grantPaths([src])
ok('grantPaths 计数', g.granted === 1 && g.denied.length === 0)
ok('授权后可读', guard.assertReadFile(src).ok)
ok('授权后可写同级输出', guard.assertWriteTarget(path.join(work, 'out.m4a'), { overwrite: true }).ok)
ok('只授权直接父目录（子目录不可写）', !guard.assertWriteTarget(path.join(work, 'sub', 'out.m4a'), { overwrite: true }).ok)
ok('授权不等于可删', !guard.assertDelete(src).ok)

// 4. produced：删 / 覆盖
const out = path.join(work, 'out.m4a')
fs.writeFileSync(out, 'y')
ok('未登记产出不可删', !guard.assertDelete(out).ok)
ok('产出登记', guard.noteProduced(out).ok)
ok('登记后可删', guard.assertDelete(out).ok)
fs.writeFileSync(foreign, 'secret')

// 5. 覆盖语义：非本次产出、即便 overwrite=true 也拒绝
const existing = path.join(work, 'exists.m4a')
fs.writeFileSync(existing, 'z')
const noOverwrite = guard.assertWriteTarget(existing, { overwrite: false })
ok('已存在 + overwrite=false → EEXISTS', !noOverwrite.ok && noOverwrite.code === 'EEXISTS', JSON.stringify(noOverwrite))
const withOverwrite = guard.assertWriteTarget(existing, { overwrite: true })
ok('已存在 + overwrite=true 仍拒绝覆盖', !withOverwrite.ok && withOverwrite.code === 'EOVERWRITE_DENIED', JSON.stringify(withOverwrite))
const producedExisting = path.join(work, 'produced.m4a')
fs.writeFileSync(producedExisting, 'q')
guard.noteProduced(producedExisting)
ok('本次产出允许覆盖', guard.assertWriteTarget(producedExisting, { overwrite: true }).ok)

// 6. rename：源必须是产出，目标不能已存在
const rn = path.join(work, 'renamed.m4a')
ok('rename 源非产出被拒', !guard.assertRename(existing, rn).ok)
ok('rename 源是产出且目标不存在 → 通过', guard.assertRename(producedExisting, rn).ok)
ok('rename 目标已存在被拒', !guard.assertRename(producedExisting, existing).ok)

// 7. 符号链接逃逸：授权目录里的链接指向外部，写其内部应被拒
const link = path.join(work, 'escape')
try {
  fs.symlinkSync(outside, link, 'dir')
  const res = guard.assertWriteTarget(path.join(link, 'pwn.m4a'), { overwrite: true })
  ok('符号链接逃逸被拒', !res.ok, JSON.stringify(res))
} catch (err) {
  ok('符号链接用例（跳过：无权限）', true)
}

// 8. 目录授权：可在目录内写 & 列举
const grantedDir = guard.grantDir(work)
ok('grantDir 通过', grantedDir.ok)
ok('目录内可写', guard.assertWriteTarget(path.join(work, 'inside.m4a'), { overwrite: true }).ok)
ok('目录可列举', guard.assertReadDir(work).ok)

// 9. 临时目录：audio-batch- 前缀可删，其它文件不可
const fsx = require('../../preload/lib/fsx.js')
const tmpDir = fsx.tempDir()
const tempPath = path.join(tmpDir, 'audio-batch-123.txt')
fs.writeFileSync(tempPath, 'list')
ok('临时目录前缀文件可删', guard.assertDelete(tempPath).ok, tempPath)
const plainTemp = path.join(tmpDir, 'other-123.txt')
fs.writeFileSync(plainTemp, 'x')
ok('临时目录里的非插件文件不可删', !guard.assertDelete(plainTemp).ok)
fs.rmSync(plainTemp, { force: true })
fs.rmSync(tempPath, { force: true })

// 10. 大小写折叠（仅大小写不敏感平台）
if (process.platform === 'darwin' || process.platform === 'win32') {
  const upper = path.join(work, 'Case.m4a')
  fs.writeFileSync(upper, 'c')
  const lower = path.join(work, 'case.m4a')
  ok('大小写视为同一文件', guard.norm(upper).key === guard.norm(lower).key)
} else {
  ok('大小写折叠（Linux 跳过）', true)
}

// 11. 打开范围
ok('产出可被打开', guard.assertOpen(producedExisting).ok)
ok('外部文件不可被打开', !guard.assertOpen(foreign).ok)

// 清理
fs.rmSync(root, { recursive: true, force: true })

console.log(`\n通过 ${pass} 项`)
if (fails.length) {
  console.log(`失败 ${fails.length} 项：`)
  for (const f of fails) console.log('  ✗', f)
  process.exit(1)
}
console.log('✓ guard 全部通过')
