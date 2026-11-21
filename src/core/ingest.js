import { addFiles, getState, setState, updateFile } from './store.js'

/**
 * 把路径（文件或目录）加入列表并探测。
 * 拖入目录时递归展开；已存在的路径自动去重。
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

export function pickFiles(opts = {}) {
  const api = window.audioServices
  if (!api) return []
  return api.chooseFiles({ title: opts.title || '选择音频 / 视频文件' })
}
