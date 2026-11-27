'use strict'

/**
 * ffmpeg 进程管理。
 *
 * 两条后端：
 *   1. 系统已安装的 ffmpeg —— 用 child_process.spawn 直接跑，自带 -progress 解析
 *   2. uTools 宿主内置  —— utools.runFFmpeg()，进度由宿主给
 * 默认优先系统版（版本更新、且同目录通常有 ffprobe）；找不到才退回宿主。
 * 见 lib/binaries.js。
 */

const { spawn } = require('node:child_process')
const binaries = require('./binaries')
const guard = require('./guard')
const fsx = require('./fsx')
const { validateRunArgs, validateCaptureArgs } = require('./argswhitelist')

/** 参数白名单需要的能力集合（注入而不是直接依赖，方便单测） */
const ARG_CTX = {
  assertRead: guard.assertReadFile,
  assertWriteTarget: guard.assertWriteTarget,
  isTemp: guard.isTemp,
  // concat 列表逐条校验要读列表内容；fsx.readText 无权限门槛，仅用于临时目录内的文件
  readText: fsx.readText
}

/**
 * @param {string} reason 中文原因
 * @returns {Error} code=EARGS_INVALID 的错误（不设 tail/log，界面直接显示这句）
 */
function argError(reason) {
  const err = new Error(`参数未通过安全校验：${reason}`)
  err.code = 'EARGS_INVALID'
  err.stage = 'validate'
  return err
}

const procs = new Map()
const MAX_LINES = 60

function createRing(limit = MAX_LINES) {
  const lines = []
  return {
    push(chunk) {
      const parts = String(chunk).split(/\r?\n/)
      for (const p of parts) {
        if (!p) continue
        lines.push(p)
      }
      if (lines.length > limit) lines.splice(0, lines.length - limit)
    },
    tail(n = 20) {
      return lines.slice(-n).join('\n')
    },
    text() {
      return lines.join('\n')
    }
  }
}

function utoolsApi() {
  return (typeof window !== 'undefined' ? window.utools : globalThis.utools) || {}
}

/** 把 -progress pipe:1 -nostats 插到输出参数之前（所有 args 构造器都以 output 结尾） */
function withProgress(args) {
  if (args.includes('-progress')) return args
  if (args.length < 2) return args
  return [...args.slice(0, -1), '-nostats', '-progress', 'pipe:1', args[args.length - 1]]
}

function hms(seconds) {
  const s = Math.max(0, Number(seconds) || 0)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = (s % 60).toFixed(2).padStart(5, '0')
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec}`
}

/* --------------------------- 后端 1：系统 ffmpeg --------------------------- */

function spawnRun(id, bin, args, opts = {}) {
  const { onProgress, onLog } = opts
  const ring = createRing()
  const finalArgs = onProgress ? withProgress(args) : args

  return new Promise((resolve, reject) => {
    let child
    try {
      child = spawn(bin, finalArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      reject(err)
      return
    }
    procs.set(id, { kind: 'spawn', child })

    let duration = 0
    let outTime = 0
    let speed = ''
    let size = ''
    let emitted = 0

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      const text = String(chunk)
      ring.push(text)
      if (onLog) onLog(text)
      if (!duration) {
        const m = text.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/)
        if (m) duration = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
      }
    })

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        const idx = line.indexOf('=')
        if (idx < 0) continue
        const key = line.slice(0, idx)
        const value = line.slice(idx + 1).trim()
        if (key === 'out_time_us' || key === 'out_time_ms') {
          // 两个键的历史实现都是微秒
          const us = Number(value)
          if (Number.isFinite(us) && us >= 0) outTime = us / 1e6
        } else if (key === 'speed') {
          speed = value
        } else if (key === 'total_size') {
          const bytes = Number(value)
          size = Number.isFinite(bytes) ? `${(bytes / 1024).toFixed(0)} KiB` : ''
        } else if (key === 'progress' && onProgress) {
          const now = Date.now()
          // ffmpeg 默认 0.5s 一条，再兜一层节流
          if (now - emitted < 120) continue
          emitted = now
          const percent = duration > 0 ? Math.min(99.9, (outTime / duration) * 100) : undefined
          onProgress({
            bitrate: '',
            fps: 0,
            frame: 0,
            percent,
            q: 0,
            size,
            speed,
            time: hms(outTime)
          })
        }
      }
    })

    child.on('error', (err) => {
      procs.delete(id)
      err.tail = ring.tail(20)
      err.log = ring.text()
      reject(err)
    })

    child.on('close', (code, signal) => {
      procs.delete(id)
      if (code === 0) {
        resolve()
        return
      }
      const err = new Error(`ffmpeg 退出码 ${code}${signal ? ` (${signal})` : ''}`)
      err.tail = ring.tail(20)
      err.log = ring.text()
      reject(err)
    })
  })
}

/* -------------------------- 后端 2：uTools 宿主 -------------------------- */

function hostRun(id, args, opts = {}) {
  const { onProgress, onLog } = opts
  const ring = createRing()

  return new Promise((resolve, reject) => {
    let proc
    try {
      proc = utoolsApi().runFFmpeg(args, {
        onProgress: (p) => {
          if (onProgress) onProgress(p)
        },
        onLog: (text) => {
          ring.push(text)
          if (onLog) onLog(text)
        }
      })
    } catch (err) {
      reject(err)
      return
    }
    if (!proc || typeof proc.then !== 'function') {
      reject(new Error('utools.runFFmpeg 未返回可等待的进程对象'))
      return
    }
    procs.set(id, { kind: 'host', proc })
    proc.then(
      () => {
        procs.delete(id)
        resolve()
      },
      (err) => {
        procs.delete(id)
        const e = err instanceof Error ? err : new Error(String(err))
        e.tail = ring.tail(20)
        e.log = ring.text()
        reject(e)
      }
    )
  })
}

/* ------------------------------ 对外 API ------------------------------ */

/**
 * 执行 ffmpeg（唯一入口，index / probe / previewer 都走这里，保证参数一定过白名单）。
 * @param {string} id 任务 id
 * @param {string[]} args 参数数组
 * @param {{onProgress?: Function, onLog?: Function}} [opts] 回调
 * @returns {Promise<void>} 进程结束后 resolve；参数不合规时 reject
 * @throws {Error} EARGS_INVALID 或 ffmpeg 自身失败
 */
async function run(id, args, opts = {}) {
  const chk = validateRunArgs(args, ARG_CTX)
  if (!chk.ok) throw argError(chk.error)
  // 先登记「本次产出」再执行：任务中途失败/被取消时，半成品也归本次会话所有，
  // 否则队列的失败清理会被白名单挡掉，残留文件删不掉
  if (chk.output) guard.noteProduced(chk.output)
  const bin = binaries.ffmpegPath()
  if (bin) {
    await spawnRun(id, bin, args, opts)
  } else {
    await hostRun(id, args, opts)
  }
}

/**
 * 采集模式：把 stderr 全量收下来（静音检测 / loudnorm 分析需要读日志）。
 * 探测类命令以非零退出是常态，所以只在拿到空文本时才 reject。
 * @param {string} id 进程登记键（取消/查询都用它）
 * @param {string[]} args 已校验的参数
 * @param {{timeout?: number}} [opts] timeout 毫秒；超时走既有 cancel（SIGTERM→SIGKILL / quit→kill）
 * @returns {Promise<{ok:boolean, text:string, error?:Error}>}
 */
function capture(id, args, opts = {}) {
  // 采集只允许 probe.js 的两种形态，避免绕开 run 的校验
  const chk = validateCaptureArgs(args, ARG_CTX)
  if (!chk.ok) return Promise.reject(argError(chk.error))

  const ring = createRing(500000)
  const bin = binaries.ffmpegPath()
  const timeout = Number(opts.timeout) > 0 ? Number(opts.timeout) : 0

  /**
   * 超时守卫：到点先置标记，再复用既有 cancel 终止进程（不另写 kill，避免两套终止逻辑）。
   * 返回的 stop 必须在 settle 时调用，否则定时器可能在进程结束后再 cancel 一次。
   * @param {() => void} onTimeout 超时回调，用来把结果标成「探测超时」而不是退出码
   * @returns {{start: () => void, stop: () => void}} 启动与清理
   */
  const timeoutGuard = (onTimeout) => {
    let timer = null
    return {
      start() {
        if (!timeout) return
        timer = setTimeout(() => {
          onTimeout()
          try {
            cancel(id)
          } catch (_) {}
        }, timeout)
        if (typeof timer.unref === 'function') timer.unref()
      },
      stop() {
        if (timer) clearTimeout(timer)
        timer = null
      }
    }
  }

  if (bin) {
    return new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
      } catch (err) {
        reject(err)
        return
      }
      procs.set(id, { kind: 'spawn', child })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => ring.push(chunk))
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => ring.push(chunk))

      let timedOut = false
      const guard = timeoutGuard(() => {
        timedOut = true
      })
      guard.start()

      child.on('error', (err) => {
        guard.stop()
        procs.delete(id)
        err.text = ring.text()
        reject(err)
      })
      child.on('close', (code) => {
        guard.stop()
        procs.delete(id)
        const text = ring.text()
        if (code === 0) resolve({ ok: true, text })
        else resolve({ ok: false, text, error: new Error(timedOut ? '探测超时' : `ffmpeg 退出码 ${code}`) })
      })
    })
  }

  return new Promise((resolve, reject) => {
    let proc
    try {
      proc = utoolsApi().runFFmpeg(args, { onLog: (text) => ring.push(text) })
    } catch (err) {
      reject(err)
      return
    }
    if (!proc || typeof proc.then !== 'function') {
      reject(new Error('utools.runFFmpeg 未返回可等待的进程对象'))
      return
    }
    procs.set(id, { kind: 'host', proc })

    let timedOut = false
    const guard = timeoutGuard(() => {
      timedOut = true
    })
    guard.start()

    proc.then(
      () => {
        guard.stop()
        procs.delete(id)
        resolve({ ok: true, text: ring.text() })
      },
      (err) => {
        guard.stop()
        procs.delete(id)
        const text = [ring.text(), err && err.message].filter(Boolean).join('\n')
        resolve({ ok: false, text, error: timedOut ? new Error('探测超时') : err })
      }
    )
  })
}

/** 用户主动取消：宿主走 quit→kill，spawn 走 SIGTERM→SIGKILL */
function cancel(id) {
  const entry = procs.get(id)
  if (!entry) return false

  if (entry.kind === 'spawn') {
    try {
      entry.child.kill('SIGTERM')
    } catch (_) {}
    setTimeout(() => {
      try {
        entry.child.kill('SIGKILL')
      } catch (_) {}
      procs.delete(id)
    }, 1200)
    return true
  }

  try {
    if (typeof entry.proc.quit === 'function') entry.proc.quit()
  } catch (_) {}
  setTimeout(() => {
    try {
      if (typeof entry.proc.kill === 'function') entry.proc.kill()
    } catch (_) {}
    procs.delete(id)
  }, 1200)
  return true
}

function isRunning(id) {
  return procs.has(id)
}

module.exports = { run, capture, cancel, isRunning, createRing }
