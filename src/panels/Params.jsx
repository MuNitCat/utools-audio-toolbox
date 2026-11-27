import { useEffect } from 'react'
import Select from '../components/Select.jsx'
import Tip from '../components/Tip.jsx'
import { useStore } from '../core/store.js'

/**
 * 决定 select 字段用哪种控件：少量短选项用分段按钮，稍多用卡片网格，其余走自绘下拉。
 * @param {object} field 字段定义
 * @returns {string} 控件类型标识（segment / grid / dropdown / number / file / dir / text …）
 */
function kindOf(field) {
  if (field.ui) return field.ui
  if (field.type !== 'select') return field.type
  const opts = field.options || []
  const maxLen = opts.reduce((m, o) => Math.max(m, String(o.label).length), 0)
  if (opts.length <= 3 && maxLen <= 5) return 'segment'
  if (opts.length <= 4 && maxLen <= 8) return 'grid'
  return 'dropdown'
}

/**
 * 卡片网格的列数：标签短且数量多时铺 4 列，3 个短标签铺 3 列，其余 2 列。
 * @param {object[]} opts 选项列表
 * @returns {number} 列数
 */
function gridCols(opts) {
  const maxLen = opts.reduce((m, o) => Math.max(m, String(o.label).length), 0)
  if (opts.length >= 5 && maxLen <= 5) return 4
  if (opts.length === 3 && maxLen <= 5) return 3
  return 2
}

/**
 * 单个字段的控件渲染。数字字段的步进按钮按 step 的小数位取整，
 * 否则 0.05 这种步长会被四舍五入卡住。
 * @param {{field: object, value: any, onChange: (key: string, value: any) => void}} props
 * @returns {JSX.Element} 控件节点
 */
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
              disabled={Boolean(o.disabled)}
              // 禁用项说明为什么点不动（例如只有一条音轨）
              title={o.disabled ? o.disabledTitle || o.title || o.label : o.label}
              onClick={() => onChange(field.key, o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      )
    }
    return (
      <div className={`option-grid cols-${gridCols(opts)}`}>
        {opts.map((o) => {
          const card = (
            <button
              key={String(o.value)}
              className={`option-card${String(value ?? '') === String(o.value) ? ' active' : ''}`}
              disabled={Boolean(o.disabled)}
              onClick={() => onChange(field.key, o.value)}
              // 有自绘气泡时不再挂原生 title，避免两套提示同时冒出来
              title={o.tip ? '' : o.title || o.label}
            >
              {o.label}
            </button>
          )
          if (!o.tip) return card
          return (
            <Tip key={String(o.value)} tip={o.tip}>
              {card}
            </Tip>
          )
        })}
      </div>
    )
  }

  switch (field.type) {
    case 'select':
      return (
        <Select
          value={value ?? ''}
          options={field.options || []}
          onChange={(v) => onChange(field.key, v)}
        />
      )
    case 'number': {
      const min = field.min !== undefined ? Number(field.min) : -Infinity
      const max = field.max !== undefined ? Number(field.max) : Infinity
      const step = Number(field.step) || 1
      const clamp = (n) => Math.min(max, Math.max(min, n))
      const current = value === '' || value === null || value === undefined ? '' : Number(value)

      // 步长可能是小数（速度 0.05），按整数四舍五入会让加减卡在原地
      const decimals = (String(step).split('.')[1] || '').length
      const roundTo = (n) => Number(n.toFixed(decimals))

      const bump = (delta) => {
        const base = Number.isFinite(current) && current !== '' ? current : Number.isFinite(min) ? min : 0
        onChange(field.key, roundTo(clamp(roundTo(base + delta))))
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

/**
 * 把字段声明里的 `optionDisabled(option, params, ctx)` 摊平成 `option.disabled`。
 * 判断逻辑留在功能定义里，控件层只认布尔值，不必知道为什么禁用。
 * @param {object} field 字段定义
 * @param {object} params 当前参数
 * @param {object} ctx hint / optionDisabled 的上下文（含 files）
 * @returns {object} 选项已带 disabled 的字段（无 optionDisabled 时原样返回）
 */
function resolveField(field, params, ctx) {
  if (typeof field.optionDisabled !== 'function' || field.type !== 'select') return field
  return {
    ...field,
    options: (field.options || []).map((o) => ({ ...o, disabled: Boolean(field.optionDisabled(o, params, ctx)) }))
  }
}

/**
 * 当前值落在被禁用选项上时的兜底值：优先字段默认值（若仍可用），其次第一个可用项。
 * @param {object} field 已 resolveField 过的字段
 * @returns {any} 可用的选项值；全部被禁用时返回 undefined
 */
function fallbackValue(field) {
  const opts = field.options || []
  const preferred = opts.find((o) => String(o.value) === String(field.default ?? ''))
  if (preferred && !preferred.disabled) return preferred.value
  const first = opts.find((o) => !o.disabled)
  return first ? first.value : undefined
}

/**
 * 参数面板：完全由功能定义驱动，不写死在组件里。
 * @param {{feature: object, params: object, onChange: (key: string, value: any) => void, files?: object[]}} props
 *   files 会透传给 hint / optionDisabled（ctx.files），用于「按已载入文件算文案」的提示
 * @returns {JSX.Element|null} 没有功能时返回 null
 */
export default function Params({ feature, params, onChange, files = [] }) {
  useStore((s) => s.featureId)
  const artists = useStore((s) => s.artistHistory)
  const probing = useStore((s) => s.probing)
  /** hint / optionDisabled 拿到的上下文：需要按已载入文件算文案时用（例如音轨数量） */
  const ctx = { files }

  // 选项级禁用在这里一次性算好，下面渲染与自动回退都用同一份结果。
  // 还在探测时不判：文件是逐个出结果的，中途的「都是单音轨」只是临时状态，
  // 提前锁死会把用户选好的「逐条导出」误拨回「仅第一条」。
  const fields = ((feature && feature.fields) || []).map((f) =>
    probing > 0 ? f : resolveField(f, params, ctx)
  )

  // 当前值被禁用（例如只剩 1 条音轨还停在「混合一条」）时自动拨回可用值，
  // 否则界面会停在一个既点不动、又会被 build 当成有效值的状态
  const fallback = fields
    .filter((f) => f.type === 'select')
    .map((f) => ({ field: f, value: fallbackValue(f) }))
    .find(({ field, value }) => {
      const hit = (field.options || []).find((o) => String(o.value) === String(params[field.key] ?? ''))
      return Boolean(hit && hit.disabled) && value !== undefined
    })
  const fallbackKey = fallback ? `${fallback.field.key}=${String(fallback.value)}` : ''

  useEffect(() => {
    if (fallbackKey) onChange(fallback.field.key, fallback.value)
    // fallbackKey 变化才需要重新拨值；fallback 对象每次渲染都是新的，不能进依赖
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fallbackKey])

  if (!feature) return null

  const visible = fields.filter((f) => (typeof f.showIf === 'function' ? f.showIf(params) : true))
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
          // 开关也能带 hint（提示放在开关行下方）
          const hint = typeof field.hint === 'function' ? field.hint(params, ctx) : field.hint
          return (
            <div className="field" key={field.key}>
              <div className="field-row">
                <label>{field.label}</label>
                <label className="switch">
                  <input type="checkbox" checked={Boolean(params[field.key])} onChange={(e) => onChange(field.key, e.target.checked)} />
                </label>
              </div>
              {hint ? <div className="field-hint">{hint}</div> : null}
            </div>
          )
        }
        const hint = typeof field.hint === 'function' ? field.hint(params, ctx) : field.hint
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
