import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * 自绘下拉：不用原生 <select>。
 * 原因：原生弹层在 uTools 渲染进程里样式不可控（深色主题下是系统白底），
 * 选项文字长时宽度也不跟触发器对齐。
 *
 * 实现要点：
 * - 弹层 portal 到 body + position: fixed，避开 .panel(flex) 与滚动容器的裁剪
 * - 空间不够时向上翻；滚动/缩放时重新定位
 * - 触发器保持焦点，键盘 ↑↓/Home/End 移动高亮、Enter 选中、Esc 关闭
 */
const MENU_MAX_HEIGHT = 240
const MENU_GAP = 4
const OPTION_HEIGHT = 28

const Caret = () => (
  <svg className="sel-caret" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m6 9 6 6 6-6" />
  </svg>
)

const Tick = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 12.5 9 17.5 20 6.5" />
  </svg>
)

/**
 * 受控下拉。选项值原样回传给 onChange（不做字符串化），
 * 因此 options 里写 number 就得到 number。
 * @param {object} props
 * @param {string|number} props.value 当前值
 * @param {{value: string|number, label: string, title?: string, disabled?: boolean}[]} props.options 选项
 * @param {(value: any) => void} props.onChange 选中回调
 * @param {string} [props.placeholder] 没有匹配项时的占位文案
 * @param {boolean} [props.disabled] 禁用态
 * @param {string} [props.className] 追加到触发器上的类名
 * @param {string} [props.title] 触发器的悬停提示
 * @returns {JSX.Element} 触发器 +（打开时）portal 到 body 的弹层
 */
export default function Select({
  value,
  options = [],
  onChange,
  placeholder = '请选择',
  disabled = false,
  className = '',
  title = ''
}) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [box, setBox] = useState(null)
  const triggerRef = useRef(null)
  const menuRef = useRef(null)

  const selectedIndex = options.findIndex((o) => String(o.value) === String(value ?? ''))
  const selected = selectedIndex >= 0 ? options[selectedIndex] : null

  /**
   * 从 from 开始单向找第一个可用项（跳过 disabled），到边界为止。
   * @param {number} from 起始下标
   * @param {number} delta 步进方向（1 向下 / -1 向上）
   * @returns {number} 可停下高亮的项下标；全部禁用时返回 from 本身
   */
  const nextEnabled = (from, delta) => {
    let i = from
    for (let step = 0; step < options.length; step += 1) {
      if (i >= 0 && i < options.length && !options[i].disabled) return i
      i += delta
      if (i < 0 || i >= options.length) break
    }
    return from
  }

  const place = () => {
    const el = triggerRef.current
    if (!el || typeof window === 'undefined') return
    const r = el.getBoundingClientRect()
    const height = Math.min(MENU_MAX_HEIGHT, options.length * OPTION_HEIGHT + 8)
    const below = window.innerHeight - r.bottom - MENU_GAP
    const up = below < height && r.top > below
    setBox({
      left: r.left,
      width: r.width,
      top: up ? Math.max(MENU_GAP, r.top - MENU_GAP - height) : r.bottom + MENU_GAP,
      height
    })
  }

  const close = (refocus = false) => {
    setOpen(false)
    if (refocus && triggerRef.current) triggerRef.current.focus()
  }

  const commit = (index) => {
    const opt = options[index]
    // 禁用项点了不生效、也不关弹层，避免误以为选中了
    if (!opt || opt.disabled) return
    if (onChange) onChange(opt.value)
    close(true)
  }

  useEffect(() => {
    if (!open) return undefined
    place()
    setActive(nextEnabled(selectedIndex >= 0 ? selectedIndex : 0, 1))

    const onDown = (e) => {
      if (menuRef.current && menuRef.current.contains(e.target)) return
      if (triggerRef.current && triggerRef.current.contains(e.target)) return
      setOpen(false)
    }
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close(true)
      }
    }
    const onMove = () => place()

    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    window.addEventListener('resize', onMove)
    window.addEventListener('scroll', onMove, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('resize', onMove)
      window.removeEventListener('scroll', onMove, true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 高亮项滚入可视区
  useEffect(() => {
    if (!open || active < 0) return
    const node = menuRef.current && menuRef.current.children[active]
    if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const moveTo = (delta) => {
    if (!options.length) return
    const len = options.length
    setActive((i) => {
      // 循环找下一个可用项（跳过 disabled），转一整圈都没有就停在原地
      const start = i < 0 ? (delta > 0 ? -1 : 0) : i
      for (let step = 1; step <= len; step += 1) {
        const idx = (((start + delta * step) % len) + len) % len
        if (!options[idx].disabled) return idx
      }
      return i
    })
  }

  const onKeyDown = (e) => {
    if (disabled) return
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        setOpen(true)
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      moveTo(1)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      moveTo(-1)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActive(nextEnabled(0, 1))
    } else if (e.key === 'End') {
      e.preventDefault()
      setActive(nextEnabled(options.length - 1, -1))
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      commit(active)
    } else if (e.key === 'Tab') {
      setOpen(false)
    }
  }

  const canPortal = open && box && typeof document !== 'undefined'

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`sel${open ? ' open' : ''}${className ? ` ${className}` : ''}`}
        disabled={disabled}
        title={title || (selected ? selected.label : '')}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          if (!disabled) setOpen((v) => !v)
        }}
        onKeyDown={onKeyDown}
      >
        <span className={`sel-label${selected ? '' : ' empty'}`}>{selected ? selected.label : placeholder}</span>
        <Caret />
      </button>

      {canPortal
        ? createPortal(
            <div
              ref={menuRef}
              className="sel-menu"
              style={{ left: box.left, top: box.top, width: box.width, maxHeight: box.height }}
              role="listbox"
            >
              {options.map((o, i) => (
                <div
                  key={`${String(o.value)}-${i}`}
                  role="option"
                  aria-selected={i === selectedIndex}
                  aria-disabled={Boolean(o.disabled)}
                  className={`sel-option${i === active ? ' active' : ''}${i === selectedIndex ? ' current' : ''}${
                    o.disabled ? ' disabled' : ''
                  }`}
                  title={o.disabled ? o.disabledTitle || o.title || o.label : o.title || o.label}
                  onMouseEnter={() => {
                    if (!o.disabled) setActive(i)
                  }}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => commit(i)}
                >
                  <span>{o.label}</span>
                  {i === selectedIndex ? <Tick /> : null}
                </div>
              ))}
            </div>,
            document.body
          )
        : null}
    </>
  )
}
