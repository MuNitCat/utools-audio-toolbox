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

export function getState() {
  return state
}

export function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function setState(patch) {
  const next = typeof patch === 'function' ? patch(state) : patch
  if (!next) return
  state = { ...state, ...next }
  for (const listener of listeners) listener()
}

export function reset() {
  state = { ...initial }
  for (const listener of listeners) listener()
}

export function useStore(selector) {
  return useSyncExternalStore(
    subscribe,
    () => (selector ? selector(state) : state),
    () => (selector ? selector(state) : state)
  )
}

export function clearPreview() {
  setState({ preview: null })
}

/* ------------------------------ 主题 ------------------------------ */

const THEMES = ['auto', 'light', 'dark']
let mediaBound = false

function systemPrefersDark() {
  try {
    return typeof window !== 'undefined' && window.matchMedia
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
      : false
  } catch (_) {
    return false
  }
}

/** 把 auto 解析成真正生效的 light/dark（CSS 只认这两个值） */
export function resolveTheme(mode) {
  const m = THEMES.includes(mode) ? mode : 'auto'
  return m === 'auto' ? (systemPrefersDark() ? 'dark' : 'light') : m
}

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

export function setTheme(theme) {
  const t = applyTheme(theme)
  setState({ theme: t })
  const api = typeof window !== 'undefined' ? window.audioServices : null
  if (api) {
    try {
      api.setConfig({ theme: t })
    } catch (_) {}
  }
}

/* ------------------------------ 便捷动作 ------------------------------ */

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

export function removeFile(path) {
  setState({ files: state.files.filter((f) => f.path !== path) })
}

export function clearFiles() {
  setState({ files: [] })
}

export function updateFile(path, patch) {
  setState({
    files: state.files.map((f) => (f.path === path ? { ...f, ...patch } : f))
  })
}

export function toast(message, kind = 'info') {
  setState({ toast: { message, kind, at: Date.now() } })
  window.setTimeout(() => {
    if (state.toast && state.toast.message === message) setState({ toast: null })
  }, 2600)
}
