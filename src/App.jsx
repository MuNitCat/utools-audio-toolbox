import { useEffect } from 'react'
import MainPage from './pages/MainPage.jsx'
import Toast from './components/Toast.jsx'
import { addPaths } from './core/ingest.js'
import { setState, setTheme, toast } from './core/store.js'
import { loadArtistHistory } from './core/history.js'

/**
 * 订阅「带文件进入插件」（右键文件 → uTools、拖到主输入框）。
 *
 * 宿主实现里 `utools.onPluginEnter` 是**单槽赋值**（后注册覆盖先注册），
 * 而 preload 需要这个事件来白名单授权，所以监听权归 preload，页面只能订阅。
 * 页面若自己再调一次宿主接口，会把 preload 的回调顶掉 → 路径未授权，文件加不进来。
 * @returns {() => void} 取消订阅（旧 preload 场景为空函数）
 */
function watchPluginEnter() {
  const api = typeof window !== 'undefined' ? window.audioServices : null
  if (api && typeof api.onEnterFiles === 'function') {
    return api.onEnterFiles((paths) => {
      if (paths && paths.length) addPaths(paths)
    })
  }

  // 旧 preload（没有 onEnterFiles）：退回自己监听，此时的 preload 也不监听该事件，不会互相覆盖
  const utools = window.utools
  if (utools && typeof utools.onPluginEnter === 'function') {
    utools.onPluginEnter((action) => {
      if (!action) return
      if (action.type === 'files' && Array.isArray(action.payload)) {
        const paths = action.payload.map((p) => p && p.path).filter(Boolean)
        if (paths.length) addPaths(paths)
      }
    })
  }
  return () => {}
}

/**
 * 根组件：挂载时做一次性初始化 —— 读配置、应用主题、载入艺术家历史、
 * 清理上次运行留下的临时文件，并订阅宿主的「带文件进入插件」事件。
 * @returns {JSX.Element} 主界面 + 全局提示条
 */
export default function App() {
  useEffect(() => {
    const api = window.audioServices
    if (api) {
      // 先落配置：主题、输出位置都要 store.config 才能算出来
      const cfg = api.getConfig()
      setState({ config: cfg })
      setTheme(cfg.theme || 'auto')
      loadArtistHistory()
      // 预览图和 concat 列表都写在插件临时目录，超过 24h 的可以放心删
      try {
        api.cleanupTemp(24 * 3600 * 1000)
      } catch (_) {}
      // 本机配置目录全不可写时配置只活在本次会话，明确告知而不是静默丢失
      if (cfg._localDegraded) toast('本机配置目录不可写，本次设置仅在当前会话生效', 'error')
    }

    const offEnter = watchPluginEnter()
    // 注意：不注册 onPluginOut —— 关闭窗口/退出后台时让宿主进程与 ffmpeg 自行走完
    return offEnter
  }, [])

  return (
    <>
      <MainPage />
      <Toast />
    </>
  )
}
