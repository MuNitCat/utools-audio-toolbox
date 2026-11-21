/**
 * MCP 工具定义：schema + handler。
 * handler 走与 GUI 完全相同的 features.build() 路径，保证两边产出一致。
 */

import { defaultParams, getFeature } from './features.js'
import { enqueue, waitFor } from './queue.js'
import { getState, subscribe } from './store.js'
import { TOOL_NAMES } from './tool-names.js'

/** preload 桥接对象（MCP 只在 uTools 内运行，拿不到就直接报错） */
const svc = () => window.audioServices

/* schema 片段速记：只为了少写 type/description 的样板 */
const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const num = (description, extra = {}) => ({ type: 'number', description, ...extra })
const bool = (description) => ({ type: 'boolean', description })
const pathsOf = (description) => ({
  type: 'array',
  items: { type: 'string' },
  minItems: 1,
  description
})

const OUTPUT_PROPS = {
  outputDir: str('输出目录绝对路径；不传则与原文件同目录'),
  overwrite: bool('是否允许覆盖同名文件，默认 false'),
  suffix: str('输出文件名后缀，例如 _norm')
}

/**
 * 包一层 JSON Schema 的壳，省掉重复的 type/additionalProperties。
 * @param {Record<string, object>} properties 字段定义
 * @param {string[]} [required] 必填字段
 * @returns {object} 完整 inputSchema
 */
function schema(properties, required = []) {
  return { type: 'object', additionalProperties: false, properties, required }
}

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
        if (api.renameFile(first.output, p.outputPath)) first.output = p.outputPath
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

/* ------------------------------ Schema ------------------------------ */

/**
 * 工具定义（描述 + inputSchema）。plugin.json 里的同名工具必须与这里保持一致——
 * 构建脚本只校验「名字对得上」，schema 的文案/枚举要人工同步。
 */
export const TOOL_DEFS = {
  audio_info: {
    description:
      '读取音频文件的元信息（时长、码率、采样率、声道、位深、标签、是否带内嵌封面）。不修改文件。需要知道文件参数、或为后续处理做判断时先调它。',
    inputSchema: schema({ inputPaths: pathsOf('音频文件绝对路径列表') }, ['inputPaths']),
    outputSchema: schema({
      results: { type: 'array', description: '每个文件的探测结果' }
    })
  },

  audio_convert: {
    description:
      '音频格式转换 / 码率压缩 / 重采样。支持 mp3、m4a、aac(ADTS)、flac、wav、ogg、opus、alac。注意：输出为 aac 时是无标签的裸流，一般应输出 m4a。',
    inputSchema: schema(
      {
        inputPaths: pathsOf('输入文件绝对路径列表'),
        format: str('目标格式', { enum: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'alac'] }),
        bitrate: num('有损格式码率 kbps，如 192', { minimum: 32, maximum: 512 }),
        quality: str('MP3 VBR 质量 0-9（0 最高），设置后忽略 bitrate'),
        sampleRate: num('目标采样率 Hz，如 44100 / 48000', { enum: [8000, 11025, 16000, 22050, 32000, 44100, 48000, 96000] }),
        channels: num('目标声道数', { enum: [1, 2] }),
        copy: bool('true 表示同编码直转（不重编码，最快，但不能改码率/采样率）'),
        ...OUTPUT_PROPS
      },
      ['inputPaths', 'format']
    )
  },

  audio_extract: {
    description:
      '从视频文件（mp4/mkv/mov/webm/avi 等）里提取音轨，画面与字幕全部丢弃。trackMode=first 只取第一条（默认），all 每条音轨各导一个文件（命名 原名_1/2…，不加额外后缀），mix 把所有音轨混合成一条（走 amix，需要重编码）。先调 audio_info 看 audioStreams 判断有几条轨。',
    inputSchema: schema(
      {
        inputPaths: pathsOf('视频文件绝对路径列表'),
        trackMode: str('音轨处理：first 只取第一条（默认）/ all 每条各导一个文件 / mix 混合成一条', {
          enum: ['first', 'all', 'mix']
        }),
        format: str('目标音频格式，默认 m4a', { enum: ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus', 'alac'] }),
        bitrate: num('有损格式码率 kbps；不传则沿用源音轨码率（夹在 64–320）', { minimum: 32, maximum: 512 }),
        quality: str('MP3 VBR 质量 0-9（0 最高），设置后忽略 bitrate'),
        sampleRate: num('目标采样率 Hz', { enum: [8000, 11025, 16000, 22050, 32000, 44100, 48000, 96000] }),
        channels: num('目标声道数', { enum: [1, 2] }),
        copy: bool('true 表示直接复制音轨（不重编码，最快；源编码与容器不兼容时会失败）'),
        ...OUTPUT_PROPS
      },
      ['inputPaths']
    )
  },

  audio_clip: {
    description: '按时间裁剪音频片段，可选淡入淡出。start/duration/end 支持 "00:01:30" 或纯秒数。',
    inputSchema: schema(
      {
        inputPaths: pathsOf('输入文件绝对路径列表'),
        start: str('起点，如 00:00 或 90.5'),
        duration: str('时长，如 00:30；与 end 二选一'),
        end: str('终点时间；给了 end 则忽略 duration'),
        fadeIn: num('淡入秒数'),
        fadeOut: num('淡出秒数'),
        copy: bool('流复制（快但切点不精确）'),
        format: str('输出格式', { enum: ['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus'] }),
        ...OUTPUT_PROPS
      },
      ['inputPaths', 'start']
    )
  },

  audio_merge: {
    description: '把多个音频按给定顺序合并成一个文件。参数一致时自动流复制（快），否则重编码。',
    inputSchema: schema(
      {
        inputPaths: pathsOf('按顺序排列的输入文件绝对路径列表'),
        format: str('输出格式', { enum: ['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus'] }),
        bitrate: num('有损格式码率 kbps'),
        mode: str('auto 自动 / copy 强制流复制 / reencode 强制重编码', { enum: ['auto', 'copy', 'reencode'] }),
        outputName: str('输出文件名（不含扩展名），留空用第一个文件名'),
        outputDir: OUTPUT_PROPS.outputDir,
        overwrite: OUTPUT_PROPS.overwrite
      },
      ['inputPaths']
    )
  },

  audio_edit: {
    description:
      '对音频做变速不变调、音量增益、淡入淡出，可任意组合（合成一条滤镜链，只重编码一次）。至少给一个参数。',
    inputSchema: schema(
      {
        inputPaths: pathsOf('输入文件绝对路径列表'),
        speed: num('速度倍率 0.25-4，1 表示不变', { minimum: 0.25, maximum: 4 }),
        gainDb: num('增益 dB，正数变大', { minimum: -30, maximum: 30 }),
        fadeIn: num('淡入秒数'),
        fadeOut: num('淡出秒数'),
        format: str('输出格式', { enum: ['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus'] }),
        bitrate: num('有损格式码率 kbps'),
        ...OUTPUT_PROPS
      },
      ['inputPaths']
    )
  },

  audio_normalize: {
    description:
      '按 LUFS 做响度标准化（多文件音量统一首选）。默认两遍法，先测量再套用，结果更准。音声/ASMR 建议 targetLufs=-18。',
    inputSchema: schema(
      {
        inputPaths: pathsOf('输入文件绝对路径列表'),
        targetLufs: num('目标响度 LUFS，常用 -16 / -18 / -20 / -23', { minimum: -70, maximum: -5 }),
        truePeak: num('真峰值 dBTP，默认 -3', { minimum: -9, maximum: 0 }),
        lra: num('响度范围 LRA，默认 11', { minimum: 1, maximum: 50 }),
        twoPass: bool('是否两遍法，默认 true'),
        format: str('输出格式', { enum: ['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus'] }),
        bitrate: num('有损格式码率 kbps'),
        ...OUTPUT_PROPS
      },
      ['inputPaths']
    )
  },

  audio_denoise: {
    description: 'FFT 降噪 + 高低通滤波，去掉底噪与低频轰鸣。强度 light/medium/strong。',
    inputSchema: schema(
      {
        inputPaths: pathsOf('输入文件绝对路径列表'),
        strength: str('强度', { enum: ['light', 'medium', 'strong'] }),
        highpass: num('高通频率 Hz，默认 70，去低频嗡声'),
        lowpass: num('低通频率 Hz，默认 16000'),
        format: str('输出格式', { enum: ['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus'] }),
        bitrate: num('有损格式码率 kbps'),
        ...OUTPUT_PROPS
      },
      ['inputPaths']
    )
  },

  audio_metadata: {
    description:
      '批量写音频标签（title/artist/album 等）与内嵌封面，可选把原封面导出成图片。中文日文均可。',
    inputSchema: schema(
      {
        inputPaths: pathsOf('输入文件绝对路径列表'),
        title: str('标题，留空不改'),
        artist: str('艺术家，留空不改'),
        album: str('专辑，留空不改'),
        albumArtist: str('专辑艺术家，留空不改'),
        genre: str('流派'),
        date: str('年份'),
        comment: str('备注'),
        coverPath: str('封面图片绝对路径，嵌入或替换封面'),
        extractCover: bool('是否同时把原内嵌封面导出成图片'),
        coverFormat: str('导出封面的格式', { enum: ['jpg', 'png'] }),
        outputDir: OUTPUT_PROPS.outputDir,
        suffix: OUTPUT_PROPS.suffix,
        overwrite: OUTPUT_PROPS.overwrite
      },
      ['inputPaths']
    )
  },

  audio_cover: {
    description: '提取音频内嵌封面存成 jpg/png。文件没有封面会跳过。',
    inputSchema: schema(
      {
        inputPath: str('输入文件绝对路径'),
        format: str('图片格式', { enum: ['jpg', 'png'] }),
        outputPath: str('可选：指定输出图片绝对路径'),
        outputDir: OUTPUT_PROPS.outputDir,
        suffix: OUTPUT_PROPS.suffix,
        overwrite: OUTPUT_PROPS.overwrite
      },
      ['inputPath']
    )
  },

  audio_trim_silence: {
    description: '去掉音频首尾的静音段，中间静音保留。',
    inputSchema: schema(
      {
        inputPaths: pathsOf('输入文件绝对路径列表'),
        threshold: num('静音阈值 dB，默认 -40', { minimum: -60, maximum: -10 }),
        keepEdge: num('保留边缘静音秒数，默认 0.1'),
        format: str('输出格式', { enum: ['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus'] }),
        bitrate: num('有损格式码率 kbps'),
        ...OUTPUT_PROPS
      },
      ['inputPaths']
    )
  },

  audio_split: {
    description:
      '把长音频切成多段。mode=silence 按静音自动切（先检测静音再逐段导出，适合长篇音声/ASMR）；mode=duration 按时长均分；mode=count 按份数均分。命名格式：原名_序号_开始_结束。',
    inputSchema: schema(
      {
        inputPaths: pathsOf('输入文件绝对路径列表'),
        mode: str('切分方式', { enum: ['silence', 'duration', 'count'] }),
        noise: num('静音判定阈值 dB，默认 -35；切不出来就调到 -30 或更高', { minimum: -60, maximum: -10 }),
        minSilence: num('多长的静音才算分隔，秒，默认 0.8', { minimum: 0.2, maximum: 10 }),
        minSegment: num('最短片段秒数，默认 3，低于它的碎片会被并掉', { minimum: 1, maximum: 600 }),
        pad: num('切点两侧保留的静音秒数，默认 0.15'),
        segmentSeconds: num('mode=duration 时每段秒数，默认 600'),
        count: num('mode=count 时切几份'),
        format: str('输出格式', { enum: ['mp3', 'm4a', 'flac', 'wav', 'ogg', 'opus'] }),
        fadeIn: num('每段段首微淡入秒数，默认 0.08，用于消切点爆音'),
        fadeOut: num('每段段尾微淡出秒数，默认 0.15'),
        bitrate: num('有损格式码率 kbps'),
        outputDir: OUTPUT_PROPS.outputDir,
        overwrite: OUTPUT_PROPS.overwrite
      },
      ['inputPaths']
    )
  },

  audio_visualize: {
    description: '生成频谱图或波形图 PNG，用于快速判断音质、频段分布。',
    inputSchema: schema(
      {
        inputPath: str('输入文件绝对路径'),
        kind: str('类型', { enum: ['spectrum', 'waveform'] }),
        width: num('宽度像素，默认 1920'),
        height: num('高度像素，默认 1080'),
        outputDir: OUTPUT_PROPS.outputDir,
        suffix: OUTPUT_PROPS.suffix,
        overwrite: OUTPUT_PROPS.overwrite
      },
      ['inputPath']
    )
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
