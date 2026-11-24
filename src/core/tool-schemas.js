/**
 * MCP 工具的 schema 定义。
 *
 * 这里是 plugin.json.tools **唯一**的来源：scripts/build-plugin.mjs 直接读 TOOL_DEFS 生成清单，
 * 根目录的 plugin.json 不再手写 tools。改描述/枚举只改这里，构建后自动同步到产物，
 * 不会再出现「两份手抄、文案漂移」的情况。
 *
 * 与 mcp.js 的分工：本文件只描述「AI 能传什么」，mcp.js 负责「收到之后做什么」。
 * 刻意不 import 任何东西——构建脚本要能在没有 DOM / React 的纯 Node 环境里直接读。
 */

/* schema 片段速记：只为了少写 type/description 的样板 */
const str = (description, extra = {}) => ({ type: 'string', description, ...extra })
const num = (description, extra = {}) => ({ type: 'number', description, ...extra })
const bool = (description) => ({ type: 'boolean', description })
/**
 * 输入路径列表的 schema 片段。
 * 描述里必须写明「已由用户在界面添加过」这个前提：preload 的白名单只认用户手势拿到的路径，
 * 直接塞一个没出现过的绝对路径会被 guard 拒绝。不写清楚，Agent 会反复撞墙且看不懂报错。
 */
const pathsOf = (description) => ({
  type: 'array',
  items: { type: 'string' },
  minItems: 1,
  description: `${description}（必须已由用户在插件界面添加或拖入，否则会被拒绝）`
})

const OUTPUT_PROPS = {
  outputDir: str('输出目录绝对路径（该目录需已在插件界面选择或设置过）；不传则与原文件同目录'),
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

/**
 * 工具定义（描述 + inputSchema）。plugin.json.tools 由构建脚本从这里生成，
 * 工具名必须与 src/core/tool-names.js 一致（构建时会断言）。
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
        bitrate: num('有损格式码率 kbps，如 192；不传则沿用源文件码率（夹在 64–320）', { minimum: 32, maximum: 512 }),
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
        ...OUTPUT_PROPS,
        /** 提取默认不改名，与其它功能的「默认加后缀」不同，单独写清楚 */
        suffix: str('输出文件名后缀，留空表示不改名，例如 _converted')
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
        strength: str('降噪强度', { enum: ['light', 'medium', 'strong'] }),
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
        coverPath: str('封面图片绝对路径，嵌入或替换封面（必须已由用户在插件界面添加过）'),
        extractCover: bool('是否同时把原内嵌封面导出成图片'),
        coverFormat: str('导出封面的格式', { enum: ['jpg', 'png'] }),
        outputDir: str('输出目录绝对路径（该目录需已在插件界面选择或设置过）；重命名模式下表示移动到该目录'),
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
        inputPath: str('输入文件绝对路径（必须已由用户在插件界面添加或拖入）'),
        format: str('图片格式', { enum: ['jpg', 'png'] }),
        outputPath: str('可选：指定输出图片绝对路径（父目录需已在插件界面选择过）'),
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
        inputPath: str('输入文件绝对路径（必须已由用户在插件界面添加或拖入）'),
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
