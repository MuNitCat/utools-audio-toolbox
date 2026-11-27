/**
 * 极简 store：不依赖任何状态库。
 * 用 useSyncExternalStore 而不是 Context，因为进度回调 ~10Hz，
 * Context 会导致整棵树重渲染；而 MCP 路径根本没有 React。
 */

import { useSyncExternalStore } from 'react'

const listeners = new Set()

const initial = {
  group: 'A',
  featureId: 'convert',
  /** { [featureId]: params } */
  params: {},
  /** [{ path, info, error }] */
  files: [],
  /** [{ id, input, featureName, ops, status, progress, speed, eta, message, output, error }] */
  tasks: [],
  running: false,
  toast: null,
  confirm: null,
  probing: 0,
  config: null,
  /** 'auto' | 'light' | 'dark' */
  theme: 'auto',
  /** 频谱图/波形图的内联预览 { path, dataUrl, name, kind } */
  preview: null,
  /** 常用艺术家（最多 5 个） */
  artistHistory: []
}

let state = { ...initial }

/**
 * @returns {object} 当前状态快照（只读使用，不要直接改字段）
 */
export function getState() {
  return state
}

/**
 * 订阅状态变化，返回取消订阅函数（直接交给 useSyncExternalStore 用）。
 * @param {() => void} listener 状态变化后的回调
 * @returns {() => void} 取消订阅
 */
export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * 合并式更新：只覆盖传入的字段。
 * 非 React 路径（队列、MCP）也靠它推送状态，所以每次都会同步通知全部订阅者。
 * @param {object|((prev: object) => object)} patch 增量或更新函数；返回假值时不生效
 * @returns {void} 无返回值
 */
export function setState(patch) {
  const next = typeof patch === 'function' ? patch(state) : patch
  if (!next) return
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

/**
 * 恢复初始状态（测试与「重置」用）。
 * @returns {void} 无返回值
 */
export function reset() {
  state = { ...initial }
  for (const listener of listeners) listener()
}

/**
 * 从 store 里挑所需的片段。用 useSyncExternalStore 而不是 Context，
 * 因为进度回调约 10Hz，Context 会让整棵树重渲染。
 * @template T
 * @param {(s: object) => T} [selector] 选择器；不传则返回整个状态
 * @returns {T|object} 选中的片段
 */
export function useStore(selector) {
  return useSyncExternalStore(
    subscribe,
    () => (selector ? selector(state) : state),
    () => (selector ? selector(state) : state)
  )
}

/**
 * 清掉频谱/波形的内联预览（切换文件或关闭查看器时用）。
 * @returns {void} 无返回值
 */
export function clearPreview() {
  setState({ preview: null })
}

/* ------------------------------ 主题 ------------------------------ */

const THEMES = ['auto', 'light', 'dark']
let mediaBound = false

/**
 * 读系统的深浅色偏好；非浏览器环境或 matchMedia 抛错时按浅色处理。
 * @returns {boolean} 系统是否偏好深色
 */
function systemPrefersDark() {
  try {
    return typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false
  } catch (_) {
    return false
  }
}

/**
 * 把 auto 解析成真正生效的 light/dark（CSS 只认这两个值，别指望 light-dark()）。
 * @param {string} mode 'auto' | 'light' | 'dark'，非法值按 auto 处理
 * @returns {'light'|'dark'} 实际生效的主题
 */
export function resolveTheme(mode) {
  const m = THEMES.includes(mode) ? mode : 'auto'
  return m === 'auto' ? (systemPrefersDark() ? 'dark' : 'light') : m
}

/**
 * 把主题写到 <html data-theme>，并首次调用时挂上系统主题监听。
 * 监听只注册一次（mediaBound），且只在 auto 模式下重算，避免手动选的主题被系统覆盖。
 * @param {string} mode 'auto' | 'light' | 'dark'
 * @returns {string} 规范化后的模式（不是解析结果）
 */
export function applyTheme(mode) {
  const m = THEMES.includes(mode) ? mode : 'auto'
  const resolved = resolveTheme(m)

  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', resolved)
  }

  // 系统主题变化时，只影响 auto 模式
  if (!mediaBound && typeof window !== 'undefined' && window.matchMedia) {
    mediaBound = true
    try {
      const query = window.matchMedia('(prefers-color-scheme: dark)')
      const onChange = () => {
        if (getState().theme === 'auto') applyTheme('auto')
      }
      if (query.addEventListener) query.addEventListener('change', onChange)
      else if (query.addListener) query.addListener(onChange)
    } catch (_) {}
  }

  return m
}

/**
 * 用户切换主题：立即生效 + 落库，下次启动沿用。
 * @param {string} theme 'auto' | 'light' | 'dark'
 * @returns {void} 无返回值
 */
export function setTheme(theme) {
  const t = applyTheme(theme)
  setState({ theme: t })
  const api = typeof window !== 'undefined' ? window.audioServices : null
  if (api) {
    try {
      api.setConfigGuarded({ theme: t })
    } catch (_) {}
  }
}

/* ------------------------------ 便捷动作 ------------------------------ */

/**
 * 追加文件条目并去重（拖入同一文件多次不会产生重复行）。
 * @param {{path: string, info?: object|null, error?: string}[]} entries 待加入的条目
 * @returns {void} 无返回值
 */
export function addFiles(entries) {
  const seen = new Set(state.files.map((f) => f.path))
  const next = [...state.files]
  for (const entry of entries) {
    if (!entry || !entry.path || seen.has(entry.path)) continue
    seen.add(entry.path)
    next.push(entry)
  }
  setState({ files: next })
}

/**
 * @param {string} path 要移除的文件绝对路径
 * @returns {void} 无返回值
 */
export function removeFile(path) {
  setState({ files: state.files.filter((f) => f.path !== path) })
}

/**
 * 批量移除（取消读取时清掉未完成的占位行）。合成一次 setState，避免 N 次渲染。
 * @param {string[]} paths 要移除的绝对路径
 * @returns {void} 无返回值
 */
export function removeFiles(paths) {
  const drop = new Set(Array.isArray(paths) ? paths : [])
  if (!drop.size) return
  setState({ files: state.files.filter((f) => !drop.has(f.path)) })
}

/**
 * @returns {void} 无返回值
 */
export function clearFiles() {
  setState({ files: [] })
}

/**
 * 按 path 精确更新单个文件条目（探测完成、错误回填都走这里）。
 * @param {string} path 文件绝对路径
 * @param {object} patch 要覆盖的字段
 * @returns {void} 无返回值
 */
export function updateFile(path, patch) {
  setState({
    files: state.files.map((f) => (f.path === path ? { ...f, ...patch } : f))
  })
}

/**
 * 弹一条提示，2.6 秒后自动消失。
 * 只在「当前仍是这条消息」时才清空，避免新提示被旧定时器提前干掉。
 * @param {string} message 提示文案
 * @param {'info'|'success'|'error'} [kind] 样式类别
 * @returns {void} 无返回值
 */
export function toast(message, kind = 'info') {
  setState({ toast: { message, kind, at: Date.now() } })
  window.setTimeout(() => {
    if (state.toast && state.toast.message === message) setState({ toast: null })
  }, 2600)
}
