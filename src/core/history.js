/** 常用艺术家：执行成功后记一笔，最多保留 5 个 */

import { getState, setState } from './store.js'

const LIMIT = 5

function api() {
  return typeof window !== 'undefined' ? window.audioServices : null
}

export function loadArtistHistory() {
  const a = api()
  if (!a || typeof a.getConfig !== 'function') return []
  try {
    const list = a.getConfig().artistHistory
    const safe = Array.isArray(list) ? list.filter((x) => typeof x === 'string' && x.trim()) : []
    setState({ artistHistory: safe.slice(0, LIMIT) })
    return safe
  } catch (_) {
    return []
  }
}

/** 记一笔（去重 + 最新在前 + 最多 5 个），返回更新后的列表 */
export function rememberArtist(raw) {
  const name = String(raw || '').trim()
  if (!name) return getState().artistHistory

  const prev = getState().artistHistory || []
  const rest = prev.filter((x) => x.toLowerCase() !== name.toLowerCase())
  const next = [name, ...rest].slice(0, LIMIT)

  setState({ artistHistory: next })
  const a = api()
  if (a && typeof a.setConfig === 'function') {
    try {
      a.setConfig({ artistHistory: next })
    } catch (_) {}
  }
  return next
}
