/** 线性图标集：16px 描边，避免引入图标库 */

const PATHS = {
  convert: (
    <>
      <path d="M3 7h10l-2.5-2.5M21 17H11l2.5 2.5" />
      <path d="M3 7v3M21 17v-3" opacity="0.35" />
    </>
  ),
  compress: (
    <>
      <path d="M4 12h16" />
      <path d="M12 4v5m0 0 3-3m-3 3L9 6M12 20v-5m0 0 3 3m-3-3-3 3" />
    </>
  ),
  clip: (
    <>
      <circle cx="6" cy="6" r="2.2" />
      <circle cx="6" cy="18" r="2.2" />
      <path d="M7.6 7.6 20 18M7.6 16.4 20 6" />
    </>
  ),
  merge: (
    <>
      <rect x="3.5" y="4" width="17" height="7" rx="2" />
      <rect x="3.5" y="13" width="17" height="7" rx="2" />
    </>
  ),
  speed: (
    <>
      <path d="M4.5 17a8 8 0 1 1 15 0" />
      <path d="M12 17l4-5" />
    </>
  ),
  gain: (
    <>
      <path d="M4 10v4h3l4 3.5V6.5L7 10H4z" />
      <path d="M15 9.5a3.5 3.5 0 0 1 0 5M17.8 7a7 7 0 0 1 0 10" />
    </>
  ),
  normalize: (
    <>
      <path d="M4 9v6M8 6v12M12 10v4M16 4v16M20 8v8" />
    </>
  ),
  resample: (
    <>
      <path d="M4 8h16M4 16h16" />
      <circle cx="9" cy="8" r="1.6" />
      <circle cx="15" cy="16" r="1.6" />
    </>
  ),
  denoise: (
    <>
      <path d="M4 12c2 0 2-4 4-4s2 8 4 8 2-8 4-8 2 4 4 4" />
      <path d="M4 19h16" opacity="0.35" />
    </>
  ),
  tag: (
    <>
      <path d="M4 11V5.5A1.5 1.5 0 0 1 5.5 4H11l9 9-6.5 6.5L4 11z" />
      <circle cx="8.2" cy="8.2" r="1.3" />
    </>
  ),
  video: (
    <>
      <rect x="3" y="5.5" width="12.5" height="13" rx="2.5" />
      <path d="M15.5 10.8 21 8v8l-5.5-2.8z" />
    </>
  ),
  image: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
      <circle cx="9" cy="10" r="1.5" />
      <path d="M4.5 16.5 9 12.5l3 2.5 3-3 4.5 4.5" />
    </>
  ),
  rename: (
    <>
      <path d="M4 19 9 5l5 14M6 14.5h6" />
      <path d="M17 19h4" opacity="0.5" />
    </>
  ),
  split: (
    <>
      <rect x="3.5" y="5" width="7" height="14" rx="2" />
      <rect x="13.5" y="5" width="7" height="14" rx="2" />
      <path d="M12 3v18" strokeDasharray="2 2.5" opacity="0.6" />
    </>
  ),
  trim: (
    <>
      <path d="M7 5v14M17 5v14" />
      <path d="M7 12h10" opacity="0.5" />
    </>
  ),
  fade: (
    <>
      <path d="M4 19V13M9 19V10M14 19V7M19 19V4" />
    </>
  ),
  chart: (
    <>
      <path d="M4 20V9M10 20V4M16 20v-7M22 20H2" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 8h16M4 16h16" />
      <circle cx="9" cy="8" r="2" />
      <circle cx="15" cy="16" r="2" />
    </>
  ),
  // 齿轮（Feather 的 settings 齿轮轮廓：外齿 + 中心轴），16px 下也能辨认
  gear: (
    <>
      <circle cx="12" cy="12" r="3.1" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  folder: (
    <>
      <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.2l2 2.5h7.8a2 2 0 0 1 2 2v6.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-9z" />
    </>
  ),
  check: <path d="M4 12.5 9 17.5 20 6.5" />,
  list: (
    <>
      <path d="M4 7h16M4 12h16M4 17h10" />
    </>
  ),
  arrow: <path d="M5 12h13m0 0-5-5m5 5-5 5" />,
  close: <path d="M6 6l12 12M18 6 6 18" />,
  auto: (
    <>
      <circle cx="12" cy="12" r="7.5" />
      <path d="M12 4.5v15" />
      <path d="M12 5.6a6.4 6.4 0 0 1 0 12.8z" fill="currentColor" stroke="none" opacity="0.5" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4.1" />
      <path d="M12 3v2.1M12 18.9V21M3 12h2.1M18.9 12H21M5.7 5.7l1.5 1.5M16.8 16.8l1.5 1.5M18.3 5.7l-1.5 1.5M7.2 16.8l-1.5 1.5" />
    </>
  ),
  moon: <path d="M20.2 14.6A8.3 8.3 0 0 1 9.4 3.8a8.6 8.6 0 1 0 10.8 10.8z" />
}

export default function Icon({ name, size = 16, className = '' }) {
  const body = PATHS[name] || PATHS.sliders
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {body}
    </svg>
  )
}

/** 功能 id -> 图标 */
export const FEATURE_ICON = {
  convert: 'convert',
  extract: 'video',
  compress: 'compress',
  clip: 'clip',
  merge: 'merge',
  speed: 'speed',
  gain: 'gain',
  edit: 'sliders',
  normalize: 'normalize',
  resample: 'resample',
  denoise: 'denoise',
  metadata: 'tag',
  cover: 'image',
  split: 'split',
  trimSilence: 'trim',
  fade: 'fade',
  visualize: 'chart'
}
