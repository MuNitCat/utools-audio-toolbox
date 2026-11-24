/**
 * MCP 工具实现：handler + 注册。
 * schema 在 ./tool-schemas.js（构建脚本也读它生成 plugin.json.tools）。
 * handler 走与 GUI 完全相同的 features.build() 路径，保证两边产出一致。
 */

import { defaultParams, getFeature } from './features.js'
import { enqueue, waitFor } from './queue.js'
import { getState, subscribe } from './store.js'
import { TOOL_NAMES } from './tool-names.js'
import { TOOL_DEFS } from './tool-schemas.js'

/** preload 桥接对象（MCP 只在 uTools 内运行，拿不到就直接报错） */
const svc = () => window.audioServices

/* ------------------------------ 执行辅助 ------------------------------ */

/**
 * 探测输入文件，组装成 buildTasks 需要的 files 结构。
 * 只要有一个文件可读就继续（其余带 error 一起进任务，最后单独报）。
 * @param {string|string[]} inputPaths 一个或多个绝对路径
 * @returns {Promise<{path: string, info: object, error: string}[]>} 与入参顺序对齐
 * @throws {Error} preload 未就绪、路径为空或全部文件不可读时抛出
 */
async function prepare(inputPaths) {
  const api = svc()
  if (!api) throw new Error('audioServices 未就绪（请在 uTools 内运行）')
  const list = (Array.isArray(inputPaths) ? inputPaths : [inputPaths]).filter(Boolean)
  if (!list.length) throw new Error('inputPaths 不能为空')

  const infos = await api.probeMany(list)
  const okCount = infos.filter((i) => i.ok).length
  if (!okCount) {
    const first = infos[0]
    throw new Error(`无法读取音频文件：${first.name}（${first.error || '未知原因'}）`)
  }
  return list.map((path, i) => ({ path, info: infos[i], error: infos[i].ok ? '' : infos[i].error }))
}

/**
 * 把队列进度转成 MCP 的 sendProgress。
 * 只有百分比整数变化才上报，避免 10Hz 的进度把 Agent 刷爆。
 * @param {object[]} tasks 本次任务快照
 * @param {object} ctx MCP 调用上下文（可能没有 sendProgress）
 * @returns {() => void} 取消订阅函数
 */
function monitor(tasks, ctx) {
  if (!ctx || typeof ctx.sendProgress !== 'function') return () => {}
  const ids = new Set(tasks.map((t) => t.id))
  let last = -1
  const unsubscribe = subscribe(() => {
    const mine = getState().tasks.filter((t) => ids.has(t.id))
    if (!mine.length) return
    const avg = mine.reduce((sum, t) => sum + (t.progress || 0), 0) / mine.length
    const pct = Math.max(0, Math.min(100, Math.floor(avg)))
    if (pct === last) return
    last = pct
    const running = mine.find((t) => t.status === 'running')
    ctx
      .sendProgress({
        progress: pct,
        total: 100,
        message: running ? `${running.message} ${pct}%` : `已完成 ${pct}%`
      })
      .catch(() => {})
  })
  return unsubscribe
}

/**
 * 从 store 里取任务终态，整理成对 Agent 友好的结果。
 * @param {object[]} tasks 本次任务快照
 * @returns {{results: object[], succeeded: number, failed: number, total: number}}
 */
function collect(tasks) {
  const state = getState()
  const results = tasks.map((origin) => {
    const cur = state.tasks.find((t) => t.id === origin.id) || origin
    return {
      input: cur.input,
      output: cur.output || '',
      outputs: cur.outputs || [],
      ok: cur.status === 'done',
      status: cur.status,
      error: cur.error || (cur.status === 'skipped' ? cur.message || '已跳过' : '')
    }
  })
  const succeeded = results.filter((r) => r.ok).length
  return { results, succeeded, failed: results.length - succeeded, total: results.length }
}

/**
 * MCP 的统一执行入口：和 GUI 共用 features.build()，只是不经过 React。
 * 单个文件失败不抛错，只有全部失败才抛（让 Agent 拿到真正的原因）。
 * @param {{featureId: string, params?: object, inputPaths: string|string[], ctx?: object}} job 任务描述
 * @returns {Promise<{results: object[], succeeded: number, failed: number, total: number}>}
 * @throws {Error} 未知功能、preload 未就绪或全部文件处理失败时抛出
 */
async function runJob({ featureId, params, inputPaths, ctx }) {
  const feature = getFeature(featureId)
  if (!feature) throw new Error(`未知功能：${featureId}`)

  // outputDir 来自 AI 入参，不在白名单里就直接拒绝（不等到 ffmpeg 阶段才失败）
  const api = svc()
  if (params && params.outputDir && api && typeof api.checkDir === 'function') {
    const chk = api.checkDir(params.outputDir)
    if (!chk || !chk.ok) {
      throw new Error(`输出目录未授权：${params.outputDir}。请让用户在插件界面里选择一次该目录，或改用源文件同级/下载目录。`)
    }
  }

  const files = await prepare(inputPaths)
  const merged = { ...defaultParams(feature), ...(params || {}) }
  const tasks = enqueue({ featureId, params: merged, files })

  const stop = monitor(tasks, ctx)
  try {
    await waitFor(tasks)
  } finally {
    stop()
  }

  const summary = collect(tasks)
  if (summary.succeeded === 0) {
    const reason = summary.results.find((r) => r.error)?.error || '全部失败'
    throw new Error(reason)
  }
  return summary
}

/* ------------------------------ Handler ------------------------------ */

/**
 * 工具实现表。每个 handler 只做「schema 字段 → 功能参数」的搬运，
 * 真正的执行一律走 runJob，保证 GUI 与 MCP 产出一致。
 */
const handlers = {
  async audio_info({ inputPaths }) {
    const api = svc()
    const list = (Array.isArray(inputPaths) ? inputPaths : [inputPaths]).filter(Boolean)
    if (!list.length) throw new Error('inputPaths 不能为空')
    const infos = await api.probeMany(list)
    return {
      results: infos.map((i) => ({
        path: i.path,
        name: i.name,
        ok: i.ok,
        error: i.error || '',
        format: i.format,
        duration: i.duration,
        durationEstimated: i.durationEstimated,
        bitrateKbps: i.bitrate,
        codec: i.codec,
        sampleRate: i.sampleRate,
        channels: i.channels,
        channelLayout: i.channelLayout,
        bitsPerSample: i.bitsPerSample,
        hasCover: i.hasCover,
        hasVideo: Boolean(i.hasVideo),
        audioStreams: i.audioStreams || 1,
        sizeBytes: i.size,
        tags: i.tags || {}
      }))
    }
  },

  async audio_convert(p) {
    return runJob({
      featureId: 'convert',
      inputPaths: p.inputPaths,
      ctx: p.__ctx,
      params: {
        format: p.format,
        bitrate: p.bitrate,
        quality: p.quality,
        sampleRate: p.sampleRate,
        channels: p.channels,
        copy: p.copy,
        outputDir: p.outputDir,
        suffix: p.suffix,
        overwrite: p.overwrite
      }
    })
  },

  async audio_extract(p) {
    return runJob({
      featureId: 'extract',
      inputPaths: p.inputPaths,
      ctx: p.__ctx,
      params: {
        trackMode: p.trackMode || 'first',
        format: p.format || 'm4a',
        bitrate: p.bitrate,
        quality: p.quality,
        sampleRate: p.sampleRate,
        channels: p.channels,
        copy: Boolean(p.copy),
        outputDir: p.outputDir,
        suffix: p.suffix,
        overwrite: p.overwrite
      }
    })
  },

  async audio_clip(p) {
    return runJob({
      featureId: 'clip',
      inputPaths: p.inputPaths,
      ctx: p.__ctx,
      params: {
        start: p.start,
        endMode: p.end ? 'end' : 'duration',
        duration: p.duration,
        end: p.end,
        fadeIn: p.fadeIn,
        fadeOut: p.fadeOut,
        copy: p.copy,
        format: p.format,
        outputDir: p.outputDir,
        suffix: p.suffix,
        overwrite: p.overwrite
      }
    })
  },

  async audio_merge(p) {
    return runJob({
      featureId: 'merge',
      inputPaths: p.inputPaths,
      ctx: p.__ctx,
      params: {
        format: p.format,
        bitrate: p.bitrate,
        mode: p.mode,
        name: p.outputName,
        outputDir: p.outputDir,
        overwrite: p.overwrite
      }
    })
  },

  async audio_edit(p) {
    return runJob({
      featureId: 'edit',
      inputPaths: p.inputPaths,
      ctx: p.__ctx,
      params: {
        speed: p.speed,
        gainDb: p.gainDb,
        fadeIn: p.fadeIn,
        fadeOut: p.fadeOut,
        format: p.format,
        bitrate: p.bitrate,
        outputDir: p.outputDir,
        suffix: p.suffix,
        overwrite: p.overwrite
      }
    })
  },

  async audio_normalize(p) {
    return runJob({
      featureId: 'normalize',
      inputPaths: p.inputPaths,
      ctx: p.__ctx,
      params: {
        targetLufs: p.targetLufs === undefined ? '-18' : String(p.targetLufs),
        truePeak: p.truePeak,
        lra: p.lra,
        twoPass: p.twoPass === undefined ? true : p.twoPass,
        format: p.format,
        bitrate: p.bitrate,
        outputDir: p.outputDir,
        suffix: p.suffix,
        overwrite: p.overwrite
      }
    })
  },

  async audio_denoise(p) {
    return runJob({
      featureId: 'denoise',
      inputPaths: p.inputPaths,
      ctx: p.__ctx,
      params: {
        strength: p.strength,
        highpass: p.highpass,
        lowpass: p.lowpass,
        format: p.format,
        bitrate: p.bitrate,
        outputDir: p.outputDir,
        suffix: p.suffix,
        overwrite: p.overwrite
      }
    })
  },

  async audio_metadata(p) {
    return runJob({
      featureId: 'metadata',
      inputPaths: p.inputPaths,
      ctx: p.__ctx,
      params: {
        title: p.title,
        artist: p.artist,
        album: p.album,
        albumArtist: p.albumArtist,
        genre: p.genre,
        date: p.date,
        comment: p.comment,
        coverPath: p.coverPath,
        extractCover: Boolean(p.extractCover),
        coverFormat: p.coverFormat || 'jpg',
        outputDir: p.outputDir,
        suffix: p.suffix,
        overwrite: p.overwrite
      }
    })
  },

  async audio_cover(p) {
    const summary = await runJob({
      featureId: 'cover',
      inputPaths: [p.inputPath],
      ctx: p.__ctx,
      params: { format: p.format || 'jpg', outputDir: p.outputDir, suffix: p.suffix, overwrite: p.overwrite }
    })
    // 允许显式指定输出路径
    if (p.outputPath) {
      const api = svc()
      const first = summary.results[0]
      if (first && first.output && first.output !== p.outputPath) {
        const res = api.renameFile(first.output, p.outputPath)
        // 新 preload 返回 {ok,code,message}；旧 preload 返回布尔值，两种都要能判断失败
        const okMove = res && typeof res === 'object' ? res.ok !== false : Boolean(res)
        if (!okMove) {
          const why = (res && res.message) || '目标不可写或已存在'
          throw new Error(`无法写到指定路径 ${p.outputPath}：${why}`)
        }
        first.output = p.outputPath
      }
    }
    return summary
  },

  async audio_trim_silence(p) {
    return runJob({
      featureId: 'trimSilence',
      inputPaths: p.inputPaths,
      ctx: p.__ctx,
      params: {
        threshold: p.threshold,
        keepEdge: p.keepEdge,
        format: p.format,
        bitrate: p.bitrate,
        outputDir: p.outputDir,
        suffix: p.suffix,
        overwrite: p.overwrite
      }
    })
  },

  async audio_split(p) {
    return runJob({
      featureId: 'split',
      inputPaths: p.inputPaths,
      ctx: p.__ctx,
      params: {
        mode: p.mode || 'silence',
        noise: p.noise,
        minSilence: p.minSilence,
        minSegment: p.minSegment,
        pad: p.pad,
        segmentSeconds: p.segmentSeconds,
        count: p.count,
        format: p.format || 'flac',
        fadeIn: p.fadeIn,
        fadeOut: p.fadeOut,
        bitrate: p.bitrate,
        outputDir: p.outputDir,
        overwrite: p.overwrite
      }
    })
  },

  async audio_visualize(p) {
    return runJob({
      featureId: 'visualize',
      inputPaths: [p.inputPath],
      ctx: p.__ctx,
      params: {
        kind: p.kind || 'spectrum',
        width: p.width,
        height: p.height,
        outputDir: p.outputDir,
        suffix: p.suffix,
        overwrite: p.overwrite
      }
    })
  }
}


/**
 * 逐个注册工具。定义缺失时直接抛错——注册期就暴露问题，好过调用时才 404。
 * @param {object} utools 宿主对象（需带 registerTool）
 * @returns {number} 注册数量
 * @throws {Error} TOOL_NAMES 里有工具缺少 TOOL_DEFS 时抛出
 */
export function registerAllTools(utools) {
  const missing = TOOL_NAMES.filter((name) => !TOOL_DEFS[name])
  if (missing.length) throw new Error(`工具缺少定义：${missing.join(', ')}`)

  for (const name of TOOL_NAMES) {
    utools.registerTool(name, async (params, ctx) => {
      const handler = handlers[name]
      if (!handler) throw new Error(`工具未实现：${name}`)
      return handler({ ...(params || {}), __ctx: ctx })
    })
  }
  return TOOL_NAMES.length
}
