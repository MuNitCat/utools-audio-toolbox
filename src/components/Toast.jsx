import { useStore } from '../core/store.js'

/**
 * 全局提示条：消息由 store.toast 驱动，只负责渲染，不做定时器。
 * @returns {JSX.Element|null} 没有消息时返回 null
 */
export default function Toast() {
  const toast = useStore((s) => s.toast)
  if (!toast) return null
  return <div className={`toast ${toast.kind || 'info'}`}>{toast.message}</div>
}
