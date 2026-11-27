import { addFiles, getState, setState, updateFile, removeFiles, toast } from './store.js'
import { AUDIO_EXTS, VIDEO_EXTS } from './paths.js'

/**
 * 进行中的探测任务：jobId -> true。
 * 放在模块级而不是 store 里：jobId 只在「取消」这一瞬间有用，写进 store 只会制造过期状态。
 */
const activeJobs = new Map()

/**
 * @returns {string} 短 jobId（只用于 preload 的 cancelProbe 定位，不含路径信息）
 */
function newJobId() {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
}

/**
 * 取消所有进行中的读取。preload 会把未开始项标 canceled，正在跑的尽量中断。
 * 旧 preload 没有 cancelProbe，这里静默跳过（界面按钮也按 caps 隐藏）。
 * @returns {void} 无返回值
 */
export function cancelProbing() {
  const api = typeof window !== 'undefined' ? window.audioServices : null
  if (!api || typeof api.cancelProbe !== 'function') return
  for (const jobId of activeJobs.keys()) {
    try {
      api.cancelProbe(jobId)
    } catch (_) {}
  }
}

/**
 * 把路径（文件或目录）加入列表并探测。
 * 拖入目录时递归展开；已存在的路径去重；探测是并发的（preload 侧 3 路），每完成一个就刷一次界面。
 *
 * 前置条件：路径必须已经由 preload 授权（拖入走 pathForFile、选择框走 chooseFiles、
 * 文件关联走 preload 自己监听的 onPluginEnter）。页面拿不到写白名单的接口，
 * 这里也不要再尝试授权——给了就是「页面自己发通行证」，属于审核点名的情形。
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
        if (typeof api.listMedia === 'function') collected.push(...api.listMedia(p, { recursive: true }))
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

  const jobId = newJobId()
  activeJobs.set(jobId, true)
  /** 已收到回调的路径（含取消占位），用来算 finally 还要退掉多少计数 */
  const settled = new Set()
  /** 被取消的路径：这些行不该留在列表里显示「读取中…」 */
  const canceled = new Set()

  try {
    await api.probeMany(
      fresh,
      (info) => {
        settled.add(info.path)
        if (info.canceled) {
          canceled.add(info.path)
          return
        }
        updateFile(info.path, { info, error: info.ok ? '' : info.error })
        setState((s) => ({ probing: Math.max(0, s.probing - 1) }))
      },
      { jobId }
    )
  } catch (err) {
    toast((err && err.message) || '读取失败', 'error')
  } finally {
    activeJobs.delete(jobId)
    if (canceled.size) removeFiles([...canceled])
    // 兜底：probeMany 抛错或早退时回调不会跑满，把剩余计数一次退干净，
    // 否则标题栏的「读取中 N」会永久挂住
    const rest = fresh.length - settled.size
    if (rest > 0) setState((s) => ({ probing: Math.max(0, s.probing - rest) }))
  }

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
  const media = [...AUDIO_EXTS, ...VIDEO_EXTS]
  const filters =
    opts.filters ||
    [
      { name: media.length ? '音频和视频' : '全部文件', extensions: media.length ? media : ['*'] },
      { name: '全部文件', extensions: ['*'] }
    ]
  return api.chooseFiles({ title: opts.title || '选择音频 / 视频文件', filters })
}
