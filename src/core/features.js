/**
 * 功能定义：GUI 表单（fields）与 MCP schema（mcp.js）共同的数据源。
 * build() 是唯一的参数组装入口 —— UI 和 MCP 走同一条路径，保证产出完全一致。
 */

import * as A from './args.js'
import { FORMAT_KEYS, CONTAINERS } from './args.js'
import { parseTimeInput, clockTag } from './format.js'

const svc = () => (typeof window !== 'undefined' ? window.audioServices : null)

function out(input, params, ext, opts = {}) {
  const api = svc()
  if (!api) throw new Error('audioServices 未就绪')
  return api.resolveOutput(input, {
    dir: params.outputDir || '',
    suffix: params.suffix || '',
    ext,
    overwrite: Boolean(params.overwrite),
    ...opts
  })
}

function baseOutputParams(params, info) {
  const ext = (info && info.ext) || 'm4a'
  return ext
}

/** 输入格式 -> 可写入的容器（adts 裸流需要先转 m4a） */
export function safeFormatFor(info) {
  const ext = (info && info.ext) || ''
  if (ext === 'aac') return 'm4a'
  if (CONTAINERS[ext]) return ext
  return 'm4a'
}

const formatField = (def = 'm4a') => ({
  key: 'format',
  label: '输出格式',
  type: 'select',
  ui: 'grid',
  default: def,
  options: FORMAT_KEYS.map((k) => ({ value: k, label: k.toUpperCase() }))
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

/** 'auto' -> 取源文件码率；其他原样返回 */
function effectiveBitrate(value, info) {
  if (value !== 'auto') return value
  const src = Number((info && (info.streamBitrate || info.bitrate)) || 0)
  if (!src) return 192
  return Math.min(320, Math.max(64, Math.round(src / 8) * 8))
}

const suffixField = { key: 'suffix', label: '文件名后缀', type: 'text', default: '', placeholder: '例如 _compressed' }

/**
 * @typedef {{type:'ffmpeg', args:string[], output:string, weight:number, label:string}} Op
 */

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
      bitrateField,
      { key: 'quality', label: 'MP3 质量 VBR', type: 'select', default: '', options: [
        { value: '', label: '跟随码率' },
        { value: '0', label: 'V0 最高' },
        { value: '2', label: 'V2 推荐' },
        { value: '5', label: 'V5 较小' },
        { value: '9', label: 'V9 最小' }
      ], showIf: (p) => p.format === 'mp3' },
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
      formatField('m4a'),
      bitrateField,
      { key: 'quality', label: 'MP3 质量 VBR', type: 'select', default: '', options: [
        { value: '', label: '跟随码率' },
        { value: '0', label: 'V0 最高' },
        { value: '2', label: 'V2 推荐' },
        { value: '5', label: 'V5 较小' }
      ], showIf: (p) => p.format === 'mp3' },
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
      { key: 'copy', label: '直接复制音轨（不重编码，最快）', type: 'switch', default: false },
      suffixField,
      { key: 'notice', type: 'notice', text: '只取第一条音轨，画面与字幕都会被丢掉。直接复制要求源编码与目标容器兼容（mp4→m4a、mkv(opus)→opus 可以），不兼容会直接报错，改成重编码即可。' }
    ],
    build(inputs, params, infos) {
      return inputs.map((input, i) => {
        const info = infos[i] || {}
        const format = params.format || 'm4a'
        const output = out(input, params, A.outputExtOf(format), { suffix: params.suffix || '_audio' })
        return {
          input,
          ops: [
            {
              type: 'ffmpeg',
              args: A.extractAudio({
                input,
                output,
                format,
                bitrate: effectiveBitrate(params.bitrate, info),
                quality: params.quality,
                sampleRate: params.sampleRate,
                channels: params.channels,
                copy: Boolean(params.copy),
                threadCount: params.threadCount
              }),
              output,
              weight: 1,
              label: `提取音频 → ${format.toUpperCase()}`
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
      { key: 'quality', label: 'MP3 质量 VBR', type: 'select', default: '', options: [
        { value: '', label: '跟随码率' },
        { value: '2', label: 'V2 推荐' },
        { value: '5', label: 'V5 较小' }
      ], showIf: (p) => p.format === 'mp3' },
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
    id: 'clip',
    group: 'A',
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
    id: 'merge',
    group: 'A',
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
        const listFile = api.makeTempText(
          inputs.map((f) => `file '${String(f).replace(/'/g, "'\\''")}'`).join('\n'),
          'txt'
        )
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
    id: 'speed',
    group: 'A',
    name: '变速不变调',
    desc: '改变播放速度，音高保持不变',
    tool: 'audio_edit',
    needsDuration: true,
    fields: [
      { key: 'speed', label: '速度', type: 'select', default: '1.25', options: [
        { value: '0.5', label: '0.5x' },
        { value: '0.75', label: '0.75x' },
        { value: '0.9', label: '0.9x' },
        { value: '1.1', label: '1.1x' },
        { value: '1.25', label: '1.25x' },
        { value: '1.5', label: '1.5x' },
        { value: '2', label: '2x' }
      ] },
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
    group: 'A',
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
        if (params.titleFromName) tags.title = api.stripExt(info.name || input.split('/').pop())

        const ops = []
        // 导出原封面放在前面，让任务结束时 task.output 仍指向音频文件
        if (params.extractCover && info.hasCover) {
          const coverOut = api.resolveOutput(input, {
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
  /* ------------------------------ B 音频工程 ------------------------------ */
  {
    id: 'normalize',
    group: 'B',
    name: '响度标准化',
    desc: '按 LUFS 统一响度，两遍法更准',
    tool: 'audio_normalize',
    needsDuration: true,
    fields: [
      { key: 'targetLufs', label: '目标响度 (LUFS)', type: 'select', default: '-18', options: [
        { value: '-16', label: '-16（播客/流媒体偏响）' },
        { value: '-18', label: '-18（推荐：音声/ASMR）' },
        { value: '-20', label: '-20（留更多动态）' },
        { value: '-23', label: '-23（广播标准）' }
      ] },
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
    group: 'B',
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
    group: 'B',
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
    id: 'split',
    group: 'D',
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
            const output = api.numberedOutput(input, idx + 1, {
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
    group: 'D',
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
    group: 'D',
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

  /* ------------------------------ E 辅助 ------------------------------ */
  {
    id: 'visualize',
    group: 'E',
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

function defaultBitrate(format) {
  const c = CONTAINERS[format]
  if (!c || !c.lossy) return '—'
  if (format === 'opus') return 96
  return 192
}

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

export function getFeature(id) {
  return FEATURE_MAP[id] || null
}

export function featuresOfGroup(group) {
  return FEATURES.filter((f) => f.group === group)
}

export function defaultParams(feature) {
  const params = { outputDir: '', overwrite: false, threadCount: 0 }
  for (const field of feature.fields) {
    if (field.type === 'notice') continue
    params[field.key] = field.default
  }
  return params
}

export const GROUPS = [
  { id: 'A', name: '转码', desc: '格式/视频提取/码率/裁剪/合并/变速/标签' },
  { id: 'B', name: '音频工程', desc: '响度/重采样/降噪' },
  { id: 'D', name: 'ASMR', desc: '切分/去静音/淡入淡出' },
  { id: 'E', name: '辅助', desc: '频谱/波形' }
]
