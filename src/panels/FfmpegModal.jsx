import { useEffect, useState } from 'react'
import Icon from '../components/Icon.jsx'
import { toast } from '../core/store.js'

const DOWNLOADS = [
  {
    label: 'macOS 静态包',
    hint: 'evermeet.cx',
    url: 'https://evermeet.cx/ffmpeg/',
    tip: '解压后得到 ffmpeg 与 ffprobe 两个文件，拖进 /usr/local/bin'
  },
  {
    label: 'Windows 静态包',
    hint: 'gyan.dev',
    url: 'https://www.gyan.dev/ffmpeg/builds/',
    tip: '下载 release-essentials 压缩包，解压后把 bin 目录路径添加进来'
  },
  {
    label: '官方下载页',
    hint: 'ffmpeg.org',
    url: 'https://ffmpeg.org/download.html',
    tip: '各平台的构建版本汇总，也可以直接用包管理器安装'
  }
]

// 兜底项：即使后端没返回，也要保证「uTools 内置」在列表里
const HOST_ITEM = {
  id: 'host',
  path: '',
  dir: '',
  version: 'uTools 内置',
  major: 0,
  usable: true,
  ffprobe: '',
  source: 'host',
  extra: false,
  custom: false,
  current: false
}

/** 老版本 preload 没有 scanBinaries 时，至少把「当前在用的」和「内置」列出来 */
function fallbackItems(info) {
  const list = []
  const ff = info && info.ffmpeg
  if (ff && ff.source === 'system' && ff.path) {
    list.push({
      id: ff.path,
      path: ff.path,
      version: ff.version,
      usable: true,
      source: 'system',
      ffprobe: info.ffprobe ? info.ffprobe.version : '',
      extra: false,
      current: true
    })
  }
  return list
}

function withHost(list, isCurrent) {
  const arr = Array.isArray(list) ? [...list] : []
  if (!arr.some((i) => i.source === 'host')) arr.push({ ...HOST_ITEM, current: Boolean(isCurrent) })
  return arr
}

const PKG_CMD = {
  darwin: 'brew install ffmpeg',
  linux: 'sudo apt install ffmpeg',
  win32: 'winget install Gyan.FFmpeg'
}

export default function FfmpegModal({ open, onClose, onChange }) {
  const api = typeof window !== 'undefined' ? window.audioServices : null
  const [summary, setSummary] = useState(null)
  const [items, setItems] = useState(null)
  const [busy, setBusy] = useState(false)
  const [manual, setManual] = useState('')
  const [hint, setHint] = useState(null) // { kind: 'error'|'ok', text }
  const [stale, setStale] = useState(false)
  const [hoverDl, setHoverDl] = useState(-1)
  const platform = (api && api.platform && api.platform()) || 'darwin'
  const pkg = PKG_CMD[platform] || PKG_CMD.darwin
  const dlButtons = [
    ...DOWNLOADS,
    {
      label: '复制安装命令',
      hint: pkg,
      tip: `复制 ${pkg}，装完点「重新扫描」即可看到`
    }
  ]

  const applyScan = (info) => {
    if (!api) return
    const hostCurrent = !(info && info.ffmpeg && info.ffmpeg.source === 'system')
    if (typeof api.scanBinaries === 'function') {
      setItems(withHost(api.scanBinaries(), hostCurrent))
      setStale(false)
    } else {
      // preload 太旧，没有扫描接口：列出已知项并明确提示
      setItems(withHost(fallbackItems(info), hostCurrent))
      setStale(true)
    }
  }

  const refresh = () => {
    if (!api) return
    setBusy(true)
    try {
      const info = api.getBinaries()
      setSummary(info)
      applyScan(info)
    } catch (err) {
      setHint({ kind: 'error', text: (err && err.message) || '检测失败' })
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (typeof document !== 'undefined') {
      document.body.classList.toggle('modal-open', Boolean(open))
    }
    if (open) {
      setHint(null)
      setManual('')
      refresh()
    }
    return () => {
      if (typeof document !== 'undefined') document.body.classList.remove('modal-open')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  if (!open) return null

  const pick = (item) => {
    if (!api || item.current) return
    try {
      const next = api.setFfmpegPreference(item.source === 'host' ? { mode: 'host' } : { mode: 'custom', path: item.path })
      setSummary(next)
      applyScan(next)
      if (onChange) onChange(next)
      setHint(null)
    } catch (err) {
      setHint({ kind: 'error', text: (err && err.message) || '切换失败' })
    }
  }

  const addManual = () => {
    if (!api) return
    const value = manual.trim()
    if (!value) return
    if (typeof api.addFfmpegPath !== 'function') {
      setHint({ kind: 'error', text: 'preload 未更新，暂不支持添加路径；请完全退出插件后重新进入。' })
      return
    }
    try {
      const res = api.addFfmpegPath(value)
      if (!res || !res.ok) {
        setHint({ kind: 'error', text: (res && res.error) || '路径不可用' })
        return
      }
      setItems(withHost(res.items, false))
      setStale(false)
      setSummary(api.getBinaries())
      setManual('')
      setHint({ kind: 'ok', text: `已添加 ${res.version}：${res.path}` })
    } catch (err) {
      setHint({ kind: 'error', text: (err && err.message) || '添加失败' })
    }
  }

  const removeManual = (item) => {
    if (!api || typeof api.removeFfmpegPath !== 'function') return
    try {
      const info = api.getBinaries()
      setItems(withHost(api.removeFfmpegPath(item.path), info.ffmpeg && info.ffmpeg.source === 'host'))
      setSummary(info)
      setStale(false)
      setHint({ kind: 'ok', text: '已从列表移除' })
    } catch (err) {
      setHint({ kind: 'error', text: (err && err.message) || '移除失败' })
    }
  }

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>FFmpeg 设置</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="modal-body">
          <div className="ff-section">
            <div className="ff-section-title">
              可用 FFmpeg（点一行切换）
              <button className="link-btn" disabled={busy} onClick={refresh}>
                {busy ? '检测中…' : '重新扫描'}
              </button>
            </div>

            {summary && summary.customInvalid && (
              <div className="ff-hint danger">自定义路径已失效，当前暂用自动探测的结果。</div>
            )}

            {stale && (
              <div className="ff-hint danger">
                preload 未更新（当前 {api && api.version ? `v${api.version}` : '未知版本'}），扫描接口不可用。
                请完全退出插件（不是收起窗口）后重新进入；若装的是打包版，需要重新安装。
              </div>
            )}

            {items === null ? (
              <div className="ff-empty">{busy ? '正在扫描…' : '尚未扫描'}</div>
            ) : (
              <div className="ff-list">
                {items.map((item) => (
                  <div
                    key={item.id}
                    className={`ff-row${item.current ? ' current' : ''}${item.usable ? '' : ' disabled'}`}
                    role="button"
                    tabIndex={0}
                    onClick={() => item.usable && pick(item)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        if (item.usable) pick(item)
                      }
                    }}
                  >
                    <div className="ff-row-main">
                      <div className="ff-row-head">
                        <span className="ff-ver">{item.version}</span>
                        {item.source === 'host' && <span className="pill">内置</span>}
                        {item.source === 'system' && <span className="pill">{item.ffprobe ? '含 ffprobe' : '无 ffprobe'}</span>}
                        {item.extra && <span className="pill">手动添加</span>}
                        {!item.usable && <span className="pill bad">版本过低</span>}
                      </div>
                      <div className="ff-row-path" title={item.path || 'uTools 托管'}>
                        {item.path || 'uTools 托管（由宿主维护，必要时自动引导下载）'}
                      </div>
                    </div>

                    <div className="ff-row-side">
                      {item.extra && (
                        <button
                          className="icon-btn"
                          title="从列表移除"
                          aria-label="从列表移除"
                          onClick={(e) => {
                            e.stopPropagation()
                            removeManual(item)
                          }}
                        >
                          <Icon name="close" size={13} />
                        </button>
                      )}
                      <span className="ff-state">{item.current ? '已选' : '选择'}</span>
                      {item.current && <Icon name="check" size={14} className="ff-check" />}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="ff-section">
            <div className="ff-section-title">
              添加自定义路径
              <span
                className={`ff-title-tip on${hint ? (hint.kind === 'error' ? ' danger' : ' ok') : ''}`}
                title={hint ? hint.text : '可填可执行文件，也可填它所在的目录；添加前会先验证能否运行'}
              >
                {hint ? hint.text : '可填可执行文件，也可填它所在的目录；添加前会先验证能否运行'}
              </span>
            </div>
            <div className="ff-add">
              <input
                className="input"
                placeholder="/usr/local/bin/ffmpeg"
                value={manual}
                onChange={(e) => {
                  setManual(e.target.value)
                  setHint(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') addManual()
                }}
              />
              <button
                className="btn-ghost"
                onClick={() => {
                  const picked = api
                    ? api.chooseFiles({
                        title: '选择 ffmpeg 可执行文件',
                        filters: [{ name: '所有文件', extensions: ['*'] }]
                      })
                    : []
                  if (picked && picked.length) {
                    setManual(picked[0])
                    setHint(null)
                  }
                }}
              >
                浏览
              </button>
              <button className="btn-primary" disabled={!manual.trim()} onClick={addManual}>
                添加
              </button>
            </div>
          </div>

          <div className="ff-section">
            <div className="ff-section-title">
              没装？
              <span className={`ff-title-tip${hoverDl >= 0 ? ' on' : ''}`}>
                {hoverDl >= 0 ? dlButtons[hoverDl] && dlButtons[hoverDl].tip : ''}
              </span>
            </div>
            <div className="ff-dl-grid">
              {dlButtons.map((d, i) => (
                <button
                  className="ff-dl"
                  key={d.label}
                  onMouseEnter={() => setHoverDl(i)}
                  onMouseLeave={() => setHoverDl(-1)}
                  onFocus={() => setHoverDl(i)}
                  onBlur={() => setHoverDl(-1)}
                  onClick={() => {
                    if (d.url) {
                      if (api && api.openExternal) api.openExternal(d.url)
                      else window.open(d.url, '_blank')
                      return
                    }
                    if (api) api.copyText(pkg)
                    toast('已复制安装命令', 'success')
                  }}
                >
                  <span className="ff-dl-label">{d.label}</span>
                  <span className="ff-dl-hint mono">{d.hint}</span>
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="modal-foot">
          <span className="ff-hint">切换后立即生效，正在跑的任务不受影响。</span>
          <button className="btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
