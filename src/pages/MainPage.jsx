import { useEffect, useMemo, useRef, useState } from 'react'
import Sidebar from '../panels/Sidebar.jsx'
import Params from '../panels/Params.jsx'
import Stage from '../panels/Stage.jsx'
import Tasks from '../panels/Tasks.jsx'
import OutputModal from '../panels/OutputModal.jsx'
import Viewer from '../panels/Viewer.jsx'
import FfmpegModal from '../panels/FfmpegModal.jsx'
import Icon from '../components/Icon.jsx'
import { defaultParams, getFeature } from '../core/features.js'
import { resolveOutputDir } from '../core/output.js'
import { tagsToParams } from '../core/tags.js'
import { rememberArtist } from '../core/history.js'
import { clearFinished, enqueue } from '../core/queue.js'
import { toast, useStore } from '../core/store.js'
import { formatShort } from '../core/format.js'

export default function MainPage() {
  const featureId = useStore((s) => s.featureId)
  const files = useStore((s) => s.files)
  const tasks = useStore((s) => s.tasks)
  const config = useStore((s) => s.config)
  const probing = useStore((s) => s.probing)

  const feature = getFeature(featureId)
  const [params, setParams] = useState(() => defaultParams(getFeature('convert')))
  const [settings, setSettings] = useState({ mode: 'sibling', dir: '', overwrite: false, threads: 0 })
  const [showOutput, setShowOutput] = useState(false)
  const [binInfo, setBinInfo] = useState(null)
  const [showFfmpeg, setShowFfmpeg] = useState(false)

  const usable = useMemo(() => files.filter((f) => f.info && f.info.ok), [files])

  useEffect(() => {
    const api = window.audioServices
    if (!api || typeof api.getBinaries !== 'function') return
    try {
      setBinInfo(api.getBinaries())
    } catch (_) {}
  }, [])

  const autoFilled = useRef(false)

  // 切换功能时重置参数；「标签与封面」额外从第一个文件读一次标签
  useEffect(() => {
    const next = getFeature(featureId)
    if (!next) return
    const base = defaultParams(next)
    autoFilled.current = false
    if (featureId === 'metadata' && usable.length) {
      Object.assign(base, tagsToParams(usable[0].info, base))
      autoFilled.current = true
    }
    setParams(base)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureId])

  // 进入时还没有文件：等第一个文件到位再补一次，之后列表怎么变都不再读
  useEffect(() => {
    if (featureId !== 'metadata' || autoFilled.current || !usable.length) return
    autoFilled.current = true
    setParams((prev) => ({ ...prev, ...tagsToParams(usable[0].info, prev) }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [featureId, usable.length])

  useEffect(() => {
    if (!config) return
    setSettings((prev) => ({
      ...prev,
      mode: config.outputMode || 'sibling',
      dir: config.outputDir || '',
      overwrite: Boolean(config.overwrite),
      threads: config.threads || 0
    }))
  }, [config])

  const busy = tasks.some((t) => t.status === 'running' || t.status === 'pending')
  const isViewer = featureId === 'visualize'
  const totalDuration = usable.reduce((sum, f) => sum + ((f.info && f.info.duration) || 0), 0)
  const lastOutput = [...tasks].reverse().find((t) => t.status === 'done' && t.output)

  const updateParam = (key, value) => setParams((prev) => ({ ...prev, [key]: value }))
  const updateSettings = (patch) => {
    // 副作用放在 updater 外面，避免 StrictMode 下重复写配置
    const next = { ...settings, ...patch }
    setSettings(next)
    const api = window.audioServices
    if (api) {
      try {
        api.setConfig({ outputMode: next.mode, outputDir: next.dir, overwrite: next.overwrite, threads: next.threads })
      } catch (_) {}
    }
  }

  const openOutputDir = () => {
    const api = window.audioServices
    if (!api) return
    const dir = resolveOutputDir(settings) || (usable[0] ? usable[0].path : '')
    if (dir) api.openInFolder(dir)
    else toast('还没有可打开的位置', 'error')
  }

  const run = () => {
    if (!usable.length) {
      toast('先添加音频文件', 'error')
      return
    }
    if (feature && feature.multi && usable.length < 2) {
      toast('这个功能至少需要 2 个文件', 'error')
      return
    }
    try {
      enqueue({
        featureId,
        files: usable,
        params: {
          ...params,
          outputDir: resolveOutputDir(settings),
          overwrite: settings.overwrite,
          threadCount: settings.threads
        }
      })
      // 执行成功才记，避免误触也写进历史
      if (featureId === 'metadata' && params.artist) rememberArtist(params.artist)

      const api = window.audioServices
      if (api) {
        api.setConfig({
          outputMode: settings.mode,
          outputDir: settings.dir,
          overwrite: settings.overwrite,
          threads: settings.threads,
          lastFeature: featureId
        })
      }
    } catch (err) {
      toast(err && err.message ? err.message : '启动失败', 'error')
    }
  }

  return (
    <div className="app">
      <div className="titlebar">
        <img src="./logo.png" alt="" />
        <h1>音频批量处理</h1>
        <div className="right">
          {probing > 0
            ? `读取中 ${probing}`
            : usable.length
              ? `${usable.length} 个 · ${formatShort(totalDuration)}`
              : '未添加文件'}
        </div>
      </div>

      <div className="content">
        <Sidebar />

        <div className="right">
          {isViewer ? (
            <Viewer />
          ) : (
            <>
              <div className="work">
                <div className="panel">
                  <div className="section-title">{feature ? feature.name : '参数'}</div>
                  <Params feature={feature} params={params} onChange={updateParam} />
                </div>

                <div className="stage">
                  <Stage />
                  <Tasks />
                </div>
              </div>

              <div className="footer">
                <button
                  className={`icon-btn tip-host tip-left${showOutput ? ' on' : ''}`}
                  data-tip="输出设置"
                  aria-label="输出设置"
                  onClick={() => setShowOutput(true)}
                >
                  <Icon name="gear" />
                </button>
                <button className="icon-btn tip-host" data-tip="打开输出目录" aria-label="打开输出目录" onClick={openOutputDir}>
                  <Icon name="folder" />
                </button>
                <button
                  className="icon-btn tip-host"
                  data-tip="打开最近一次的产出"
                  aria-label="打开最近输出"
                  onClick={() => {
                    const api = window.audioServices
                    if (lastOutput && api) api.openInFolder(lastOutput.output)
                    else toast('还没有完成的输出', 'error')
                  }}
                >
                  <Icon name="check" />
                </button>
                <button className="icon-btn tip-host" data-tip="清除已完成的任务" aria-label="清除已完成任务" onClick={clearFinished}>
                  <Icon name="list" />
                </button>
                <span className="spacer" />
                <button
                  className="ver-btn tip-host"
                  data-tip="查看 / 切换 FFmpeg（点击打开设置）"
                  aria-label="FFmpeg 设置"
                  onClick={() => setShowFfmpeg(true)}
                >
                  FFmpeg {binInfo ? binInfo.ffmpeg.version : '—'}
                </button>
                <button className="btn-primary" onClick={run} disabled={!usable.length || busy}>
                  {busy ? '处理中' : '开始处理'}
                  <Icon name="arrow" size={14} />
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      <FfmpegModal open={showFfmpeg} onClose={() => setShowFfmpeg(false)} onChange={setBinInfo} />
      <OutputModal
        open={showOutput}
        onClose={() => setShowOutput(false)}
        settings={settings}
        onChange={updateSettings}
      />
    </div>
  )
}
