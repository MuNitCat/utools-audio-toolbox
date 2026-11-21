/** 常用艺术家：执行成功后记一笔，最多保留 5 个 */

import { getState, setState } from './store.js'

const LIMIT = 5

/**
 * 取 preload 暴露的桥接对象；SSR 或单测环境返回 null。
 * @returns {object|null} window.audioServices
 */
function api() {
  return typeof window !== 'undefined' ? window.audioServices : null
}

/**
 * 启动时把配置里的常用艺术家读进 store。
 * 旧配置可能存了非字符串或超量数据，这里统一过滤 + 截断。
 * @returns {string[]} 过滤后的列表（最多 LIMIT 个）
 */
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

/**
 * 记一笔（去重 + 最新在前 + 最多 5 个），同时写回配置。
 * @param {string} raw 用户输入的艺术家名，空值直接忽略
 * @returns {string[]} 更新后的列表
 */
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
