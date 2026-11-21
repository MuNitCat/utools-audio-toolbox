/** 输出位置的解析与描述：设置里存的是「模式」，实际路径在这里算 */

export const OUTPUT_MODES = [
  { value: 'sibling', label: '源文件同级' },
  { value: 'downloads', label: '下载目录' },
  { value: 'desktop', label: '桌面' },
  { value: 'custom', label: '指定目录' }
]

function pathOf(name) {
  const api = typeof window !== 'undefined' ? window.audioServices : null
  if (!api || typeof api.getPath !== 'function') return ''
  try {
    return api.getPath(name) || ''
  } catch (_) {
    return ''
  }
}

/** @returns {string} 空字符串表示「跟随源文件」 */
export function resolveOutputDir(settings) {
  const s = settings || {}
  if (s.mode === 'custom') return s.dir || ''
  if (s.mode === 'downloads') return pathOf('downloads')
  if (s.mode === 'desktop') return pathOf('desktop')
  return ''
}

/** 给界面显示的一行说明 */
export function describeOutput(settings) {
  const s = settings || {}
  if (s.mode === 'custom') return s.dir || '未选择目录'
  if (s.mode === 'downloads') return pathOf('downloads') || '系统未提供下载目录'
  if (s.mode === 'desktop') return pathOf('desktop') || '系统未提供桌面路径'
  return '与每个源文件同目录'
}
