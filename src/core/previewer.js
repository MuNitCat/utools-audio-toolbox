/** 频谱/波形即时预览：只渲染临时图给界面看，不产出交付文件 */

import { setState } from './store.js'

let seq = 0
let current = ''

/**
 * 渲染文件中间一段的频谱/波形预览，只写进 store.preview，不产出交付文件。
 * 连续触发时用令牌作废旧请求的结果，避免慢的旧图覆盖快的新图。
 * @param {{path: string, info: object}} file 已探测过的文件
 * @param {'spectrum'|'waveform'} kind 预览类型
 * @param {{seconds?: number}} [opts] seconds 为取样时长，默认 60 秒
 * @returns {Promise<object|null>} 预览结果；被后续请求取代时返回 null
 * @throws {Error} 当前环境缺少 renderPreview 能力时抛出
 */
export async function quickPreview(file, kind, opts = {}) {
  const api = typeof window !== 'undefined' ? window.audioServices : null
  if (!api || typeof api.renderPreview !== 'function') throw new Error('当前环境不支持预览')

  const token = `p${(seq += 1)}`
  current = token

  const res = await api.renderPreview({
    input: file.path,
    kind,
    mode: 'quick',
    seconds: opts.seconds || 60,
    duration: (file.info && file.info.duration) || 0,
    width: 1280,
    height: kind === 'waveform' ? 420 : 640,
    token
  })

  // 期间又发起了新请求，这次结果作废
  if (token !== current) return null

  setState({
    preview: {
      ...res,
      file: file.path,
      name: (file.info && file.info.name) || file.path.split('/').pop(),
      source: 'quick'
    }
  })
  return res
}
