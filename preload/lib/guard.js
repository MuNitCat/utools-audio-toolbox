'use strict'

/**
 * 会话级路径白名单。
 *
 * 背景：preload 直接挂在 window 上，渲染层能调到 fs 相关方法。审核要求
 * 「只允许操作经 showOpenDialog 选择或拖入得到的路径」，因此这里维护四个集合，
 * 所有涉及文件系统的公开接口都必须先过 assert*。
 *
 * 集合：
 * - readFiles  可读文件（-i 输入、probe、coverDataUrl）
 * - readDirs   可列举目录（listMedia / isDir）
 * - writeDirs  可写目录，**只允许在其直接子级创建文件**（不做递归包含）
 * - produced   本次会话由 ffmpeg 成功写出的文件，唯一允许删除/覆盖的对象
 *
 * 临时目录不建集合，用 isTemp() 动态判断（临时文件会被批量清理，维护集合必然漏）。
 */

const fs = require('node:fs')
const path = require('node:path')

const MAX_PATH = 4096
const MAX_ANCESTOR = 32
/** macOS(APFS 默认) 与 Windows 大小写不敏感，比较前必须折叠 */
const FOLD_CASE = process.platform === 'darwin' || process.platform === 'win32'

const readFiles = new Map()
const readDirs = new Map()
const writeDirs = new Map()
const produced = new Map()

/**
 * @param {string} code 错误码
 * @param {string} message 中文说明（会直接展示给用户）
 * @returns {{ok: false, code: string, message: string}}
 */
function fail(code, message) {
  return { ok: false, code, message }
}

/**
 * 取插件临时目录。fsx 反向依赖本模块，所以这里延迟 require 避免循环加载报错。
 * @returns {string} 临时目录绝对路径；不可用时空字符串
 */
function tempDirSafe() {
  try {
    return require('./fsx').tempDir() || ''
  } catch (_) {
    return ''
  }
}

/**
 * 大小写折叠（仅比较用，绝不用于读写）。
 * @param {string} p 绝对路径
 * @returns {string} 比较键
 */
function fold(p) {
  return FOLD_CASE ? p.toLowerCase() : p
}

/**
 * 向上一层层找最近存在的祖先，把不存在的尾巴接回去。
 * @param {string} raw 绝对路径
 * @returns {string} 尽可能真实的绝对路径
 */
function realOfAncestor(raw) {
  let cursor = path.dirname(raw)
  const tail = [path.basename(raw)]
  for (let i = 0; i < MAX_ANCESTOR; i += 1) {
    try {
      const base = fs.realpathSync.native(cursor)
      return path.join(base, ...tail.slice().reverse())
    } catch (_) {
      // 继续向上
    }
    const up = path.dirname(cursor)
    if (up === cursor) break
    tail.push(path.basename(cursor))
    cursor = up
  }
  return raw
}

/**
 * 把外部路径归一成可比较的绝对路径。
 * @param {string} input 原始路径
 * @param {{allowMissing?: boolean}} [opts] 写目标可能尚不存在
 * @returns {{ok: true, path: string, key: string, exists: boolean}|{ok: false, code: string, message: string}}
 */
function norm(input, opts = {}) {
  if (typeof input !== 'string') return fail('EINVAL', '路径必须是字符串')
  const raw = input.trim()
  if (!raw) return fail('EINVAL', '路径为空')
  if (raw.length > MAX_PATH) return fail('EINVAL', '路径过长')
  if (/[\u0000-\u001f]/.test(raw)) return fail('EINVAL', '路径包含控制字符')
  if (/^\\\\[?.]\\/.test(raw)) return fail('EDEVICE', '不支持 \\\\?\\ 这类设备路径')
  if (!path.isAbsolute(raw)) return fail('ENOTABS', '必须是绝对路径')
  // 先按段拒 `..`：realpath 会把穿越吃掉，事后就看不出意图了
  if (raw.split(/[\\/]+/).includes('..')) return fail('EDOTDOT', '路径不能包含 ..')

  const exists = fs.existsSync(raw)
  let real = raw
  try {
    real = fs.realpathSync.native(raw)
  } catch (_) {
    if (exists) return fail('EREALPATH', '路径解析失败')
    if (!opts.allowMissing) return fail('ENOENT', '路径不存在')
    real = realOfAncestor(raw)
  }

  const normalized = process.platform === 'win32' ? path.win32.normalize(real) : path.normalize(real)
  return { ok: true, path: normalized, key: fold(normalized), exists }
}

/**
 * @param {string} abs 绝对路径
 * @returns {string} 其父目录的比较键
 */
function parentKey(abs) {
  return fold(path.dirname(abs))
}

/**
 * 判断 target 是否位于 dir 之内（含 dir 自身）。
 * @param {string} dirKey 目录的比较键
 * @param {string} targetKey 目标的比较键
 * @returns {boolean}
 */
function insideKey(dirKey, targetKey) {
  if (targetKey === dirKey) return true
  return targetKey.startsWith(dirKey.endsWith(path.sep) ? dirKey : dirKey + path.sep)
}

/**
 * 是否为插件临时目录里的文件（只看 utools-audio-toolbox- 前缀）。
 * @param {string} target 绝对路径
 * @returns {boolean}
 */
function isTemp(target) {
  const t = tempDirSafe()
  if (!t) return false
  const n = norm(target, { allowMissing: true })
  if (!n.ok) return false
  let tKey
  try {
    tKey = fold(fs.realpathSync.native(t))
  } catch (_) {
    tKey = fold(t)
  }
  if (!insideKey(tKey, n.key)) return false
  return path.basename(n.path).startsWith('utools-audio-toolbox-')
}

/**
 * 登记用户手势得到的路径。文件会同时授权其父目录可写（「输出到源文件同级」的依据）。
 * @param {string[]|string} paths 绝对路径，可含目录
 * @param {{write?: boolean}} [opts] write 默认 true
 * @returns {{granted: number, denied: {path: string, code: string, message: string}[]}} 逐项结果，坏路径不会导致整批失败
 */
function grantPaths(paths, opts = {}) {
  const write = opts.write !== false
  const list = Array.isArray(paths) ? paths : [paths]
  const denied = []
  let granted = 0

  for (const raw of list) {
    const n = norm(raw, { allowMissing: true })
    if (!n.ok) {
      denied.push({ path: String(raw), code: n.code, message: n.message })
      continue
    }
    let isDirectory = false
    try {
      isDirectory = fs.statSync(n.path).isDirectory()
    } catch (_) {}
    if (isDirectory) {
      readDirs.set(n.key, { path: n.path, at: Date.now() })
      if (write) writeDirs.set(n.key, { path: n.path, at: Date.now() })
    } else {
      readFiles.set(n.key, { path: n.path, at: Date.now() })
      if (write) writeDirs.set(parentKey(n.path), { path: path.dirname(n.path), at: Date.now() })
    }
    granted += 1
  }

  return { granted, denied }
}

/**
 * 登记一个「读 + 写」目录。只用于**用户手势选中的目录**（拖入/选择框里挑的是文件夹）。
 *
 * ⚠️ 输出位置不要用这个，用下面的 grantWriteDir：输出目录只需要能写，
 * 一旦同时进 readDirs，整个目录就变成可枚举（listMedia 能递归列出里面所有媒体文件），
 * 等于渲染层凭一次 getPath 就给自己扩了读权限。
 * @param {string} dir 绝对路径
 * @returns {{ok: true, path: string}|{ok: false, code: string, message: string}}
 */
function grantDir(dir) {
  const n = norm(dir, { allowMissing: true })
  if (!n.ok) return n
  readDirs.set(n.key, { path: n.path, at: Date.now() })
  writeDirs.set(n.key, { path: n.path, at: Date.now() })
  return { ok: true, path: n.path }
}

/**
 * 登记一个「只写」目录：系统桌面/下载、用户选择的输出目录、配置里的自定义输出目录。
 * 只进 writeDirs 不进 readDirs —— 写授权不等于可读，`assertReadDir` 也不看 writeDirs，
 * 所以页面即使调了 getPath('desktop')，也列不出桌面里有什么。
 * @param {string} dir 绝对路径
 * @returns {{ok: true, path: string}|{ok: false, code: string, message: string}}
 */
function grantWriteDir(dir) {
  const n = norm(dir, { allowMissing: true })
  if (!n.ok) return n
  writeDirs.set(n.key, { path: n.path, at: Date.now() })
  return { ok: true, path: n.path }
}

/**
 * 登记本次会话产出。只允许落在已授权的写目录或临时目录内。
 * 仅 preload 内部调用，不挂到 window。
 * @param {string} file 绝对路径
 * @returns {{ok: boolean, code?: string, message?: string}}
 */
function noteProduced(file) {
  const n = norm(file, { allowMissing: true })
  if (!n.ok) return n
  if (!isTemp(n.path) && !writeDirs.has(parentKey(n.path))) {
    return fail('EPRODUCE_DENIED', '产出路径不在允许的目录内')
  }
  produced.set(n.key, { path: n.path, at: Date.now() })
  return { ok: true }
}

/**
 * @param {string} target 绝对路径
 * @returns {{ok: true, path: string, code?: undefined}|{ok: false, code: string, message: string}}
 */
function assertReadFile(target) {
  const n = norm(target)
  if (!n.ok) return n
  if (readFiles.has(n.key) || produced.has(n.key) || isTemp(n.path)) return n
  if (readDirs.has(parentKey(n.path))) return n
  return fail('EREAD_DENIED', `未授权的文件路径：${n.path}（请先在界面添加该文件）`)
}

/**
 * 枚举目录里的文件需要「读」授权。**不认 writeDirs**：
 * 输出位置只授权写，不允许页面反查目录内容（审核意见：getPath('desktop') 曾能列出整个桌面）。
 * @param {string} target 目录绝对路径
 * @returns {{ok: true, path: string}|{ok: false, code: string, message: string}}
 */
function assertReadDir(target) {
  const n = norm(target)
  if (!n.ok) return n
  if (readDirs.has(n.key) || isTemp(n.path)) return n
  return fail('EDIR_DENIED', `未授权的目录：${n.path}`)
}

/**
 * @param {string} target 目录绝对路径
 * @returns {{ok: true, path: string}|{ok: false, code: string, message: string}}
 */
function assertWriteDir(target) {
  const n = norm(target, { allowMissing: true })
  if (!n.ok) return n
  if (writeDirs.has(n.key)) return n
  return fail('EWRITE_DENIED', `未授权的输出目录：${n.path}`)
}

/**
 * 只探测存在性（前端用它做 `(1)(2)` 重名检测），不参与覆盖决策。
 * @param {string} target 绝对路径
 * @returns {{ok: true, path: string, exists: boolean}|{ok: false, code: string, message: string}}
 */
function assertProbe(target) {
  const n = norm(target, { allowMissing: true })
  if (!n.ok) return n
  if (!writeDirs.has(parentKey(n.path)) && !isTemp(n.path)) {
    return fail('EPROBE_DENIED', `不允许探测该位置：${n.path}`)
  }
  return { ok: true, path: n.path, exists: n.exists }
}

/**
 * 校验一个写目标。exists 为 true 时只有「本次产出 / 临时文件」允许覆盖。
 * @param {string} target 绝对路径
 * @param {{overwrite?: boolean}} [opts] overwrite 只放宽到本次产出，绝不放宽到任意文件
 * @returns {{ok: true, path: string, exists: boolean}|{ok: false, code: string, message: string}}
 */
function assertWriteTarget(target, opts = {}) {
  const n = norm(target, { allowMissing: true })
  if (!n.ok) return n
  if (!writeDirs.has(parentKey(n.path))) {
    return fail('EWRITE_DENIED', `输出路径不在允许的目录内：${n.path}`)
  }
  if (!n.exists) return { ok: true, path: n.path, exists: false }
  if (produced.has(n.key) || isTemp(n.path)) return { ok: true, path: n.path, exists: true }
  if (!opts.overwrite) return fail('EEXISTS', `目标已存在：${n.path}`)
  return fail('EOVERWRITE_DENIED', `已阻止覆盖非本次产出的文件：${n.path}`)
}

/**
 * 删除只允许「本次产出」与临时文件。
 * @param {string} target 绝对路径
 * @returns {{ok: true, path: string, temp?: boolean}|{ok: false, code: string, message: string}}
 */
function assertDelete(target) {
  const n = norm(target, { allowMissing: true })
  if (!n.ok) return n
  if (isTemp(n.path)) return { ok: true, path: n.path, temp: true }
  if (produced.has(n.key)) return { ok: true, path: n.path }
  return fail('EDELETE_DENIED', `已阻止删除：该文件不是本次会话的产出（${n.path}）`)
}

/**
 * @param {string} from 源文件
 * @param {string} to 目标路径
 * @returns {{ok: true, from: string, to: string}|{ok: false, code: string, message: string}}
 */
function assertRename(from, to) {
  const f = norm(from)
  if (!f.ok) return f
  if (!produced.has(f.key) && !isTemp(f.path)) {
    return fail('ERENAME_SRC_DENIED', '已阻止移动：源文件不是本次会话的产出')
  }
  const t = assertWriteTarget(to, { overwrite: false })
  if (!t.ok) return t
  if (t.exists) return fail('EEXISTS', `目标已存在，不会覆盖：${t.path}`)
  return { ok: true, from: f.path, to: t.path }
}

/**
 * 系统打开（打开所在文件夹 / 打开文件）允许的范围：已授权读、已产出、临时文件、已授权目录。
 * @param {string} target 绝对路径
 * @returns {{ok: true, path: string, kind: 'file'|'dir'}|{ok: false, code: string, message: string}}
 */
function assertOpen(target) {
  const n = norm(target)
  if (!n.ok) return n
  let kind = 'file'
  try {
    kind = fs.statSync(n.path).isDirectory() ? 'dir' : 'file'
  } catch (_) {}
  if (kind === 'dir') {
    if (readDirs.has(n.key) || writeDirs.has(n.key) || isTemp(n.path)) return { ok: true, path: n.path, kind }
    return fail('EOPEN_DENIED', `未授权的目录：${n.path}`)
  }
  if (readFiles.has(n.key) || produced.has(n.key) || isTemp(n.path) || readDirs.has(parentKey(n.path))) {
    return { ok: true, path: n.path, kind }
  }
  return fail('EOPEN_DENIED', `未授权的文件：${n.path}`)
}

/**
 * 清空全部授权（测试用；插件重进时进程会重建，无需显式调用）。
 * @returns {void} 无返回值
 */
function reset() {
  readFiles.clear()
  readDirs.clear()
  writeDirs.clear()
  produced.clear()
}

/**
 * @returns {{readFiles: number, readDirs: number, writeDirs: number, produced: number}} 各集合规模，调试用
 */
function stats() {
  return { readFiles: readFiles.size, readDirs: readDirs.size, writeDirs: writeDirs.size, produced: produced.size }
}

module.exports = {
  norm,
  isTemp,
  grantPaths,
  grantDir,
  grantWriteDir,
  noteProduced,
  assertReadFile,
  assertReadDir,
  assertProbe,
  assertWriteDir,
  assertWriteTarget,
  assertDelete,
  assertRename,
  assertOpen,
  reset,
  stats
}
