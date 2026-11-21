import { Fragment } from 'react'
import { FEATURES } from '../core/features.js'
import { FEATURE_ICON } from '../components/Icon.jsx'
import Icon from '../components/Icon.jsx'
import { setState, setTheme, useStore } from '../core/store.js'

const THEME_OPTIONS = [
  { value: 'auto', icon: 'auto', label: '跟随系统' },
  { value: 'light', icon: 'sun', label: '白天' },
  { value: 'dark', icon: 'moon', label: '黑夜' }
]

/**
 * 左侧功能导航。分组之间只画一条分隔线（靠 group 变化判断），
 * 所以 FEATURES 必须按分组连续排列，否则会出现重复的线。
 * @param {{hiddenFeatures?: string[]}} props 在「应用设置」里被取消勾选的功能 id
 * @returns {JSX.Element}
 */
export default function Sidebar({ hiddenFeatures = [] }) {
  const featureId = useStore((s) => s.featureId)
  const theme = useStore((s) => s.theme)
  const hidden = new Set(hiddenFeatures || [])
  const list = FEATURES.filter((f) => !f.hidden && !hidden.has(f.id))
  let lastGroup = null

  return (
    <div className="sidebar">
      <div className="sidebar-nav">
        {list.map((f) => {
          const divider = lastGroup !== null && lastGroup !== f.group
          lastGroup = f.group
          return (
            <Fragment key={f.id}>
              {divider && <div className="nav-divider" />}
              <button
                className={`nav-item${featureId === f.id ? ' active' : ''}`}
                title={f.desc}
                onClick={() => setState({ featureId: f.id })}
              >
                <Icon name={FEATURE_ICON[f.id] || 'sliders'} />
                <span>{f.name}</span>
              </button>
            </Fragment>
          )
        })}
      </div>

      <div className="sidebar-foot">
        <div className="theme-switch">
          {THEME_OPTIONS.map((o) => (
            <button
              key={o.value}
              className={theme === o.value ? 'active' : ''}
              title={o.label}
              aria-label={o.label}
              onClick={() => setTheme(o.value)}
            >
              <Icon name={o.icon} size={15} />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
