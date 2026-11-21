/** 频谱/波形即时预览：只渲染临时图给界面看，不产出交付文件 */

import { setState } from './store.js'

let seq = 0
let current = ''

/**
 * @param {{path:string, info:object}} file
 * @param {'spectrum'|'waveform'} kind
 * @param {{seconds?:number}} opts
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

export function isLatest(token) {
  return token === current
}
