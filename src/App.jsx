import { useEffect } from 'react'
import MainPage from './pages/MainPage.jsx'
import Toast from './components/Toast.jsx'
import { addPaths } from './core/ingest.js'
import { setState, setTheme } from './core/store.js'
import { loadArtistHistory } from './core/history.js'

/**
 * 根组件：挂载时做一次性初始化 —— 读配置、应用主题、载入艺术家历史、
 * 清理上次运行留下的临时文件，并监听宿主的「带文件进入插件」事件。
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
    }

    // 从文件关联 / 图标拖入进入插件时，宿主会把路径塞在 action.payload 里
    const utools = window.utools
    if (utools && typeof utools.onPluginEnter === 'function') {
      utools.onPluginEnter((action) => {
        if (!action) return
        if (action.type === 'files' && Array.isArray(action.payload)) {
          const paths = action.payload.map((p) => p.path).filter(Boolean)
          if (paths.length) addPaths(paths)
        }
      })
    }
    // 注意：不注册 onPluginOut —— 关闭窗口/退出后台时让宿主进程与 ffmpeg 自行走完
  }, [])

  return (
    <>
      <MainPage />
      <Toast />
    </>
  )
}
