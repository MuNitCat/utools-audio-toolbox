import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * 轻量气泡提示：hover / 键盘聚焦时把气泡 portal 到 body，position: fixed。
 *
 * 为什么不直接用 .tip-host + data-tip（伪元素）：参数栏 .panel 是 overflow-y: auto，
 * 绝对定位的气泡会被裁掉；这里用 portal 才能贴边翻转、不被裁。
 *
 * @param {object} props
 * @param {string} props.tip 提示文案（空字符串则不显示气泡，只渲染 children）
 * @param {React.ReactNode} props.children 触发元素（通常是按钮）
 * @param {number} [props.maxWidth] 气泡最大宽度，默认 220px
 * @returns {JSX.Element} 包裹了触发元素的锚点 +（可见时）气泡
 */
export default function Tip({ tip, children, maxWidth = 220 }) {
  const [box, setBox] = useState(null)
  const anchorRef = useRef(null)
  const text = typeof tip === 'string' ? tip.trim() : ''

  const hide = () => setBox(null)

  const show = () => {
    const el = anchorRef.current
    if (!text || !el || typeof window === 'undefined') return
    const r = el.getBoundingClientRect()
    // 先按最大宽度算，再按估算高度决定朝上还是朝下
    const width = Math.min(maxWidth, window.innerWidth - 16)
    const perLine = Math.max(8, Math.floor(width / 12))
    const lines = Math.ceil(text.length / perLine)
    const height = lines * 17 + 10
    const below = window.innerHeight - r.bottom - 6
    const up = below < height && r.top > below
    const left = Math.min(Math.max(8, r.left + r.width / 2 - width / 2), window.innerWidth - width - 8)
    setBox({ left, top: up ? r.top - 6 - height : r.bottom + 6, width })
  }

  useEffect(() => {
    if (!box) return undefined
    // 滚动或改尺寸后位置就不对了，直接收起
    const onScroll = () => setBox(null)
    const onKey = (e) => {
      if (e.key === 'Escape') setBox(null)
    }
    window.addEventListener('scroll', onScroll, true)
    window.addEventListener('resize', onScroll)
    document.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      window.removeEventListener('resize', onScroll)
      document.removeEventListener('keydown', onKey)
    }
  }, [box])

  return (
    <span
      className="tip-anchor"
      ref={anchorRef}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {box && typeof document !== 'undefined'
        ? createPortal(
            <div className="tip-bubble" style={{ left: box.left, top: box.top, width: box.width }} role="tooltip">
              {text}
            </div>,
            document.body
          )
        : null}
    </span>
  )
}
