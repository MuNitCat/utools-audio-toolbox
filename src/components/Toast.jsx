import { useStore } from '../core/store.js'

export default function Toast() {
  const toast = useStore((s) => s.toast)
  if (!toast) return null
  return <div className={`toast ${toast.kind || 'info'}`}>{toast.message}</div>
}
