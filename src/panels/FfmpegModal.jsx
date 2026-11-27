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

/**
 * 老版本 preload 没有 scanBinaries 时的兜底列表。
 * 只能列出「当前正在用的系统 ffmpeg」，其余候选扫不到就扫不到，
 * 界面会同时提示 preload 未更新。
 * @param {object} info getBinaries() 的返回值
 * @returns {object[]} 可渲染的列表项
 */
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

/**
 * 保证列表里永远有「uTools 内置」这一项，否则用户没有可回退的选择。
 * @param {object[]} list 后端返回的候选项
 * @param {boolean} isCurrent 内置项是否就是当前使用中的
 * @returns {object[]} 补全后的列表（不改原数组）
 */
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

/**
 * FFmpeg 设置弹窗：扫描/切换/手动添加可执行路径。
 * 所有动作都以 preload 的能力检测为前提（preload 不热更新，旧版本可能没有这些方法）。
 * @param {{open: boolean, onClose: () => void, onChange?: (info: object) => void}} props
 * @returns {JSX.Element|null} 关闭时返回 null
 */
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

  /**
   * 刷新候选列表。
   * @param {object} info summary（用于判断当前用的是不是宿主内置）
   * @param {boolean} force 是否强制重扫；打开弹窗时传 false，只有「重新扫描」才 true
   * @returns {Promise<void>} 无返回值
   */
  const applyScan = async (info, force = false) => {
    if (!api) return
    const hostCurrent = !(info && info.ffmpeg && info.ffmpeg.source === 'system')
    if (typeof api.scanBinaries === 'function') {
      // 新 preload 的 scan 是异步的（内部并发 -version），旧 preload 返回数组也能 await
      const list = await api.scanBinaries(force)
      setItems(withHost(Array.isArray(list) ? list : [], hostCurrent))
      setStale(false)
    } else {
      // preload 太旧，没有扫描接口：列出已知项并明确提示
      setItems(withHost(fallbackItems(info), hostCurrent))
      setStale(true)
    }
  }

  /**
   * 拉取当前结论并按需重扫。
   * @param {boolean} force 是否强制重扫候选（用户点「重新扫描」才传 true）
   * @returns {Promise<void>} 无返回值
   */
  const refresh = async (force = false) => {
    if (!api) return
    setBusy(true)
    try {
      // getBinaries 只回「当前在用的」，候选列表靠 scanBinaries 单独扫
      const info = typeof api.getBinariesAsync === 'function' ? await api.getBinariesAsync() : api.getBinaries()
      setSummary(info)
      await applyScan(info, force)
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

  const pick = async (item) => {
    if (!api || item.current) return
    try {
      const next = await api.setFfmpegPreference(item.source === 'host' ? { mode: 'host' } : { mode: 'custom', path: item.path })
      // 新 preload 会先校验路径/版本，失败返回 {ok:false,error}，不能当成切换成功
      if (next && next.ok === false) {
        setHint({ kind: 'error', text: next.error || '切换失败' })
        return
      }
      setSummary(next)
      await applyScan(next)
      if (onChange) onChange(next)
      setHint(null)
    } catch (err) {
      setHint({ kind: 'error', text: (err && err.message) || '切换失败' })
    }
  }

  const addManual = async () => {
    if (!api) return
    const value = manual.trim()
    if (!value) return
    if (typeof api.addFfmpegPath !== 'function') {
      setHint({ kind: 'error', text: 'preload 未更新，暂不支持添加路径；请完全退出插件后重新进入。' })
      return
    }
    setBusy(true)
    try {
      const res = await api.addFfmpegPath(value)
      if (!res || !res.ok) {
        setHint({ kind: 'error', text: (res && res.error) || '路径不可用' })
        return
      }
      setItems(withHost(res.items, false))
      setStale(false)
      setSummary(await (api.getBinariesAsync ? api.getBinariesAsync() : api.getBinaries()))
      setManual('')
      setHint({ kind: 'ok', text: `已添加 ${res.version}：${res.path}` })
    } catch (err) {
      setHint({ kind: 'error', text: (err && err.message) || '添加失败' })
    } finally {
      setBusy(false)
    }
  }

  const removeManual = async (item) => {
    if (!api || typeof api.removeFfmpegPath !== 'function') return
    try {
      const items = await api.removeFfmpegPath(item.path)
      const info = await (api.getBinariesAsync ? api.getBinariesAsync() : api.getBinaries())
      setItems(withHost(items, info.ffmpeg && info.ffmpeg.source === 'host'))
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
              <button className="link-btn" disabled={busy} onClick={() => refresh(true)}>
                {busy ? '检测中…' : '重新扫描'}
              </button>
            </div>

            {summary && summary.customInvalid && (
              <div className="ff-hint danger">自定义路径已失效，当前暂用自动探测的结果。</div>
            )}

            {api && !api.caps && (
              <div className="ff-hint danger">
                当前 preload 仍是旧版本（{api.version ? `v${api.version}` : '未知'}），路径白名单与参数校验未生效。
                请完全退出插件（不是收起窗口）后重新进入。
              </div>
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
