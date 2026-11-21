import { useEffect } from 'react'
import MainPage from './pages/MainPage.jsx'
import Toast from './components/Toast.jsx'
import { addPaths } from './core/ingest.js'
import { setState, setTheme } from './core/store.js'
import { loadArtistHistory } from './core/history.js'

export default function App() {
  useEffect(() => {
    const api = window.audioServices
    if (api) {
      const cfg = api.getConfig()
      setState({ config: cfg })
      setTheme(cfg.theme || 'auto')
      loadArtistHistory()
      try {
        api.cleanupTemp(24 * 3600 * 1000)
      } catch (_) {}
    }

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
