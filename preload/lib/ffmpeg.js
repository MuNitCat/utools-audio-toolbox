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

function run(id, args, opts = {}) {
  const bin = binaries.ffmpegPath()
  if (bin) return spawnRun(id, bin, args, opts)
  return hostRun(id, args, opts)
}

/**
 * 采集模式：把 stderr 全量收下来（静音检测 / loudnorm 分析需要读日志）。
 * 探测类命令以非零退出是常态，所以只在拿到空文本时才 reject。
 * @returns {Promise<{ok:boolean, text:string, error?:Error}>}
 */
function capture(id, args) {
  const ring = createRing(500000)
  const bin = binaries.ffmpegPath()

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
      child.on('error', (err) => {
        procs.delete(id)
        err.text = ring.text()
        reject(err)
      })
      child.on('close', (code) => {
        procs.delete(id)
        const text = ring.text()
        if (code === 0) resolve({ ok: true, text })
        else resolve({ ok: false, text, error: new Error(`ffmpeg 退出码 ${code}`) })
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
    proc.then(
      () => {
        procs.delete(id)
        resolve({ ok: true, text: ring.text() })
      },
      (err) => {
        procs.delete(id)
        const text = [ring.text(), err && err.message].filter(Boolean).join('\n')
        resolve({ ok: false, text, error: err })
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
