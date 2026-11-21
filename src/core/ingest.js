import { addFiles, getState, setState, updateFile } from './store.js'

/**
 * 把路径（文件或目录）加入列表并探测。
 * 拖入目录时递归展开；已存在的路径自动去重。
 */
/**
 * 把路径（文件或目录）加入列表并探测。
 * 拖入目录时递归展开；已存在的路径去重；探测是逐个完成的，每完成一个就刷一次界面。
 * @param {string[]} rawPaths 用户拖入的路径，目录与文件可混排
 * @returns {Promise<number>} 实际新增的文件数量（全部重复时为 0）
 */
export async function addPaths(rawPaths) {
  const api = typeof window !== 'undefined' ? window.audioServices : null
  if (!api) return 0

  const collected = []
  for (const p of rawPaths || []) {
    if (!p) continue
    try {
      if (api.isDir(p)) {
        // preload 不热更新：新版本是 listMedia，旧版本只有 listAudio
        const lister = api.listMedia || api.listAudio
        if (typeof lister === 'function') collected.push(...lister(p, { recursive: true }))
      } else {
        collected.push(p)
      }
    } catch (_) {}
  }

  // 先按已有列表去重，再交给 store；否则同一个文件会被探测两遍
  const existing = new Set(getState().files.map((f) => f.path))
  const fresh = [...new Set(collected)].filter((p) => !existing.has(p))
  if (!fresh.length) return 0

  addFiles(fresh.map((p) => ({ path: p, info: null, error: '' })))
  setState({ probing: getState().probing + fresh.length })

  await api.probeMany(fresh, (info) => {
    updateFile(info.path, { info, error: info.ok ? '' : info.error })
    setState({ probing: Math.max(0, getState().probing - 1) })
  })

  return fresh.length
}

/**
 * 打开系统文件选择框。
 * 默认把「音频 + 视频」合成第一项：原生对话框只会启用第一个过滤器，
 * 只给「音频」的话视频文件是灰的，只能手动拖进来。
 * @param {{title?: string, filters?: Array<{name: string, extensions: string[]}>}} [opts]
 * @returns {string[]} 选中的绝对路径；取消时为空数组
 */
export function pickFiles(opts = {}) {
  const api = typeof window !== 'undefined' ? window.audioServices : null
  if (!api) return []
  const audio = Array.isArray(api.AUDIO_EXTS) ? api.AUDIO_EXTS : []
  const video = Array.isArray(api.VIDEO_EXTS) ? api.VIDEO_EXTS : []
  const media = [...audio, ...video]
  const filters =
    opts.filters ||
    [
      { name: media.length ? '音频和视频' : '全部文件', extensions: media.length ? media : ['*'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  return api.chooseFiles({ title: opts.title || '选择音频 / 视频文件', filters })
}
