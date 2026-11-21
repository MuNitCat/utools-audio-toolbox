import { useEffect, useMemo, useState } from 'react'
import { enqueue } from '../core/queue.js'
import { quickPreview } from '../core/previewer.js'
import { addPaths, pickFiles } from '../core/ingest.js'
import { toast, useStore } from '../core/store.js'
import { formatBytes, formatClock } from '../core/format.js'
import { resolveOutputDir } from '../core/output.js'
import Icon from '../components/Icon.jsx'

const TIPS = {
  spectrum: {
    title: '频谱图能看出什么',
    items: [
      '假无损：高频在 16k / 19k 处突然断掉，多半是从有损格式转过来的',
      '码率足不足：高频被砍得越低，说明源编码越省',
      '电源哼声：50 / 60 Hz 处一条贯穿全图的亮线',
      '录音上限：20 kHz 处齐齐切平，通常是设备或采样率限制'
    ]
  },
  waveform: {
    title: '波形图能看出什么',
    items: [
      '削波失真：波峰顶部被削平，该处听感会发炸',
      '爆音：局部突然出现一根尖刺',
      '静音间隙：空白段就是天然的切分点',
      '响度分布：整体起伏是否忽大忽小，可用来对比标准化效果'
    ]
  }
}

export default function Viewer() {
  const files = useStore((s) => s.files)
  const preview = useStore((s) => s.preview)
  const tasks = useStore((s) => s.tasks)
  const usable = useMemo(() => files.filter((f) => f.info && f.info.ok), [files])

  const [picked, setPicked] = useState('')
  const [kind, setKind] = useState('spectrum')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [showTips, setShowTips] = useState(true)

  const currentPath = usable.some((f) => f.path === picked) ? picked : (usable[0] && usable[0].path) || ''
  const current = usable.find((f) => f.path === currentPath) || null

  const running = tasks.find(
    (t) => t.featureId === 'visualize' && (t.status === 'running' || t.status === 'pending')
  )
  const shown = preview && preview.file === currentPath ? preview : null

  const request = async (path, k) => {
    if (!path) return
    setLoading(true)
    setError('')
    try {
      await quickPreview({ path, info: (usable.find((f) => f.path === path) || {}).info }, k)
    } catch (err) {
      setError((err && err.message) || '预览失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!currentPath) return
    if (preview && preview.file === currentPath && preview.kind === kind) return
    request(currentPath, kind)
    // 只在「换了文件 / 换了类型」时触发，不跟 preview 走（否则会自激）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath, kind])

  const onDrop = async (e) => {
    e.preventDefault()
    const api = window.audioServices
    const paths = []
    for (const file of Array.from((e.dataTransfer && e.dataTransfer.files) || [])) {
      const p = api ? api.pathForFile(file) : ''
      if (p) paths.push(p)
    }
    if (paths.length) await addPaths(paths)
  }

  const generateFull = () => {
    if (!current) return
    const api2 = typeof window !== 'undefined' ? window.audioServices : null
    const cfg = api2 && api2.getConfig ? api2.getConfig() : {}
    try {
      enqueue({
        featureId: 'visualize',
        files: [current],
        params: {
          kind,
          width: 1920,
          height: 1080,
          outputDir: resolveOutputDir({ mode: cfg.outputMode, dir: cfg.outputDir }),
          suffix: `_${kind}`,
          overwrite: false,
          threadCount: 0
        }
      })
    } catch (err) {
      toast((err && err.message) || '生成失败', 'error')
    }
  }

  const tip = TIPS[kind]

  return (
    <div className="viewer" onDragOver={(e) => e.preventDefault()} onDrop={onDrop}>
      <div className="viewer-bar">
        <select
          className="select viewer-file"
          value={currentPath}
          onChange={(e) => setPicked(e.target.value)}
          disabled={!usable.length}
        >
          {usable.length === 0 && <option value="">（还没有文件）</option>}
          {usable.map((f) => (
            <option key={f.path} value={f.path}>
              {(f.info && f.info.name) || f.path.split('/').pop()}
            </option>
          ))}
        </select>

        <div className="segment viewer-seg">
          <button className={kind === 'spectrum' ? 'active' : ''} onClick={() => setKind('spectrum')}>
            频谱图
          </button>
          <button className={kind === 'waveform' ? 'active' : ''} onClick={() => setKind('waveform')}>
            波形图
          </button>
        </div>

        <button className="icon-btn" title="重新渲染" disabled={!current || loading} onClick={() => request(currentPath, kind)}>
          <Icon name="convert" />
        </button>
        <button className="link-btn" onClick={async () => {
          const picked2 = pickFiles()
          if (picked2 && picked2.length) await addPaths(picked2)
        }}>
          添加文件
        </button>

        <span className="spacer" />
        <button className="link-btn" onClick={() => setShowTips((v) => !v)}>
          {showTips ? '隐藏说明' : '作用说明'}
        </button>
      </div>

      {showTips && (
        <div className="viewer-tips">
          <div className="tip">
            <h4>{TIPS.spectrum.title}</h4>
            <ul>
              {TIPS.spectrum.items.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
          <div className="tip">
            <h4>{TIPS.waveform.title}</h4>
            <ul>
              {TIPS.waveform.items.map((t) => (
                <li key={t}>{t}</li>
              ))}
            </ul>
          </div>
        </div>
      )}

      <div className="viewer-canvas">
        {loading ? (
          <div className="viewer-hint">正在渲染…</div>
        ) : error ? (
          <div className="viewer-hint danger">{error}</div>
        ) : shown ? (
          <img src={shown.dataUrl} alt={kind === 'waveform' ? '波形图' : '频谱图'} />
        ) : usable.length ? (
          <div className="viewer-hint">还没有预览，点「重新渲染」试试</div>
        ) : (
          <div className="viewer-hint">
            <Icon name="chart" size={20} />
            <span>把音频拖到这里，立刻就能看到{kind === 'waveform' ? '波形' : '频谱'}</span>
          </div>
        )}
      </div>

      <div className="viewer-foot">
        <span className="ver">
          {current
            ? `${current.info.name} · ${formatClock(current.info.duration)} · ${current.info.bitrate || '?'}kbps · ${formatBytes(current.info.size)}`
            : '未选择文件'}
          {shown && shown.source === 'quick' && shown.trimmed ? ` · 预览取中间 ${Math.round(shown.seconds)} 秒` : ''}
          {shown && shown.source === 'full' ? ' · 完整图' : ''}
        </span>
        <span className="spacer" />
        {running && <span className="ver">正在生成 {Math.round(running.progress || 0)}%</span>}
        {shown && shown.source === 'full' && shown.path && (
          <button
            className="link-btn"
            onClick={() => {
              const api = window.audioServices
              if (api) api.openInFolder(shown.path)
            }}
          >
            在文件夹中显示
          </button>
        )}
        <button className="btn-primary" disabled={!current || Boolean(running)} onClick={generateFull}>
          {running ? '生成中' : '生成完整图'}
          <Icon name="arrow" size={14} />
        </button>
      </div>
    </div>
  )
}
