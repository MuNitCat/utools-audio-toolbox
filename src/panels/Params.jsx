import { useStore } from '../core/store.js'

/** select 字段的呈现方式：少量短选项用分段控件，稍多用卡片网格，否则下拉 */
function kindOf(field) {
  if (field.ui) return field.ui
  if (field.type !== 'select') return field.type
  const opts = field.options || []
  const maxLen = opts.reduce((m, o) => Math.max(m, String(o.label).length), 0)
  if (opts.length <= 3 && maxLen <= 5) return 'segment'
  if (opts.length <= 4 && maxLen <= 8) return 'grid'
  return 'dropdown'
}

/** 卡片网格的列数：短标签且数量多时铺 4 列 */
function gridCols(opts) {
  const maxLen = opts.reduce((m, o) => Math.max(m, String(o.label).length), 0)
  if (opts.length >= 5 && maxLen <= 5) return 4
  if (opts.length === 3 && maxLen <= 5) return 3
  return 2
}

function Control({ field, value, onChange }) {
  const api = typeof window !== 'undefined' ? window.audioServices : null
  const kind = kindOf(field)

  if (kind === 'segment' || kind === 'grid') {
    const opts = field.options || []
    if (kind === 'segment') {
      return (
        <div className="segment">
          {opts.map((o) => (
            <button
              key={String(o.value)}
              className={String(value ?? '') === String(o.value) ? 'active' : ''}
              onClick={() => onChange(field.key, o.value)}
              title={o.label}
            >
              {o.label}
            </button>
          ))}
        </div>
      )
    }
    return (
      <div className={`option-grid cols-${gridCols(opts)}`}>
        {opts.map((o) => (
          <button
            key={String(o.value)}
            className={`option-card${String(value ?? '') === String(o.value) ? ' active' : ''}`}
            onClick={() => onChange(field.key, o.value)}
            title={o.title || o.label}
          >
            {o.label}
          </button>
        ))}
      </div>
    )
  }

  switch (field.type) {
    case 'select':
      return (
        <select className="select" value={value ?? ''} onChange={(e) => onChange(field.key, e.target.value)}>
          {(field.options || []).map((o) => (
            <option key={String(o.value)} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      )
    case 'number': {
      const min = field.min !== undefined ? Number(field.min) : -Infinity
      const max = field.max !== undefined ? Number(field.max) : Infinity
      const step = Number(field.step) || 1
      const clamp = (n) => Math.min(max, Math.max(min, n))
      const current = value === '' || value === null || value === undefined ? '' : Number(value)

      const bump = (delta) => {
        const base = Number.isFinite(current) && current !== '' ? current : Number.isFinite(min) ? min : 0
        const next = clamp(Math.round(base + delta))
        onChange(field.key, Number(next.toFixed(4)))
      }

      const isAuto = value === 'auto'
      return (
        <>
          <div className={field.stepper ? 'stepper' : ''}>
            <input
              className="input"
              type="number"
              value={isAuto ? '' : (value ?? '')}
              placeholder={isAuto ? '原样' : ''}
              min={field.min}
              max={field.max}
              step={field.step}
              onChange={(e) => onChange(field.key, e.target.value === '' ? '' : Number(e.target.value))}
            />
            {field.stepper && (
              <>
                <button className="step-btn" title={`减少 ${step}`} onClick={() => bump(-step)}>
                  −
                </button>
                <button className="step-btn" title={`增加 ${step}`} onClick={() => bump(step)}>
                  +
                </button>
              </>
            )}
          </div>
          {Array.isArray(field.presets) && field.presets.length > 0 && (
            <div className="presets">
              {field.presets.map((raw) => {
                const item = typeof raw === 'object' ? raw : { value: raw, label: String(raw) }
                const active = String(value ?? '') === String(item.value)
                return (
                  <button
                    key={String(item.value)}
                    className={`preset${active ? ' active' : ''}`}
                    title={item.title || item.label}
                    onClick={() => onChange(field.key, item.value)}
                  >
                    {item.label}
                  </button>
                )
              })}
            </div>
          )}
        </>
      )
    }
    case 'file':
      return (
        <div className="inline">
          <div className="path-box" title={value || ''}>
            {value ? value.split('/').pop() : '未选择'}
          </div>
          <button
            className="btn-ghost"
            onClick={() => {
              const picked = api
                ? api.chooseFiles({ title: '选择图片', filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'bmp'] }] })
                : []
              if (picked && picked.length) onChange(field.key, picked[0])
            }}
          >
            选择
          </button>
          {value ? (
            <button className="btn-ghost" onClick={() => onChange(field.key, '')}>
              清除
            </button>
          ) : null}
        </div>
      )
    case 'dir':
      return (
        <div className="inline">
          <div className="path-box" title={value || ''}>
            {value || '原地'}
          </div>
          <button
            className="btn-ghost"
            onClick={() => {
              const dir = api ? api.chooseDir('选择目录') : ''
              if (dir) onChange(field.key, dir)
            }}
          >
            选择
          </button>
        </div>
      )
    default:
      return (
        <input
          className="input"
          type="text"
          value={value ?? ''}
          placeholder={field.placeholder || ''}
          onChange={(e) => onChange(field.key, e.target.value)}
        />
      )
  }
}

export default function Params({ feature, params, onChange }) {
  useStore((s) => s.featureId)
  const artists = useStore((s) => s.artistHistory)
  if (!feature) return null

  const visible = feature.fields.filter((f) => (typeof f.showIf === 'function' ? f.showIf(params) : true))
  if (!visible.length) return <div className="empty">这个功能没有可调参数</div>

  return (
    <>
      {visible.map((field) => {
        if (field.type === 'hint') {
          return (
            <div className="field-hint" key={field.key}>
              {field.text}
            </div>
          )
        }
        if (field.type === 'notice') {
          return (
            <div className="notice" key={field.key}>
              {field.text}
            </div>
          )
        }
        if (field.type === 'switch') {
          return (
            <div className="field-row" key={field.key}>
              <label>{field.label}</label>
              <label className="switch">
                <input type="checkbox" checked={Boolean(params[field.key])} onChange={(e) => onChange(field.key, e.target.checked)} />
              </label>
            </div>
          )
        }
        const hint = typeof field.hint === 'function' ? field.hint(params) : field.hint
        return (
          <div className="field" key={field.key}>
            <label>{field.label}</label>
            <Control field={field} value={params[field.key]} onChange={onChange} />
            {field.suggestions === 'artists' && artists.length > 0 && (
              <div className="field-chips">
                {artists.map((name) => (
                  <button
                    key={name}
                    className={`chip-sm${params[field.key] === name ? ' active' : ''}`}
                    title={`填入「${name}」`}
                    onClick={() => onChange(field.key, name)}
                  >
                    {name}
                  </button>
                ))}
              </div>
            )}
            {hint ? <div className="field-hint">{hint}</div> : null}
          </div>
        )
      })}
    </>
  )
}
