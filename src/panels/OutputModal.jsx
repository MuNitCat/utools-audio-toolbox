import { useEffect } from 'react'
import Icon from '../components/Icon.jsx'
import { FEATURES, GROUPS, isPinnedFeature } from '../core/features.js'
import { OUTPUT_MODES, describeOutput } from '../core/output.js'

/**
 * 应用设置弹窗：输出位置、覆盖策略，以及侧边栏显示哪些功能。
 * 改动即时生效，不设「保存」按钮。
 * @param {{open: boolean, onClose: () => void, settings: object, onChange: (patch: object) => void}} props
 * @returns {JSX.Element|null} 关闭时返回 null
 */
export default function OutputModal({ open, onClose, settings, onChange }) {
  const api = typeof window !== 'undefined' ? window.audioServices : null

  // 常驻功能不进列表（反正不能取消），旧配置里混进来的常驻 id 也顺手清掉
  const pickable = FEATURES.filter((f) => !f.hidden && !isPinnedFeature(f.id))
  const hiddenSet = new Set((settings.hiddenFeatures || []).filter((id) => !isPinnedFeature(id)))

  const toggleFeature = (id, checked) => {
    const set = new Set(hiddenSet)
    if (checked) set.delete(id)
    else set.add(id)
    onChange({ hiddenFeatures: [...set] })
  }

  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    document.body.classList.toggle('modal-open', Boolean(open))
    return () => document.body.classList.remove('modal-open')
  }, [open])

  if (!open) return null

  return (
    <div className="modal-mask" onClick={onClose}>
      <div className="modal output-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>应用设置</h3>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="modal-body">
          <div className="field">
            <label>输出位置</label>
            <div className="segment">
              {OUTPUT_MODES.map((m) => (
                <button
                  key={m.value}
                  className={settings.mode === m.value ? 'active' : ''}
                  onClick={() => onChange({ mode: m.value })}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {settings.mode !== 'custom' && (
            <div className="field">
              <label>实际位置</label>
              {/* 统一 32px 高，和「指定目录」那行的输入框对齐，切换模式时不跳 */}
              <div className={`path-box${settings.mode === 'sibling' ? ' plain' : ''}`} title={describeOutput(settings)}>
                {describeOutput(settings) || '系统未提供该目录'}
              </div>
            </div>
          )}

          {settings.mode === 'custom' && (
            <div className="field">
              <label>目录</label>
              <div className="inline">
                <div className="path-box" title={settings.dir || ''}>
                  {settings.dir || '未选择'}
                </div>
                <button
                  className="btn-ghost btn-pick"
                  onClick={() => {
                    const dir = api ? api.chooseDir('选择输出目录') : ''
                    if (dir) onChange({ dir })
                  }}
                >
                  选择
                </button>
              </div>
            </div>
          )}

          <div className="field-row tight">
            <label>覆盖同名文件</label>
            <label className="switch">
              <input
                type="checkbox"
                checked={Boolean(settings.overwrite)}
                onChange={(e) => onChange({ overwrite: e.target.checked })}
              />
            </label>
          </div>

          <div className="ff-hint">
            关掉「覆盖同名文件」时，遇到重名会自动加 (1)(2) 后缀，不会动原文件。
          </div>

          <div className="field">
            <label>任务并行数</label>
            <div className="segment">
              {[1, 2, 3, 4].map((n) => (
                <button
                  key={n}
                  className={Number(settings.parallel) === n ? 'active' : ''}
                  onClick={() => onChange({ parallel: n })}
                >
                  {n}
                </button>
              ))}
            </div>
            <div className="field-hint">
              同时处理几个文件；每个 ffmpeg 默认吃满所有核心，2 路已经够快，机器弱就用 1。
            </div>
          </div>

          <div className="modal-sub">侧边栏显示</div>

          {GROUPS.map((group) => {
            const items = pickable.filter((f) => f.group === group.id)
            if (!items.length) return null
            return (
              <div className="pick-group" key={group.id}>
                <div className="pick-group-title">{group.name}</div>
                <div className="pick-grid">
                  {items.map((f) => {
                    const checked = !hiddenSet.has(f.id)
                    return (
                      <label className="pick-row" key={f.id} title={f.desc}>
                        <input type="checkbox" checked={checked} onChange={(e) => toggleFeature(f.id, e.target.checked)} />
                        <span>{f.name}</span>
                      </label>
                    )
                  })}
                </div>
              </div>
            )
          })}

          <div className="ff-hint">
            取消勾选只是不在左侧导航里出现，功能本身和对应的 MCP 工具照常可用。「格式转换」「视频提取音频」是常驻功能，始终显示，不在此列表中。
          </div>
        </div>

        <div className="modal-foot">
          <span className="ff-hint">改动立即生效</span>
          <button className="btn-ghost" onClick={onClose}>
            关闭
          </button>
        </div>
      </div>
    </div>
  )
}
