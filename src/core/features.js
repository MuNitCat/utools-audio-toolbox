/**
 * 功能定义：GUI 表单（fields）与 MCP schema（mcp.js）共同的数据源。
 * build() 是唯一的参数组装入口 —— UI 和 MCP 走同一条路径，保证产出完全一致。
 *
 * 所有 build 共用下面这个契约（因此不再逐个重复 JSDoc）：
 * @param {string[]} inputs 待处理文件绝对路径
 * @param {object} params 已合并默认值的参数
 * @param {object[]} infos 与 inputs 一一对应的 probe 结果
 * @returns {{input: string, ops: object[], outputs?: string[], skip?: string}[]} 任务块；
 *   ops 为空的块会被队列标记为 skipped，outputs 用于「一个文件产出多份」的功能
 */

import * as A from './args.js'
import { FORMAT_KEYS, CONTAINERS } from './args.js'
import { parseTimeInput, clockTag } from './format.js'
import { numberedOutput, resolveOutput, stripExt } from './paths.js'

/** preload 桥接对象；SSR / 单测环境没有 window，返回 null 由调用方处理 */
const svc = () => (typeof window !== 'undefined' ? window.audioServices : null)

/**
 * 解析输出路径。规则在 src/core/paths.js（原 preload/lib/paths.js，审核要求下沉），
 * 重名冲突的 `(1)(2)` 后缀仍要通过 preload 的 exists 判断。
 * @param {string} input 输入文件绝对路径
 * @param {object} params 当前参数（读 outputDir / suffix / overwrite）
 * @param {string} ext 输出扩展名，不带点
 * @param {{name?: string}} [opts] name 为完整的输出主名（给了就忽略 suffix）
 * @returns {string} 输出文件绝对路径
 * @throws {Error} preload 未就绪时抛出
 */
function out(input, params, ext, opts = {}) {
  if (!svc()) throw new Error('audioServices 未就绪')
  return resolveOutput(input, {
    dir: params.outputDir || '',
    suffix: params.suffix || '',
    ext,
    overwrite: Boolean(params.overwrite),
    ...opts
  })
}

/**
 * 输入格式 -> 可安全写入标签/封面的容器。
 * .aac 是 ADTS 裸流，存不了标签，统一映射到 m4a。
 * @param {object} info probe 结果
 * @returns {string} CONTAINERS 的键
 */
function safeFormatFor(info) {
  const ext = (info && info.ext) || ''
  if (ext === 'aac') return 'm4a'
  if (CONTAINERS[ext]) return ext
  return 'm4a'
}

/** 各输出格式的一句话说明：卡片悬停/聚焦时作为气泡显示 */
const FORMAT_TIPS = {
  mp3: '兼容性最好，老设备都认；同码率下音质不如 aac',
  m4a: 'AAC 装进 MP4 容器，同码率比 mp3 好，苹果设备首选',
  aac: '裸 AAC 流，体积与 m4a 相近，但元数据和封面存不了',
  flac: '无损压缩，体积约为 wav 的 60%，音质不打折',
  wav: '无压缩 PCM，体积最大，剪辑软件兼容性最好',
  ogg: 'Vorbis 编码，开源格式，网页与游戏里常见',
  opus: '低码率下音质最好，适合语音与播客',
  alac: '苹果无损，需装进 m4a 容器，体积比 flac 大'
}

/** 输出格式字段：选项来自 CONTAINERS，界面用卡片网格 */
const formatField = (def = 'm4a') => ({
  key: 'format',
  label: '输出格式',
  type: 'select',
  ui: 'grid',
  default: def,
  options: FORMAT_KEYS.map((k) => ({ value: k, label: k.toUpperCase(), tip: FORMAT_TIPS[k] }))
})

const bitrateField = {
  key: 'bitrate',
  label: '码率 (kbps)',
  type: 'number',
  default: 192,
  min: 32,
  max: 512,
  step: 32,
  stepper: true,
  presets: [{ value: 'auto', label: '原样' }, 64, 96, 128, 192, 256, 320],
  hint: (p) =>
    p.bitrate === 'auto'
      ? '按每个源文件自己的码率，限制在 64–320 之间；无损源文件（flac/wav）按 320'
      : '',
  showIf: (p) => !CONTAINERS[p.format] || CONTAINERS[p.format].lossy
}

/**
 * 'auto' 取源文件码率（夹在 64–320、按 8 取整），其他值原样返回。
 * @param {number|'auto'} value 用户选择
 * @param {object} info probe 结果
 * @returns {number} 实际使用的 kbps
 */
function effectiveBitrate(value, info) {
  if (value !== 'auto') return value
  const src = Number((info && (info.streamBitrate || info.bitrate)) || 0)
  if (!src) return 192
  return Math.min(320, Math.max(64, Math.round(src / 8) * 8))
}

const suffixField = { key: 'suffix', label: '文件名后缀', type: 'text', default: '', placeholder: '例如 _compressed' }

/** 提取音轨用的码率字段：默认「原样」，避免把 320k 的源压成 192 */
const bitrateAutoField = { ...bitrateField, default: 'auto' }

/** MP3 VBR 档位：V0 最高 → V9 最小，括号里是 LAME 的典型码率 */
const MP3_QUALITY_OPTIONS = [
  { value: '', label: '跟随码率' },
  { value: '0', label: 'V0 最高 ~245k' },
  { value: '1', label: 'V1 ~225k' },
  { value: '2', label: 'V2 推荐 ~190k' },
  { value: '3', label: 'V3 ~175k' },
  { value: '4', label: 'V4 ~165k' },
  { value: '5', label: 'V5 均衡 ~130k' },
  { value: '6', label: 'V6 ~115k' },
  { value: '7', label: 'V7 ~100k' },
  { value: '8', label: 'V8 ~85k' },
  { value: '9', label: 'V9 最小 ~65k' }
]

/**
 * MP3 质量字段：只在目标是 mp3 时出现，统一用下拉（选项超过 4 个，卡片网格放不下）。
 * 选了 V 档就走可变码率，上面的「码率」会被 codecArgs 忽略。
 */
const qualityField = {
  key: 'quality',
  label: 'MP3 质量 VBR',
  type: 'select',
  ui: 'dropdown',
  default: '',
  options: MP3_QUALITY_OPTIONS,
  showIf: (p) => p.format === 'mp3',
  hint: 'V 档越大音质越好、体积越大；选 V 档会忽略上面的「码率」，「跟随码率」则按 -b:a 定码率'
}

/** LUFS 档位：按钮与「下方提示」共用同一份说明，点哪档就显示哪档 */
const LUFS_PRESETS = [
  { value: -14, label: '-14', desc: '流媒体（Spotify / YouTube）常用，整体偏响' },
  { value: -16, label: '-16', desc: '播客常用档，Apple Podcasts 按 -16 归一' },
  { value: -18, label: '-18', desc: '推荐：音声 / ASMR，还留一点动态' },
  { value: -20, label: '-20', desc: '留更多动态，适合音乐 / 环境音' },
  { value: -23, label: '-23', desc: '广播标准 EBU R128，动态最大' }
]

/**
 * 「音轨处理」下方的提示：直接显示已载入文件的音轨数（probe 的 audioStreams）。
 * @param {object} _params 未使用，保留是为了与 hint(params, ctx) 的统一签名
 * @param {{files?: object[]}} [ctx] 已载入文件（含 probe 结果）
 * @returns {string} 一行提示文案
 */
function trackHint(_params, ctx) {
  const counts = ((ctx && ctx.files) || [])
    .map((f) => Number(f && f.info && f.info.audioStreams))
    .filter((n) => Number.isFinite(n) && n > 0)
  if (!counts.length) return '添加视频后这里会显示音轨数量'
  const min = Math.min(...counts)
  const max = Math.max(...counts)
  if (min !== max) return `音轨数量不一致：${min} ~ ${max} 条`
  return `检测到 ${min} 条音轨`
}

/**
 * 提示行跟随当前数值：选到预设就显示该档说明，手输非预设值时给一句兜底。
 * @param {object} params 当前参数（读 targetLufs）
 * @returns {string} 一行提示文案
 */
function lufsHint(params) {
  const hit = LUFS_PRESETS.find((o) => o.value === Number(params.targetLufs))
  return hit ? hit.desc : '数值越大越响，没把握就用 -18'
}

/**
 * @typedef {{type:'ffmpeg', args:string[], output:string, weight:number, label:string}} Op
 */

/** 常驻功能：侧栏里不允许取消勾选（插件的主入口，不能把自己藏没了） */
export const PINNED_FEATURE_IDS = ['convert', 'extract']

/**
 * @param {string} id 功能 id
 * @returns {boolean} 是否为常驻功能（侧栏不可取消）
 */
export function isPinnedFeature(id) {
  return PINNED_FEATURE_IDS.includes(id)
}

/** 默认收起的功能：首次使用时侧栏不显示（用户可在「应用设置」里勾回来） */
export const DEFAULT_HIDDEN_FEATURES = ['visualize']

export const FEATURES = [
  /* ------------------------------- A 核心转码 ------------------------------- */
  {
    id: 'convert',
    group: 'A',
    name: '格式转换',
    desc: '任意音频格式互转，可选码率与采样率',
    tool: 'audio_convert',
    fields: [
      formatField('m4a'),
      // 默认「原样」：不指定码率就沿用源文件自己的码率，避免把 320k 的源默认压成 192k
      bitrateAutoField,
      qualityField,
      { key: 'sampleRate', label: '采样率', type: 'select', default: '', options: [
        { value: '', label: '原样', title: '保持原采样率' },
        { value: '44100', label: '44.1k' },
        { value: '48000', label: '48k' }
      ] },
      { key: 'channels', label: '声道', type: 'select', default: '', options: [
        { value: '', label: '原样', title: '保持原声道' },
        { value: '1', label: '单声道' },
        { value: '2', label: '立体声' }
      ] },
      { key: 'copy', label: '同编码直转（不重编码，最快）', type: 'switch', default: false },
      suffixField
    ],
    build(inputs, params, infos) {
      return inputs.map((input, i) => {
        const info = infos[i] || {}
        const format = params.format || safeFormatFor(info)
        const output = out(input, params, A.outputExtOf(format))
        return {
          input,
          ops: [
            {
              type: 'ffmpeg',
              args: A.convert({
                input,
                output,
                format,
                bitrate: effectiveBitrate(params.bitrate, info),
                quality: params.quality,
                compression: params.compression,
                sampleRate: params.sampleRate,
                channels: params.channels,
                copy: Boolean(params.copy),
                threadCount: params.threadCount
              }),
              output,
              weight: 1,
              label: `转换 → ${format.toUpperCase()}`
            }
          ]
        }
      })
    }
  },
  {
    id: 'extract',
    group: 'A',
    name: '视频提取音频',
    desc: '把视频里的音轨单独导出成音频',
    tool: 'audio_extract',
    fields: [
      {
        key: 'trackMode',
        label: '音轨处理',
        type: 'select',
        ui: 'segment',
        default: 'first',
        options: [
          { value: 'first', label: '仅第一条', title: '只导出第一条音轨' },
          { value: 'all', label: '逐条导出', title: '每条音轨各导出一个文件，命名 原名_1/2…' },
          { value: 'mix', label: '混合一条', title: '把所有音轨混成一条（需要重编码）' }
        ],
        hint: trackHint
      },
      {
        key: 'copy',
        label: '直接复制音轨（不重编码，最快）',
        type: 'switch',
        default: false,
        showIf: (p) => p.trackMode !== 'mix',
        hint: '要求源编码与目标容器兼容,不兼容会直接报错, mp4→m4a、mkv(opus)→opus'
      },
      formatField('m4a'),
      bitrateAutoField,
      qualityField,
      { key: 'sampleRate', label: '采样率', type: 'select', default: '', options: [
        { value: '', label: '原样', title: '保持原采样率' },
        { value: '44100', label: '44.1k' },
        { value: '48000', label: '48k' }
      ] },
      { key: 'channels', label: '声道', type: 'select', default: '', options: [
        { value: '', label: '原样', title: '保持原声道' },
        { value: '1', label: '单声道' },
        { value: '2', label: '立体声' }
      ] },
      suffixField
    ],
    build(inputs, params, infos) {
      const api = svc()
      const mode = params.trackMode || 'first'
      return inputs.map((input, i) => {
        const info = infos[i] || {}
        const format = params.format || 'm4a'
        const ext = A.outputExtOf(format)
        // 旧 preload 没有 audioStreams 字段，按单音轨处理
        const tracks = Math.max(1, Number(info.audioStreams) || 1)
        const common = {
          input,
          format,
          bitrate: effectiveBitrate(params.bitrate, info),
          quality: params.quality,
          sampleRate: params.sampleRate,
          channels: params.channels,
          copy: Boolean(params.copy),
          threadCount: params.threadCount
        }

        // 逐条导出：每条音轨一个文件，命名 原名{suffix}_1 / _2 …
        if (mode === 'all' && tracks > 1) {
          const base = stripExt(info.name || input.split('/').pop())
          const stem = `${base}${params.suffix || ''}`
          const ops = []
          for (let track = 0; track < tracks; track += 1) {
            const output = resolveOutput(input, {
              dir: params.outputDir || '',
              name: `${stem}_${track + 1}`,
              ext,
              overwrite: Boolean(params.overwrite)
            })
            ops.push({
              type: 'ffmpeg',
              args: A.extractAudio({ ...common, output, track }),
              output,
              weight: 1,
              label: `提取音轨 ${track + 1}`
            })
          }
          return { input, ops, outputs: ops.map((op) => op.output) }
        }

        const output = out(input, params, ext)
        const mixing = mode === 'mix' && tracks > 1
        return {
          input,
          ops: [
            {
              type: 'ffmpeg',
              args: A.extractAudio({ ...common, output, mix: mixing, trackCount: tracks }),
              output,
              weight: 1,
              label: mixing ? `混合 ${tracks} 条音轨 → ${format.toUpperCase()}` : `提取音频 → ${format.toUpperCase()}`
            }
          ]
        }
      })
    }
  },
  {
    id: 'compress',
    group: 'A',
    name: '码率压缩',
    desc: '保持原格式，降低码率或调整压缩等级',
    tool: 'audio_convert',
    fields: [
      bitrateField,
      qualityField,
      { key: 'compression', label: 'FLAC 压缩等级', type: 'number', default: 5, min: 0, max: 12, step: 1, showIf: (p) => p.format === 'flac' },
      suffixField
    ],
    build(inputs, params, infos) {
      return inputs.map((input, i) => {
        const info = infos[i] || {}
        const format = safeFormatFor(info)
        const output = out(input, params, A.outputExtOf(format))
        return {
          input,
          ops: [
            {
              type: 'ffmpeg',
              args: A.convert({
                input,
                output,
                format,
                bitrate: effectiveBitrate(params.bitrate, info),
                quality: params.quality,
                compression: params.compression,
                threadCount: params.threadCount
              }),
              output,
              weight: 1,
              label: `压缩 → ${effectiveBitrate(params.bitrate, info) || defaultBitrate(format)}k`
            }
          ]
        }
      })
    }
  },
  {
    id: 'edit',
    group: 'A',
    name: '综合处理',
    desc: '变速 + 增益 + 淡入淡出，一条滤镜链完成',
    tool: 'audio_edit',
    hidden: true,
    needsDuration: true,
    fields: [
      { key: 'speed', label: '速度', type: 'number', default: 1, min: 0.25, max: 4, step: 0.05 },
      { key: 'gainDb', label: '增益 (dB)', type: 'number', default: 0, min: -30, max: 30, step: 0.5 },
      { key: 'fadeIn', label: '淡入 (秒)', type: 'number', default: 0, min: 0, max: 60, step: 0.5 },
      { key: 'fadeOut', label: '淡出 (秒)', type: 'number', default: 0, min: 0, max: 60, step: 0.5 },
      suffixField
    ],
    build(inputs, params, infos) {
      return inputs.map((input, i) => {
        const info = infos[i] || {}
        const format = params.format || safeFormatFor(info)
        const output = out(input, params, A.outputExtOf(format), { suffix: params.suffix || '_edit' })
        return {
          input,
          ops: [
            {
              type: 'ffmpeg',
              args: A.edit({
                input,
                output,
                speed: Number(params.speed) || 1,
                gainDb: Number(params.gainDb) || 0,
                fadeIn: Number(params.fadeIn) || 0,
                fadeOut: Number(params.fadeOut) || 0,
                duration: Number(info.duration) || 0,
                format,
                bitrate: params.bitrate,
                threadCount: params.threadCount
              }),
              output,
              weight: 1,
              label: '综合处理'
            }
          ]
        }
      })
    }
  },
  {
    id: 'metadata',
    group: 'A',
    name: '标签与封面',
    desc: '批量写 title/artist/album，嵌入或导出封面',
    tool: 'audio_metadata',
    fields: [
      { key: 'autoFillNote', type: 'hint', text: '打开这一栏时会从列表第一个文件读一次标签填入；之后增删文件不会覆盖你的修改。' },
      { key: 'title', label: '标题', type: 'text', default: '', placeholder: '留空则不改' },
      { key: 'artist', label: '艺术家', type: 'text', default: '', placeholder: '留空则不改', suggestions: 'artists' },
      { key: 'album', label: '专辑', type: 'text', default: '', placeholder: '留空则不改' },
      { key: 'albumArtist', label: '专辑艺术家', type: 'text', default: '', placeholder: '留空则不改' },
      { key: 'genre', label: '流派', type: 'text', default: '', placeholder: '留空则不改' },
      { key: 'date', label: '年份', type: 'text', default: '', placeholder: '留空则不改' },
      { key: 'comment', label: '备注', type: 'text', default: '', placeholder: '留空则不改' },
      { key: 'coverPath', label: '封面图片', type: 'file', default: '', accept: 'image' },
      { key: 'extractCover', label: '同时导出原封面', type: 'switch', default: false },
      { key: 'coverFormat', label: '导出格式', type: 'select', default: 'jpg', options: [
        { value: 'jpg', label: 'JPG' },
        { value: 'png', label: 'PNG' }
      ], showIf: (p) => Boolean(p.extractCover) },
      { key: 'titleFromName', label: '用文件名当标题', type: 'switch', default: false },
      suffixField,
      { key: 'notice', type: 'notice', text: '只改标签也会重写整个文件（2 小时 flac 大约几秒）。' }
    ],
    build(inputs, params, infos) {
      const api = svc()
      // 只有这几种容器能可靠地放 attached_pic；wav/adts 会直接报错，静默跳过封面
      const COVER_OK = new Set(['mp3', 'm4a', 'alac', 'flac', 'ogg'])
      return inputs.map((input, i) => {
        const info = infos[i] || {}
        const format = safeFormatFor(info)
        const output = out(input, params, A.outputExtOf(format), { suffix: params.suffix || '_tagged' })
        const tags = {}
        for (const key of ['title', 'artist', 'album', 'albumArtist', 'genre', 'date', 'comment']) {
          const v = params[key]
          if (v !== undefined && v !== null && String(v).trim() !== '') tags[key] = String(v).trim()
        }
        if (params.titleFromName) tags.title = stripExt(info.name || input.split('/').pop())

        const ops = []
        // 导出原封面放在前面，让任务结束时 task.output 仍指向音频文件
        if (params.extractCover && info.hasCover) {
          const coverOut = resolveOutput(input, {
            dir: params.outputDir || '',
            suffix: params.suffix ? `${params.suffix}_cover` : '_cover',
            ext: params.coverFormat || 'jpg',
            overwrite: Boolean(params.overwrite)
          })
          ops.push({
            type: 'ffmpeg',
            args: A.extractCover({ input, output: coverOut }),
            output: coverOut,
            weight: 0.3,
            label: '导出封面'
          })
        }

        ops.push({
          type: 'ffmpeg',
          args: A.writeMetadata({
            input,
            output,
            tags,
            coverPath: COVER_OK.has(format) ? params.coverPath || '' : '',
            format,
            threadCount: params.threadCount
          }),
          output,
          weight: 1,
          label: Object.keys(tags).length || params.coverPath ? '写标签' : '复制'
        })

        return { input, ops }
      })
    }
  },

  /* ------------------ 隐藏功能：提取封面（只在 MCP 暴露） ------------------ */
  {
    id: 'cover',
    group: 'A',
    hidden: true,
    name: '提取封面',
    desc: '把内嵌封面导成图片',
    tool: 'audio_cover',
    fields: [
      { key: 'notice', type: 'notice', text: '只处理带内嵌封面的文件；没有封面会直接跳过。' },
      { key: 'format', label: '图片格式', type: 'select', default: 'jpg', options: [
        { value: 'jpg', label: 'JPG' },
        { value: 'png', label: 'PNG' }
      ] }
    ],
    build(inputs, params, infos) {
      const result = []
      inputs.forEach((input, i) => {
        const info = infos[i] || {}
        if (!info.hasCover) {
          result.push({ input, ops: [], skip: '没有内嵌封面' })
          return
        }
        const output = out(input, params, params.format || 'jpg', { suffix: params.suffix || '_cover' })
        result.push({
          input,
          ops: [
            {
              type: 'ffmpeg',
              args: A.extractCover({ input, output }),
              output,
              weight: 1,
              label: '提取封面'
            }
          ]
        })
      })
      return result
    }
  },
  /* ------------------------------ B ASMR ------------------------------ */
  {
    id: 'split',
    group: 'B',
    name: '自动切分',
    desc: '按静音/时长/份数把长音声切成多段',
    tool: 'audio_split',
    needsDuration: true,
    fields: [
      { key: 'mode', label: '切分方式', type: 'select', ui: 'segment', default: 'silence', options: [
        { value: 'silence', label: '按静音', title: '检测静音间隙自动切分（推荐）' },
        { value: 'duration', label: '按时长', title: '按固定时长均分' },
        { value: 'count', label: '按份数', title: '切成指定份数' }
      ] },
      { key: 'noise', label: '静音阈值 (dB)', type: 'number', default: -35, min: -60, max: -10, step: 1, showIf: (p) => p.mode === 'silence' },
      { key: 'minSilence', label: '最短静音 (秒)', type: 'number', default: 0.8, min: 0.2, max: 10, step: 0.1, showIf: (p) => p.mode === 'silence' },
      { key: 'minSegment', label: '最短片段 (秒)', type: 'number', default: 3, min: 1, max: 600, step: 1, showIf: (p) => p.mode === 'silence' },
      { key: 'pad', label: '静音留边 (秒)', type: 'number', default: 0.15, min: 0, max: 3, step: 0.05, showIf: (p) => p.mode === 'silence' },
      { key: 'segmentSeconds', label: '每段时长 (秒)', type: 'number', default: 600, min: 10, max: 7200, step: 10, showIf: (p) => p.mode === 'duration' },
      { key: 'count', label: '份数', type: 'number', default: 4, min: 2, max: 200, step: 1, showIf: (p) => p.mode === 'count' },
      formatField('flac'),
      { key: 'fadeIn', label: '段首微淡入 (秒)', type: 'number', default: 0.08, min: 0, max: 1, step: 0.01 },
      { key: 'fadeOut', label: '段尾微淡出 (秒)', type: 'number', default: 0.15, min: 0, max: 1, step: 0.01 }
    ],
    build(inputs, params, infos) {
      const api = svc()
      return inputs.map((input, i) => {
        const info = infos[i] || {}
        const format = params.format || 'flac'
        const duration = Number(info.duration) || 0
        const outputs = []
        const ops = []

        if (params.mode === 'duration' || params.mode === 'count') {
          const segs = planEven(duration, params)
          segs.forEach((seg, idx) => {
            const output = numberedOutput(input, idx + 1, {
              dir: params.outputDir || '',
              ext: A.outputExtOf(format),
              timeRange: `${clockTag(seg.start)}_${clockTag(seg.end)}`
            })
            outputs.push(output)
            ops.push({
              type: 'ffmpeg',
              args: A.splitSegment({
                input,
                output,
                start: seg.start,
                duration: seg.end - seg.start,
                fadeIn: params.fadeIn,
                fadeOut: params.fadeOut,
                format,
                bitrate: params.bitrate,
                threadCount: params.threadCount
              }),
              output,
              weight: 1,
              label: `切分 #${idx + 1}`
            })
          })
          return { input, ops, outputs }
        }

        // 静音模式：先探测（第一阶段），第二阶段的切点由运行时动态生成
        return {
          input,
          ops: [
            {
              type: 'ffmpeg',
              args: A.silenceDetect({ input, noise: params.noise, minSilence: params.minSilence }),
              output: '',
              weight: 0.2,
              label: '检测静音',
              capture: true,
              parse: 'silence',
              dynamic: 'splitSegments',
              params
            }
          ]
        }
      })
    }
  },
  {
    id: 'trimSilence',
    group: 'B',
    name: '去首尾静音',
    desc: '掐掉开头结尾的空白',
    tool: 'audio_trim_silence',
    fields: [
      { key: 'threshold', label: '静音阈值 (dB)', type: 'number', default: -40, min: -60, max: -10, step: 1 },
      { key: 'keepEdge', label: '保留边缘静音 (秒)', type: 'number', default: 0.1, min: 0, max: 3, step: 0.05 },
      suffixField
    ],
    build(inputs, params, infos) {
      return inputs.map((input, i) => {
        const info = infos[i] || {}
        const format = params.format || safeFormatFor(info)
        const output = out(input, params, A.outputExtOf(format), { suffix: params.suffix || '_trimmed' })
        return {
          input,
          ops: [
            {
              type: 'ffmpeg',
              args: A.trimSilence({
                input,
                output,
                threshold: params.threshold,
                keepEdge: params.keepEdge,
                format,
                bitrate: params.bitrate,
                threadCount: params.threadCount
              }),
              output,
              weight: 1,
              label: '去首尾静音'
            }
          ]
        }
      })
    }
  },
  {
    id: 'fade',
    group: 'B',
    name: '淡入淡出',
    desc: '给首尾加淡入淡出包边',
    tool: 'audio_edit',
    needsDuration: true,
    fields: [
      { key: 'fadeIn', label: '淡入 (秒)', type: 'number', default: 2, min: 0, max: 60, step: 0.5 },
      { key: 'fadeOut', label: '淡出 (秒)', type: 'number', default: 3, min: 0, max: 60, step: 0.5 },
      suffixField
    ],
    build(inputs, params, infos) {
      return inputs.map((input, i) => {
        const info = infos[i] || {}
        const format = params.format || safeFormatFor(info)
        const output = out(input, params, A.outputExtOf(format), { suffix: params.suffix || '_fade' })
        return {
          input,
          ops: [
            {
              type: 'ffmpeg',
              args: A.edit({
                input,
                output,
                fadeIn: params.fadeIn,
                fadeOut: params.fadeOut,
                duration: Number(info.duration) || 0,
                format,
                bitrate: params.bitrate,
                threadCount: params.threadCount
              }),
              output,
              weight: 1,
              label: '淡入淡出'
            }
          ]
        }
      })
    }
  },
  /* ---------------------------- C 音频工程 ---------------------------- */
  {
    id: 'clip',
    group: 'C',
    name: '时间裁剪',
    desc: '截取指定区间，可选淡入淡出',
    tool: 'audio_clip',
    needsDuration: true,
    fields: [
      { key: 'start', label: '起点', type: 'time', default: '00:00' },
      { key: 'endMode', label: '截止方式', type: 'select', default: 'duration', options: [
        { value: 'duration', label: '按时长' },
        { value: 'end', label: '按终点' }
      ] },
      { key: 'duration', label: '时长', type: 'time', default: '00:30', showIf: (p) => p.endMode !== 'end' },
      { key: 'end', label: '终点', type: 'time', default: '', showIf: (p) => p.endMode === 'end' },
      { key: 'fadeIn', label: '淡入 (秒)', type: 'number', default: 0, min: 0, max: 30, step: 0.1 },
      { key: 'fadeOut', label: '淡出 (秒)', type: 'number', default: 0, min: 0, max: 30, step: 0.1 },
      { key: 'copy', label: '流复制（快，但切点不精确）', type: 'switch', default: false },
      suffixField
    ],
    build(inputs, params, infos) {
      return inputs.map((input, i) => {
        const info = infos[i] || {}
        const format = safeFormatFor(info)
        const output = out(input, params, A.outputExtOf(params.format || format), { suffix: params.suffix || '_clip' })
        const start = parseTimeInput(params.start)
        const duration = params.endMode === 'end' ? 0 : parseTimeInput(params.duration)
        const end = params.endMode === 'end' ? parseTimeInput(params.end) : 0
        return {
          input,
          ops: [
            {
              type: 'ffmpeg',
              args: A.clip({
                input,
                output,
                start,
                duration,
                end,
                fadeIn: params.fadeIn,
                fadeOut: params.fadeOut,
                format: params.format || format,
                copy: Boolean(params.copy),
                threadCount: params.threadCount
              }),
              output,
              weight: 1,
              label: '裁剪'
            }
          ]
        }
      })
    }
  },
  {
    id: 'merge',
    group: 'C',
    name: '合并拼接',
    desc: '把多个文件按顺序合成一个',
    tool: 'audio_merge',
    multi: true,
    fields: [
      formatField('m4a'),
      bitrateField,
      { key: 'mode', label: '模式', type: 'select', default: 'auto', options: [
        { value: 'auto', label: '自动（能直连就直连）' },
        { value: 'copy', label: '强制流复制' },
        { value: 'reencode', label: '强制重编码' }
      ] },
      { key: 'name', label: '输出文件名', type: 'text', default: '', placeholder: '留空用第一个文件名' }
    ],
    build(inputs, params, infos) {
      if (!inputs.length) return []
      const api = svc()
      const format = params.format || 'm4a'
      const first = inputs[0]
      const output = out(first, { ...params, suffix: params.suffix || '_merged' }, A.outputExtOf(format), {
        name: params.name || ''
      })

      const sameParams =
        inputs.every((_, i) => {
          const info = infos[i] || {}
          const ref = infos[0] || {}
          return (
            info.sampleRate === ref.sampleRate &&
            info.channels === ref.channels &&
            info.codec === ref.codec
          )
        }) && inputs.every((_, i) => ((infos[i] || {}).ext || '') === ((infos[0] || {}).ext || ''))

      // FLAC 的 concat + copy 会写出错误的 STREAMINFO 总采样数（只有第一段），
      // 播放器会把时长当成分段长度 —— 所以 flac 一律重编码（无损，代价可控）。
      const copyUnsafe = format === 'flac'
      const useCopy = params.mode === 'copy' || (params.mode === 'auto' && sameParams && !copyUnsafe)

      let args
      if (useCopy) {
        // concat 列表由 preload 从已授权路径拼装（makeConcatList 逐条过白名单），
        // 渲染层不再有「任意文本写临时目录」的接口
        const listFile = api.makeConcatList(inputs)
        args = A.mergeCopy({ listFile, output, format, threadCount: params.threadCount })
      } else {
        args = A.mergeReencode({
          inputs,
          output,
          format,
          bitrate: effectiveBitrate(params.bitrate, infos[0]),
          threadCount: params.threadCount
        })
      }

      return [
        {
          input: first,
          ops: [
            {
              type: 'ffmpeg',
              args,
              output,
              weight: 1,
              label: useCopy ? '合并（流复制）' : '合并（重编码）'
            }
          ]
        }
      ]
    }
  },
  {
    id: 'normalize',
    group: 'C',
    name: '响度标准化',
    desc: '按 LUFS 统一响度，两遍法更准',
    tool: 'audio_normalize',
    needsDuration: true,
    fields: [
      {
        key: 'targetLufs',
        label: '目标响度 (LUFS)',
        type: 'number',
        default: -18,
        min: -30,
        max: -5,
        step: 1,
        stepper: true,
        presets: LUFS_PRESETS.map((o) => ({ value: o.value, label: o.label, title: o.desc })),
        hint: lufsHint
      },
      { key: 'truePeak', label: '真峰值 (dBTP)', type: 'number', default: -3, min: -9, max: 0, step: 0.5 },
      { key: 'lra', label: '响度范围 LRA', type: 'number', default: 11, min: 1, max: 50, step: 1 },
      { key: 'twoPass', label: '两遍法（多跑一次但更准）', type: 'switch', default: true },
      suffixField
    ],
    build(inputs, params, infos) {
      return inputs.map((input, i) => {
        const info = infos[i] || {}
        const format = params.format || safeFormatFor(info)
        const output = out(input, params, A.outputExtOf(format), { suffix: params.suffix || '_norm' })
        const common = {
          input,
          output,
          targetLufs: Number(params.targetLufs) || -18,
          truePeak: Number(params.truePeak),
          lra: Number(params.lra),
          format,
          bitrate: params.bitrate,
          threadCount: params.threadCount
        }
        const ops = []
        if (params.twoPass) {
          ops.push({
            type: 'ffmpeg',
            args: A.loudnormAnalyze(common),
            output: '',
            weight: 0.25,
            label: '测量响度',
            capture: true,
            parse: 'loudnorm'
          })
        }
        ops.push({
          type: 'ffmpeg',
          args: A.loudnormApply({ ...common, measured: {} }),
          rebuild: (m) => A.loudnormApply({ ...common, measured: m || {} }),
          output,
          weight: params.twoPass ? 0.75 : 1,
          label: '标准化'
        })
        return { input, ops }
      })
    }
  },
  {
    id: 'resample',
    group: 'C',
    name: '重采样 / 声道',
    desc: '统一采样率与声道数，便于合并与入库',
    tool: 'audio_convert',
    fields: [
      { key: 'sampleRate', label: '采样率', type: 'select', default: '48000', options: [
        { value: '', label: '原样', title: '保持原采样率' },
        { value: '44100', label: '44.1k' },
        { value: '48000', label: '48k' }
      ] },
      { key: 'channels', label: '声道', type: 'select', default: '2', options: [
        { value: '', label: '原样', title: '保持原声道' },
        { value: '1', label: '单声道' },
        { value: '2', label: '立体声' }
      ] },
      suffixField
    ],
    build(inputs, params, infos) {
      return inputs.map((input, i) => {
        const info = infos[i] || {}
        const format = params.format || safeFormatFor(info)
        const output = out(input, params, A.outputExtOf(format), { suffix: params.suffix || '_resampled' })
        return {
          input,
          ops: [
            {
              type: 'ffmpeg',
              args: A.convert({
                input,
                output,
                format,
                sampleRate: params.sampleRate,
                channels: params.channels,
                bitrate: params.bitrate,
                threadCount: params.threadCount
              }),
              output,
              weight: 1,
              label: `重采样 ${params.sampleRate || '原样'}Hz / ${params.channels || '原'}ch`
            }
          ]
        }
      })
    }
  },
  {
    id: 'denoise',
    group: 'C',
    name: 'FFT 降噪',
    desc: '滤掉底噪与低频轰鸣',
    tool: 'audio_denoise',
    fields: [
      { key: 'strength', label: '强度', type: 'select', default: 'medium', options: [
        { value: 'light', label: '轻（保留细节）' },
        { value: 'medium', label: '中（推荐）' },
        { value: 'strong', label: '重（可能发闷）' }
      ] },
      { key: 'highpass', label: '高通 (Hz)', type: 'number', default: 70, min: 0, max: 500, step: 10 },
      { key: 'lowpass', label: '低通 (Hz)', type: 'number', default: 16000, min: 2000, max: 22000, step: 500 },
      suffixField
    ],
    build(inputs, params, infos) {
      return inputs.map((input, i) => {
        const info = infos[i] || {}
        const format = params.format || safeFormatFor(info)
        const output = out(input, params, A.outputExtOf(format), { suffix: params.suffix || '_dn' })
        return {
          input,
          ops: [
            {
              type: 'ffmpeg',
              args: A.denoise({
                input,
                output,
                strength: params.strength,
                highpass: params.highpass,
                lowpass: params.lowpass,
                format,
                bitrate: params.bitrate,
                threadCount: params.threadCount
              }),
              output,
              weight: 1,
              label: '降噪'
            }
          ]
        }
      })
    }
  },
  {
    id: 'speed',
    group: 'C',
    name: '变速不变调',
    desc: '改变播放速度，音高保持不变',
    tool: 'audio_edit',
    needsDuration: true,
    fields: [
      {
        key: 'speed',
        label: '速度倍率',
        type: 'number',
        default: 1.25,
        min: 0.5,
        max: 2,
        step: 0.05,
        stepper: true,
        presets: [
          { value: 0.5, label: '0.5x' },
          { value: 0.75, label: '0.75x' },
          { value: 1, label: '1x' },
          { value: 1.25, label: '1.25x' },
          { value: 1.5, label: '1.5x' },
          { value: 2, label: '2x' }
        ],
        hint: '1 为原速；0.5x 放慢一半，2x 快一倍，音高始终不变。可手动输入（步长 0.05）或点下面的常用倍率'
      },
      suffixField
    ],
    build(inputs, params, infos) {
      return inputs.map((input, i) => {
        const info = infos[i] || {}
        const format = params.format || safeFormatFor(info)
        const output = out(input, params, A.outputExtOf(format), { suffix: params.suffix || `_${params.speed}x` })
        return {
          input,
          ops: [
            {
              type: 'ffmpeg',
              args: A.edit({
                input,
                output,
                speed: Number(params.speed) || 1,
                format,
                threadCount: params.threadCount
              }),
              output,
              weight: 1,
              label: `变速 ${params.speed}x`
            }
          ]
        }
      })
    }
  },
  {
    id: 'gain',
    group: 'C',
    name: '音量增益',
    desc: '整体加减 dB，超过 +6dB 自动限幅',
    tool: 'audio_edit',
    fields: [
      { key: 'gainDb', label: '增益 (dB)', type: 'number', default: 3, min: -30, max: 30, step: 0.5 },
      suffixField
    ],
    build(inputs, params, infos) {
      return inputs.map((input, i) => {
        const info = infos[i] || {}
        const format = params.format || safeFormatFor(info)
        const output = out(input, params, A.outputExtOf(format), { suffix: params.suffix || `_${params.gainDb}dB` })
        return {
          input,
          ops: [
            {
              type: 'ffmpeg',
              args: A.edit({
                input,
                output,
                gainDb: Number(params.gainDb) || 0,
                format,
                threadCount: params.threadCount
              }),
              output,
              weight: 1,
              label: `增益 ${params.gainDb}dB`
            }
          ]
        }
      })
    }
  },

  /* ------------------------------ D 辅助 ------------------------------ */
  {
    id: 'visualize',
    group: 'D',
    name: '频谱 / 波形图',
    desc: '导出一张频谱图或波形图',
    tool: 'audio_visualize',
    fields: [
      { key: 'kind', label: '类型', type: 'select', default: 'spectrum', options: [
        { value: 'spectrum', label: '频谱图' },
        { value: 'waveform', label: '波形图' }
      ] },
      { key: 'width', label: '宽度', type: 'number', default: 1920, min: 320, max: 4096, step: 16 },
      { key: 'height', label: '高度', type: 'number', default: 1080, min: 200, max: 2160, step: 16 }
    ],
    build(inputs, params, infos) {
      return inputs.map((input) => {
        const output = out(input, params, 'png', { suffix: params.suffix || `_${params.kind || 'spectrum'}` })
        return {
          input,
          ops: [
            {
              type: 'ffmpeg',
              args: A.visualize({
                input,
                output,
                kind: params.kind,
                width: params.width,
                height: params.height
              }),
              output,
              weight: 1,
              label: params.kind === 'waveform' ? '波形图' : '频谱图'
            }
          ]
        }
      })
    }
  }
]

/**
 * 无损格式在界面上没有码率可显示，给个占位；有损给常用值。
 * @param {string} format CONTAINERS 的键
 * @returns {number|string} 建议码率，无损返回「—」
 */
function defaultBitrate(format) {
  const c = CONTAINERS[format]
  if (!c || !c.lossy) return '—'
  if (format === 'opus') return 96
  return 192
}

/**
 * 按份数或每段时长均分。
 * @param {number} duration 总时长（秒）
 * @param {object} params 读 mode / count / segmentSeconds
 * @returns {{start: number, end: number}[]} 片段列表；时长未知时为空数组
 */
function planEven(duration, params) {
  const total = Number(duration) || 0
  if (total <= 0) return []
  let pieces = 0
  if (params.mode === 'count') pieces = Math.round(Number(params.count) || 0)
  else pieces = Math.ceil(total / (Number(params.segmentSeconds) || 600))
  if (pieces <= 0) return []
  const step = total / pieces
  const segs = []
  for (let i = 0; i < pieces; i += 1) {
    segs.push({ start: i * step, end: Math.min(total, (i + 1) * step) })
  }
  return segs
}

export const FEATURE_MAP = FEATURES.reduce((acc, f) => {
  acc[f.id] = f
  return acc
}, {})

/**
 * @param {string} id 功能 id
 * @returns {object|null} 功能定义；不存在时返回 null
 */
export function getFeature(id) {
  return FEATURE_MAP[id] || null
}

/**
 * @param {string} group 分组 id（A/B/C/D）
 * @returns {object[]} 该分组下的功能，保持声明顺序
 */
export function featuresOfGroup(group) {
  return FEATURES.filter((f) => f.group === group)
}

/**
 * 生成功能默认参数（notice/hint 这类纯展示字段不进参数表）。
 * @param {object} feature 功能定义
 * @returns {object} 形如 { outputDir, overwrite, threadCount, ...fields.default }
 */
export function defaultParams(feature) {
  const params = { outputDir: '', overwrite: false, threadCount: 0 }
  for (const field of feature.fields) {
    if (field.type === 'notice') continue
    params[field.key] = field.default
  }
  return params
}

export const GROUPS = [
  { id: 'A', name: '转码', desc: '格式/视频提取/码率/标签' },
  { id: 'B', name: 'ASMR', desc: '切分/去静音/淡入淡出' },
  { id: 'C', name: '音频工程', desc: '裁剪/合并/响度/重采样/降噪/变速/增益' },
  { id: 'D', name: '辅助', desc: '频谱/波形' }
]
