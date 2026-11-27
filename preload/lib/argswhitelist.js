'use strict'

/**
 * ffmpeg 参数白名单。
 *
 * 背景：preload 的 run / runCapture 只收到一个扁平字符串数组，等于把 ffmpeg 的全部能力
 * 交给渲染层。审核要求「参数改由 preload 构造，或在 preload 做参数白名单校验」——
 * 这里选后者：参数仍由 src/core/args.js 生成，preload 逐个 token 校验。
 *
 * 设计原则：
 * - **默认拒绝**：未列出的 flag 一律失败，新增功能必须显式登记（并补 scripts/check 用例）
 * - 路径类参数（-i / 输出）交给注入的 assert* 判断，本模块不碰 fs
 * - 纯函数、无 IO，方便单测
 */

const path = require('node:path')

const MAX_ARGS = 256
const MAX_MAP = 4
const MAX_INPUTS_RUN = 32

/** 允许的无值开关与最大出现次数 */
const NO_VALUE = {
  '-hide_banner': 1,
  '-nostdin': 1,
  '-y': 1,
  '-vn': 1,
  '-sn': 1,
  '-dn': 1
}

/** 直接拒绝的高危 flag（命中即失败，不进「未知 flag」分支，方便给准确提示） */
const DENY = new Set([
  '-progress',
  '-nostats',
  '-filter_complex_script',
  '-filter_script',
  '-vf',
  '-filter',
  '-attach',
  '-dump_attachment',
  '-passlogfile',
  '-pass',
  '-vstats_file',
  '-report',
  '-fs',
  '-init_hw_device',
  '-hwaccel',
  '-device',
  '-encoders',
  '-map_channels',
  '-copyts',
  '-shortest'
])

const ENCODERS = new Set(['libmp3lame', 'aac', 'flac', 'pcm_s24le', 'libvorbis', 'libopus', 'alac', 'copy'])
const VIDEO_CODECS = new Set(['copy', 'mjpeg'])
const SAMPLE_RATES = new Set(['8000', '11025', '16000', '22050', '32000', '44100', '48000', '96000'])
const MUXERS = new Set(['ipod', 'adts', 'null', 'concat'])
const META_KEYS = new Set(['title', 'artist', 'album', 'albumartist', 'genre', 'date', 'comment'])
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp'])
const TIME_RE = /^\d{1,7}(\.\d{1,3})?$/

/**
 * @param {string} message 中文原因
 * @returns {{ok: false, error: string}}
 */
function bad(message) {
  return { ok: false, error: message }
}

/**
 * @param {string} text 形如 `k=v:k=v`
 * @param {Record<string, RegExp>} spec 允许的键与值规则
 * @returns {boolean} 全部键值都合法才 true；空串表示无参数，返回 true
 */
function paramSet(text, spec) {
  if (!text) return true
  for (const pair of text.split(':')) {
    const eq = pair.indexOf('=')
    if (eq <= 0) return false
    const key = pair.slice(0, eq)
    const value = pair.slice(eq + 1)
    if (!spec[key] || !spec[key].test(value)) return false
  }
  return true
}

/** 单个滤镜的参数规则；键为滤镜名 */
const FILTERS = {
  atempo: (p) => /^(\d(\.\d{1,4})?|1\.0)$/.test(p) && Number(p) >= 0.5 && Number(p) <= 2,
  volume: (p) => /^-?\d{1,3}(\.\d{1,3})?dB$/.test(p) && Math.abs(parseFloat(p)) <= 60,
  alimiter: (p) => paramSet(p, { limit: /^(0?\.\d{1,3}|1)$/, level: /^(true|false)$/ }),
  afade: (p) => paramSet(p, { t: /^(in|out)$/, st: TIME_RE, d: /^\d{1,3}(\.\d{1,3})?$/ }),
  loudnorm: (p) =>
    paramSet(p, {
      I: /^-?\d{1,2}(\.\d{1,2})?$/,
      TP: /^-?\d{1,2}(\.\d{1,2})?$/,
      LRA: /^\d{1,2}(\.\d{1,2})?$/,
      measured_I: /^-?\d{1,3}(\.\d{1,2})?$/,
      measured_TP: /^-?\d{1,3}(\.\d{1,2})?$/,
      measured_LRA: /^-?\d{1,3}(\.\d{1,2})?$/,
      measured_thresh: /^-?\d{1,3}(\.\d{1,2})?$/,
      offset: /^-?\d{1,3}(\.\d{1,2})?$/,
      linear: /^(true|false)$/,
      print_format: /^(json|summary)$/
    }),
  silencedetect: (p) => paramSet(p, { noise: /^-?\d{1,3}(\.\d{1,2})?dB$/, d: /^\d{1,2}(\.\d{1,3})?$/ }),
  silenceremove: (p) =>
    paramSet(p, {
      start_periods: /^(0|1)$/,
      start_duration: /^\d{1,3}(\.\d{1,3})?$/,
      start_threshold: /^-?\d{1,3}(\.\d{1,3})?dB$/,
      stop_periods: /^-1$/,
      stop_duration: /^\d{1,3}(\.\d{1,3})?$/,
      stop_threshold: /^-?\d{1,3}(\.\d{1,3})?dB$/,
      detection: /^rms$/
    }),
  highpass: (p) => paramSet(p, { f: /^\d{1,5}$/ }),
  lowpass: (p) => paramSet(p, { f: /^\d{1,5}$/ }),
  afftdn: (p) => paramSet(p, { nr: /^(6|12|24)$/, nf: /^-(30|25|20)$/, tn: /^1$/ }),
  areverse: (p) => p === ''
}

/**
 * 校验 `-af` 的滤镜链。字符集先挡住引号/分隔符/斜杠（防 movie= 之类读文件）。
 * @param {string} chain 形如 `atempo=1.2,volume=3dB`
 * @returns {string|null} 失败原因；通过返回 null
 */
function checkFilterChain(chain) {
  if (!/^[A-Za-z0-9_:.,=\-]+$/.test(chain)) return '滤镜参数包含不允许的字符'
  for (const item of chain.split(',')) {
    if (!item) return '滤镜链存在空项'
    const eq = item.indexOf('=')
    const name = eq < 0 ? item : item.slice(0, eq)
    const params = eq < 0 ? '' : item.slice(eq + 1)
    const rule = FILTERS[name]
    if (!rule) return `不允许的滤镜「${name}」`
    if (!rule(params)) return `滤镜「${name}」的参数不合法`
  }
  return null
}

/** `-lavfi` 只允许两条整串模板（频谱 / 波形） */
const LAVFI = [
  /^showspectrumpic=s=(\d{3,4})x(\d{3,4}):legend=1:scale=log$/,
  /^showwavespic=s=(\d{3,4})x(\d{3,4}):colors=#[0-9A-Fa-f]{6}:split_channels=0$/
]

/**
 * 校验 `-filter_complex`。只放行 extractAudio(mix) 与 mergeReencode 两种模板。
 * @param {string} graph filter_complex 表达式
 * @returns {string|null} 失败原因；通过返回 null
 */
function checkGraph(graph) {
  if (!/^[A-Za-z0-9_:.,;=\[\]\-]+$/.test(graph)) return 'filter_complex 包含不允许的字符'

  // 模板 A：多音轨混合
  const mix = graph.match(/^((?:\[0:a:\d{1,2}\]){2,32})amix=inputs=(\d{1,2}):duration=longest:normalize=0,alimiter=limit=0\.98:level=false\[a\]$/)
  if (mix) {
    const labels = (mix[1].match(/\[0:a:\d{1,2}\]/g) || []).length
    return Number(mix[2]) === labels ? null : 'amix 的 inputs 与实际输入数量不一致'
  }

  // 模板 B：多文件 concat
  const merge = graph.match(
    /^((?:\[\d{1,2}:a:0\]aresample=(\d{4,5}),aformat=sample_fmts=fltp:sample_rates=\2:channel_layouts=(?:mono|stereo)\[a\d{1,2}\];)+)((?:\[a\d{1,2}\])+)concat=n=(\d{1,2}):v=0:a=1\[out\]$/
  )
  if (merge) {
    const chains = (merge[1].match(/aresample=/g) || []).length
    const refs = (merge[3].match(/\[a\d{1,2}\]/g) || []).length
    if (chains !== refs) return 'concat 的输入标签数量不一致'
    if (Number(merge[4]) !== refs) return 'concat 的 n 与输入数量不一致'
    return null
  }

  return '不允许的 filter_complex 表达式'
}

/**
 * 校验输入路径。
 * @param {string} value `-i` 的取值
 * @param {{assertRead: Function, isTemp: Function}} ctx 由 preload 注入的白名单能力
 * @returns {string|null} 失败原因；通过返回 null
 */
function checkInput(value, ctx) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return `不允许协议或 URL 输入：${value}`
  if (value.startsWith('-')) return '输入路径不能以 - 开头'
  if (!path.isAbsolute(value)) return '输入必须是绝对路径'
  if (ctx.isTemp(value)) return null
  const res = ctx.assertRead(value)
  return res && res.ok ? null : (res && res.message) || `未授权的输入文件：${value}`
}

/**
 * 单个 flag 的取值校验表。
 * key 为 flag，value 为 {max, check}；check 返回失败原因或 null。
 */
function buildSpec(ctx) {
  return {
    '-i': { max: MAX_INPUTS_RUN, check: (v) => checkInput(v, ctx) },
    '-ss': { max: 1, check: (v) => (TIME_RE.test(v) ? null : '-ss 必须是秒数') },
    '-t': { max: 1, check: (v) => (TIME_RE.test(v) ? null : '-t 必须是秒数') },
    '-to': { max: 1, check: (v) => (TIME_RE.test(v) ? null : '-to 必须是秒数') },
    '-map': {
      max: MAX_MAP,
      check: (v) => (/^(0:a:\d{1,2}|0:v:\d{1,2}|1:v:0|\[a\]|\[out\])$/.test(v) ? null : `不允许的 -map 取值：${v}`)
    },
    '-map_metadata': { max: 1, check: (v) => (v === '0' ? null : '-map_metadata 只允许 0') },
    '-metadata': {
      max: 16,
      check: (v) => {
        const eq = v.indexOf('=')
        if (eq <= 0) return '-metadata 格式必须是 key=value'
        const key = v.slice(0, eq).toLowerCase()
        const value = v.slice(eq + 1)
        if (!META_KEYS.has(key)) return `不允许的标签键：${key}`
        if (value.length > 1024) return '标签值过长'
        return /[\u0000-\u001f\u007f]/.test(value) ? '标签值含控制字符' : null
      }
    },
    '-c:a': { max: 1, check: (v) => (ENCODERS.has(v) ? null : `不允许的音频编码器：${v}`) },
    '-c': { max: 1, check: (v) => (v === 'copy' ? null : '-c 只允许 copy') },
    '-c:v': { max: 1, check: (v) => (VIDEO_CODECS.has(v) ? null : `不允许的视频编码器：${v}`) },
    '-b:a': {
      max: 1,
      check: (v) => {
        const m = v.match(/^(\d{2,3})k$/)
        if (!m) return '码率格式必须是 数字k'
        const n = Number(m[1])
        return n >= 32 && n <= 512 ? null : '码率超出 32–512 范围'
      }
    },
    '-q:a': { max: 1, check: (v) => (/^[0-9]$/.test(v) ? null : 'MP3 质量必须是 0–9') },
    '-ar': { max: 1, check: (v) => (SAMPLE_RATES.has(v) ? null : `不允许的采样率：${v}`) },
    '-ac': { max: 1, check: (v) => (v === '1' || v === '2' ? null : '声道数只允许 1 或 2') },
    '-threads': { max: 1, check: (v) => (/^\d{1,2}$/.test(v) && Number(v) <= 64 ? null : '线程数超范围') },
    '-compression_level': { max: 1, check: (v) => (/^\d{1,2}$/.test(v) && Number(v) <= 12 ? null : '压缩等级超范围') },
    '-f': { max: 2, check: (v) => (MUXERS.has(v) ? null : `不允许的容器：${v}`) },
    '-safe': { max: 1, check: (v) => (v === '0' ? null : '-safe 只允许 0') },
    '-movflags': { max: 1, check: (v) => (v === '+faststart' ? null : '-movflags 只允许 +faststart') },
    '-id3v2_version': { max: 1, check: (v) => (v === '3' ? null : '-id3v2_version 只允许 3') },
    '-pix_fmt': { max: 1, check: (v) => (v === 'yuvj420p' ? null : '-pix_fmt 只允许 yuvj420p') },
    '-disposition:v:0': { max: 1, check: (v) => (v === 'attached_pic' ? null : '-disposition 只允许 attached_pic') },
    '-frames:v': { max: 1, check: (v) => (v === '1' ? null : '-frames:v 只允许 1') },
    '-update': { max: 1, check: (v) => (v === '1' ? null : '-update 只允许 1') },
    '-af': { max: 1, check: (v) => checkFilterChain(v) },
    '-lavfi': {
      max: 1,
      check: (v) => (LAVFI.some((re) => re.test(v)) ? null : '不允许的 -lavfi 表达式')
    },
    '-filter_complex': { max: 1, check: (v) => checkGraph(v) }
  }
}

/** concat 列表条目里 file '...' 的匹配格式（与 fsx.makeConcatList 的产出一致） */
const CONCAT_FILE_RE = /^file '(.*)'$/

/**
 * 解析 concat 列表文件并逐条校验其中列出的媒体路径。
 * 逐条直接拒绝（不剔除），任何一条未授权都让整份参数不通过。
 * @param {string} listFile 列表文件绝对路径（已在临时目录内）
 * @param {{assertRead: Function, readText: Function}} ctx 白名单能力
 * @returns {string|null} 失败原因；全部通过返回 null
 */
function checkConcatEntries(listFile, ctx) {
  const content = ctx.readText(listFile)
  if (!content) return 'concat 列表文件不可读或为空'

  const lines = content.split('\n')
  let entries = 0
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const match = CONCAT_FILE_RE.exec(trimmed)
    if (!match) return `concat 列表含不支持的条目：${trimmed.slice(0, 60)}`
    entries += 1
    // 单引号转义还原：'\'' 是路径里一个字面单引号
    const media = match[1].replace(/'\\''/g, "'")
    const res = ctx.assertRead(media)
    if (!res || !res.ok) return `concat 列表含未授权的输入：${media}`
  }
  if (!entries) return 'concat 列表没有任何 file 条目'
  if (entries > 200) return `concat 列表超过 200 条上限`
  return null
}

/**
 * 校验 run 的完整参数数组。
 * @param {string[]} args ffmpeg 参数
 * @param {{assertRead: Function, assertWriteTarget: Function, isTemp: Function, readText: Function}} ctx 白名单能力
 * @returns {{ok: true, output: string|null, inputs: string[]}|{ok: false, error: string}}
 */
function validateRunArgs(args, ctx) {
  if (!Array.isArray(args) || args.length === 0) return bad('参数为空')
  if (args.length > MAX_ARGS) return bad('参数过多')

  const spec = buildSpec(ctx)
  const counts = Object.create(null)
  const positionals = []
  const inputs = []

  for (let i = 0; i < args.length; i += 1) {
    const tok = args[i]
    if (typeof tok !== 'string' || tok === '') return bad('参数包含空项')
    if (tok === '--') return bad('不允许的 -- 分隔符')

    if (tok === '-') {
      positionals.push(tok)
      continue
    }
    if (tok.startsWith('-')) {
      if (DENY.has(tok)) return bad(`不允许的参数「${tok}」`)
      if (tok in NO_VALUE) {
        counts[tok] = (counts[tok] || 0) + 1
        if (counts[tok] > NO_VALUE[tok]) return bad(`参数「${tok}」重复`)
        continue
      }
      const rule = spec[tok]
      if (!rule) return bad(`未登记的参数「${tok}」`)
      const value = args[i + 1]
      if (typeof value !== 'string' || value === '') return bad(`参数「${tok}」缺少取值`)
      const reason = rule.check(value)
      if (reason) return bad(reason)
      counts[tok] = (counts[tok] || 0) + 1
      if (counts[tok] > rule.max) return bad(`参数「${tok}」重复过多`)
      if (tok === '-i') inputs.push(value)
      i += 1
      continue
    }
    positionals.push(tok)
  }

  // -f concat 必须紧跟 -safe 0 -i <临时 txt>，防「拿任意 txt 当输入清单」；
  // 并逐条解析列表里的 file 条目，各自过 assertReadFile——列表文件在临时目录
  // 只说明「它自己可读」，不说明其中列的每个媒体文件都经过了授权。
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '-f' || args[i + 1] !== 'concat') continue
    const seq = args.slice(i + 2, i + 6)
    const okSeq = seq[0] === '-safe' && seq[1] === '0' && seq[2] === '-i' && typeof seq[3] === 'string'
    if (!okSeq) return bad('-f concat 必须紧跟 -safe 0 -i <列表文件>')
    const list = seq[3]
    if (!ctx.isTemp(list) || !/\.txt$/i.test(list)) return bad('concat 列表文件必须是插件临时目录里的 .txt')
    const reason = checkConcatEntries(list, ctx)
    if (reason) return bad(reason)
  }

  if (positionals.length !== 1) return bad('必须且只能有一个输出参数')
  const output = positionals[0]

  if (output === '-') {
    const tail = args.slice(-3)
    if (!(tail[0] === '-f' && tail[1] === 'null')) return bad('只有 -f null - 允许丢弃输出')
    return { ok: true, output: null, inputs }
  }

  if (!path.isAbsolute(output)) return bad('输出必须是绝对路径')
  if (counts['-update'] && !IMAGE_EXT.has((output.split('.').pop() || '').toLowerCase())) {
    return bad('-update 1 只用于图片输出')
  }
  const target = ctx.assertWriteTarget(output, { overwrite: true })
  if (!target || !target.ok) return bad((target && target.message) || `不允许的输出路径：${output}`)

  return { ok: true, output, inputs }
}

/**
 * 校验 runCapture。只认 probe.js 产出的两种形态，避免绕开通用校验。
 * @param {string[]} args ffmpeg 参数
 * @param {{assertRead: Function, isTemp: Function}} ctx 白名单能力
 * @returns {{ok: true, output: null, inputs: string[]}|{ok: false, error: string}}
 */
function validateCaptureArgs(args, ctx) {
  if (!Array.isArray(args) || args.length < 4) return bad('参数为空')

  // P1：纯探测 [-hide_banner,-nostdin,-i,file]
  if (args.length === 4 && args[0] === '-hide_banner' && args[1] === '-nostdin' && args[2] === '-i') {
    const reason = checkInput(args[3], ctx)
    return reason ? bad(reason) : { ok: true, output: null, inputs: [args[3]] }
  }

  // P2：null sink [-hide_banner,-nostdin,-y,-i,file,-af,<filter>,-f,null,-]
  if (args.length === 10 && args[0] === '-hide_banner' && args[1] === '-nostdin' && args[2] === '-y') {
    if (args[3] !== '-i' || args[5] !== '-af' || args[7] !== '-f' || args[8] !== 'null' || args[9] !== '-') {
      return bad('采集参数形态不合法')
    }
    const reason = checkInput(args[4], ctx)
    if (reason) return bad(reason)
    const name = String(args[6] || '').split('=')[0]
    if (name !== 'loudnorm' && name !== 'silencedetect') return bad(`采集只允许 loudnorm / silencedetect，收到「${name}」`)
    const filterReason = checkFilterChain(args[6])
    if (filterReason) return bad(filterReason)
    return { ok: true, output: null, inputs: [args[4]] }
  }

  return bad('不允许的采集参数')
}

module.exports = { validateRunArgs, validateCaptureArgs, checkFilterChain, checkGraph }
