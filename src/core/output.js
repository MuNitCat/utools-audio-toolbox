/** 输出位置的解析与描述：设置里存的是「模式」，实际路径在这里算 */

export const OUTPUT_MODES = [
  { value: 'sibling', label: '源文件同级' },
  { value: 'downloads', label: '下载目录' },
  { value: 'desktop', label: '桌面' },
  { value: 'custom', label: '指定目录' }
]

/**
 * 向宿主要系统目录（downloads / desktop / …）。
 * 宿主没提供 getPath 或抛错时一律当「不可用」，由调用方降级显示。
 * @param {string} name uTools getPath 的约定名
 * @returns {string} 绝对路径；取不到时返回空字符串
 */
function pathOf(name) {
  const api = typeof window !== 'undefined' ? window.audioServices : null
  if (!api || typeof api.getPath !== 'function') return ''
  try {
    return api.getPath(name) || ''
  } catch (_) {
    return ''
  }
}

/**
 * 把设置里的模式解析成真实目录。
 * @param {{mode?: string, dir?: string}} settings 应用设置
 * @returns {string} 绝对路径；空字符串表示「跟随源文件同目录」
 */
export function resolveOutputDir(settings) {
  const s = settings || {}
  if (s.mode === 'custom') return s.dir || ''
  if (s.mode === 'downloads') return pathOf('downloads')
  if (s.mode === 'desktop') return pathOf('desktop')
  return ''
}

/**
 * 给界面显示的一行说明（设置弹窗里的「实际位置」）。
 * @param {{mode?: string, dir?: string}} settings 应用设置
 * @returns {string} 可直接展示的中文描述
 */
export function describeOutput(settings) {
  const s = settings || {}
  if (s.mode === 'custom') return s.dir || '未选择目录'
  if (s.mode === 'downloads') return pathOf('downloads') || '系统未提供下载目录'
  if (s.mode === 'desktop') return pathOf('desktop') || '系统未提供桌面路径'
  return '与每个源文件同目录'
}
