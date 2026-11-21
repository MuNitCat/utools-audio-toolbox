import { useEffect } from 'react'
import Icon from '../components/Icon.jsx'
import { OUTPUT_MODES, describeOutput } from '../core/output.js'

/** 输出设置弹窗：原来常驻在参数栏底部，现在收进齿轮里 */
export default function OutputModal({ open, onClose, settings, onChange }) {
  const api = typeof window !== 'undefined' ? window.audioServices : null

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
          <h3>输出设置</h3>
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
                  className="btn-ghost"
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

          <div className="field">
            <label>CPU 占用</label>
            <div className="segment">
              {[
                { v: 0, l: '自动' },
                { v: 4, l: '中' },
                { v: 2, l: '低' }
              ].map((o) => (
                <button
                  key={o.v}
                  className={Number(settings.threads) === o.v ? 'active' : ''}
                  onClick={() => onChange({ threads: o.v })}
                >
                  {o.l}
                </button>
              ))}
            </div>
          </div>

          <div className="field-row">
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
