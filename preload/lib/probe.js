'use strict'

/**
 * 宿主没有 ffprobe，只能用 `ffmpeg -i <file>` 的 stderr 反解元信息。
 * 解析必须宽松：三种真实样本（flac / mp3 / m4a / adts）的字段排布不完全一致。
 */

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { capture } = require('./ffmpeg')
const binaries = require('./binaries')

const TAG_SKIP = new Set([
  'encoder',
  'major_brand',
  'minor_version',
  'compatible_brands',
  'creation_time',
  'handler_name',
  'vendor_id',
  'hd video',
  'media_type',
  'language',
  'comm',
  'duration',
  'stream',
  'track'
])

const SAMPLE_FMT_BITS = {
  u8: 8,
  u8p: 8,
  s16: 16,
  s16p: 16,
  s24: 24,
  s24p: 24,
  s32: 32,
  s32p: 32,
  flt: 32,
  fltp: 32,
  dbl: 64,
  dblp: 64
}

function toSeconds(h, m, s) {
  return Number(h) * 3600 + Number(m) * 60 + Number(s)
}

function normalizeChannelText(text) {
  if (!text) return ''
  const t = String(text).trim()
  if (/^mono$/i.test(t)) return 'mono'
  if (/^stereo$/i.test(t)) return 'stereo'
  if (/^[\d.]+ channels?$/i.test(t)) return t.replace(/\s+/g, ' ')
  return t
}

function channelCountOf(layout) {
  if (!layout) return 0
  if (/mono/i.test(layout)) return 1
  if (/stereo/i.test(layout)) return 2
  const m = layout.match(/^([\d.]+)\s*channels?/i)
  if (m) return Math.round(Number(m[1]))
  return 0
}

/**
 * @param {string} text ffmpeg -i 的 stderr 全文
 * @returns {object} 解析结果（缺字段时给 null / 0，不抛异常）
 */
function parseProbe(text) {
  const out = {
    format: '',
    duration: null,
    durationEstimated: false,
    bitrate: 0,
    codec: '',
    profile: '',
    sampleRate: 0,
    channels: 0,
    channelLayout: '',
    bitsPerSample: 0,
    sampleFormat: '',
    streamBitrate: 0,
    hasCover: false,
    coverCodec: '',
    /** 真正的视频画面（不是封面）—— 只有「视频提取音频」会用到 */
    hasVideo: false,
    tags: {},
    audioStreams: 0,
    raw: ''
  }
  if (!text) return out

  const lines = String(text).split(/\r?\n/)
  out.raw = text

  // Input #0, flac, from 'x.flac':
  const fmtLine = lines.find((l) => /^\s*Input #0,\s*/i.test(l))
  if (fmtLine) {
    const m = fmtLine.match(/^\s*Input #0,\s*(.+?),\s*from\s+'/i)
    if (m) out.format = m[1].trim()
  }

  // Duration: 01:30:12.45, start: 0.000000, bitrate: 1397 kb/s
  const durLine = lines.find((l) => /Duration:\s*\d+:\d{2}:\d{2}/.test(l))
  if (durLine) {
    const m = durLine.match(/Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/)
    if (m) out.duration = toSeconds(m[1], m[2], m[3])
    const b = durLine.match(/bitrate:\s*(\d+)\s*kb\/s/i)
    if (b) out.bitrate = Number(b[1])
    if (!/start:/i.test(durLine) && /Duration:/.test(durLine)) {
      // 没 start 不一定是估算，只有明确提示才算
    }
  }
  if (/Estimating duration from bitrate/i.test(text)) out.durationEstimated = true

  // 逐行扫描：Input 到第一个 Stream 之间是 format 级 Metadata
  let stage = 'format'
  let inMeta = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*Metadata:\s*$/.test(line)) {
      inMeta = true
      continue
    }
    if (/^\s*Stream #\d+:\d+/.test(line)) {
      stage = 'stream'
      inMeta = false
      // 音频流统计
      const audio = line.match(/Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*Audio:\s*(.+)$/i)
      if (audio) {
        out.audioStreams += 1
        const body = audio[1]
        if (!out.codec) {
          const c = body.match(/^([a-zA-Z0-9_]+)/)
          if (c) out.codec = c[1]
          const p = body.match(/\(([^)]+)\)/)
          if (p && !/\//.test(p[1])) out.profile = p[1]
          const sr = body.match(/(\d+)\s*Hz/)
          if (sr) out.sampleRate = Number(sr[1])
          const ch = body.match(/,\s*(mono|stereo|[\d.]+\s*channels?)/i)
          if (ch) {
            out.channelLayout = normalizeChannelText(ch[1])
            out.channels = channelCountOf(out.channelLayout)
          }
          const fmt = body.match(/,\s*(u8p?|s16p?|s24p?|s32p?|fltp?|dblp?)\b/)
          if (fmt) {
            out.sampleFormat = fmt[1]
            out.bitsPerSample = SAMPLE_FMT_BITS[fmt[1]] || 0
          }
          // flac 24bit 会被报成 s32，profile 里的 "24 bit" 才是真值
          const pb = out.profile && out.profile.match(/^(\d+)\s*bit$/i)
          if (pb) out.bitsPerSample = Number(pb[1])
          const br = body.match(/(\d+)\s*kb\/s/)
          if (br) out.streamBitrate = Number(br[1])
        }
        continue
      }
      // Video 流：只有带 (attached pic) 的才是内嵌封面，其余是视频画面
      const video = line.match(/Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*Video:\s*([a-zA-Z0-9_]+)/i)
      if (video) {
        if (/\(attached pic\)/i.test(line)) {
          out.hasCover = true
          out.coverCodec = video[1]
        } else {
          out.hasVideo = true
        }
        continue
      }
      continue
    }
    if (/^\s*At least one output file/.test(line) || /^\s*\[/.test(line)) {
      inMeta = false
      continue
    }
    if (inMeta) {
      // 元信息条目固定缩进 4 空格；缩进不足说明已经离开 Metadata 块（例如 Duration 行）
      const kv = line.match(/^\s{4,}([^:\s][^:]*?)\s*:\s*(.*)$/)
      if (!kv) {
        inMeta = false
      } else {
        const key = kv[1].trim()
        const val = kv[2].trim()
        if (key && val && stage === 'format' && !TAG_SKIP.has(key.toLowerCase())) {
          out.tags[key] = val
        }
      }
    }
  }

  return out
}

/**
 * ffprobe 的 JSON -> 与 parseProbe 完全相同的结构。
 * 字段名统一映射，下游（UI / MCP / 队列）不感知探测方式。
 */
function mapProbeJson(json) {
  const format = (json && json.format) || {}
  const streams = (json && json.streams) || []
  const audios = streams.filter((s) => s.codec_type === 'audio')
  const audio = audios[0]
  const video = streams.find((s) => s.codec_type === 'video')
  // 封面在 ffprobe 里也是 video 流，靠 attached_pic 和真正的视频画面区分
  const isCover = Boolean(video && video.disposition && Number(video.disposition.attached_pic) === 1)

  const tags = {}
  for (const [key, value] of Object.entries(format.tags || {})) {
    if (!value) continue
    if (TAG_SKIP.has(String(key).toLowerCase())) continue
    tags[key] = String(value)
  }

  const out = {
    format: format.format_name || '',
    duration: Number(format.duration) || null,
    durationEstimated: false,
    bitrate: Math.round((Number(format.bit_rate) || 0) / 1000),
    codec: '',
    profile: '',
    sampleRate: 0,
    channels: 0,
    channelLayout: '',
    bitsPerSample: 0,
    sampleFormat: '',
    streamBitrate: 0,
    hasCover: isCover,
    coverCodec: isCover ? video.codec_name || '' : '',
    hasVideo: Boolean(video) && !isCover,
    tags,
    audioStreams: audios.length,
    raw: ''
  }

  if (audio) {
    out.codec = audio.codec_name || ''
    out.profile = audio.profile || ''
    out.sampleRate = Number(audio.sample_rate) || 0
    out.channels = Number(audio.channels) || 0
    out.channelLayout =
      audio.channel_layout || (out.channels === 1 ? 'mono' : out.channels === 2 ? 'stereo' : '')
    out.bitsPerSample = Number(audio.bits_per_raw_sample || audio.bits_per_sample) || 0
    out.streamBitrate = Math.round((Number(audio.bit_rate) || 0) / 1000)
    const fmt = audio.sample_fmt || ''
    if (fmt) {
      out.sampleFormat = fmt
      if (!out.bitsPerSample) out.bitsPerSample = SAMPLE_FMT_BITS[fmt] || 0
    }
  }

  return out
}

/**
 * 用系统 ffprobe 拿结构化信息。异步执行（审核建议：不要用 execFileSync 阻塞主进程）。
 * 任何异常都返回 null，由调用方回退到 stderr 解析。
 * @param {string} bin ffprobe 路径
 * @param {string} file 媒体文件
 * @returns {Promise<object|null>} 归一化后的探测结果
 */
function probeViaFFprobe(bin, file) {
  return new Promise((resolve) => {
    execFile(
      bin,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { timeout: 30000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (err, stdout) => {
        if (err) {
          resolve(null)
          return
        }
        try {
          const json = JSON.parse(String(stdout || ''))
          if (!json || (!json.format && !(json.streams || []).length)) {
            resolve(null)
            return
          }
          resolve(mapProbeJson(json))
        } catch (_) {
          resolve(null)
        }
      }
    )
  })
}

function safeStat(file) {
  try {
    const st = fs.statSync(file)
    return { size: st.size, mtime: st.mtimeMs }
  } catch (_) {
    return { size: 0, mtime: 0 }
  }
}

/**
 * 探测单个文件
 * @param {string} file 绝对路径
 * @returns {Promise<object>}
 */
async function probe(file) {
  const stat = safeStat(file)
  const base = {
    path: file,
    name: path.basename(file),
    ext: path.extname(file).replace(/^\./, '').toLowerCase(),
    size: stat.size,
    mtime: stat.mtime,
    ok: false,
    error: ''
  }

  const exists = fs.existsSync(file)
  if (!exists) return { ...base, error: '文件不存在' }

  // 1) 系统装了 ffprobe 就用结构化输出：更快、字段可靠、不用抠正则
  const ffprobe = binaries.ffprobePath()
  if (ffprobe) {
    const parsed = await probeViaFFprobe(ffprobe, file)
    if (parsed) {
      const audioOk = parsed.audioStreams > 0 || parsed.codec !== ''
      return {
        ...base,
        ...parsed,
        ok: audioOk,
        probeSource: 'ffprobe',
        error: audioOk ? '' : '未能识别音频流（可能不是音频文件）'
      }
    }
  }

  // 2) 退回解析 ffmpeg -i 的 stderr（宿主只有 ffmpeg、没有 ffprobe）
  const res = await capture(`probe:${file}`, ['-hide_banner', '-nostdin', '-i', file])
  const parsed = parseProbe(res.text)

  const audioOk = parsed.audioStreams > 0 || parsed.codec !== ''
  return {
    ...base,
    ...parsed,
    ok: audioOk,
    probeSource: 'ffmpeg',
    error: audioOk ? '' : parsed.raw ? '未能识别音频流（可能不是音频文件）' : res.error ? String(res.error.message || res.error) : '探测失败'
  }
}

/**
 * 顺序探测多个文件
 * @param {string[]} files
 * @param {(info:object, index:number, total:number)=>void} [onOne]
 */
async function probeMany(files, onOne) {
  const list = Array.isArray(files) ? files : []
  const out = []
  for (let i = 0; i < list.length; i += 1) {
    const info = await probe(list[i])
    out.push(info)
    if (onOne) onOne(info, i, list.length)
  }
  return out
}

module.exports = { probe, probeMany, parseProbe }
