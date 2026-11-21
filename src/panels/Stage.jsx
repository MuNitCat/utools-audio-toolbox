import { useState } from 'react'
import { clearFiles, removeFile, useStore } from '../core/store.js'
import { addPaths, pickFiles } from '../core/ingest.js'
import { formatBytes, formatClock, formatShort } from '../core/format.js'
import Icon from '../components/Icon.jsx'

function useDrop() {
  const [over, setOver] = useState(false)
  const handleDrop = async (e) => {
    e.preventDefault()
    setOver(false)
    const api = window.audioServices
    const paths = []
    for (const file of Array.from((e.dataTransfer && e.dataTransfer.files) || [])) {
      const p = api ? api.pathForFile(file) : ''
      if (p) paths.push(p)
    }
    if (paths.length) await addPaths(paths)
  }
  const handleOver = (e) => {
    e.preventDefault()
    setOver(true)
  }
  return { over, setOver, handleDrop, handleOver }
}

export default function Stage() {
  const files = useStore((s) => s.files)
  const probing = useStore((s) => s.probing)
  const featureId = useStore((s) => s.featureId)
  const { over, setOver, handleDrop, handleOver } = useDrop()
  const isExtract = featureId === 'extract'

  const totalDuration = files.reduce((sum, f) => sum + ((f.info && f.info.duration) || 0), 0)
  const totalSize = files.reduce((sum, f) => sum + ((f.info && f.info.size) || 0), 0)

  const onPick = async () => {
    const picked = pickFiles()
    if (picked && picked.length) await addPaths(picked)
  }

  if (!files.length) {
    return (
      <div className="stage-empty">
        <div
          className={`dropzone${over ? ' over' : ''}`}
          onDragOver={handleOver}
          onDragLeave={() => setOver(false)}
          onDrop={handleDrop}
          onClick={onPick}
        >
          <div>拖放{isExtract ? '视频' : '音频'}到这里</div>
          <div className="hint">
            {isExtract ? 'mp4 / mkv / mov / webm / avi / flv' : 'mp3 / m4a / aac / flac / wav / ogg / opus'}
          </div>
          <span className="pick" onClick={(e) => { e.stopPropagation(); onPick() }}>
            <Icon name="folder" />
            选择文件
          </span>
        </div>
      </div>
    )
  }

  return (
    <>
      <div className="stage-head" onDragOver={handleOver} onDrop={handleDrop}>
        <span>
          {files.length} 个文件 · {formatShort(totalDuration)} · {formatBytes(totalSize)}
          {probing > 0 ? ` · 读取中 ${probing}` : ''}
        </span>
        <span className="spacer" />
        <button className="link-btn" onClick={onPick}>
          继续添加
        </button>
        <button className="link-btn" onClick={clearFiles}>
          清空
        </button>
      </div>
      <div className={`stage-list${over ? ' over' : ''}`} onDragOver={handleOver} onDragLeave={() => setOver(false)} onDrop={handleDrop}>
        {files.map((f) => {
          const info = f.info || {}
          const sub = info.ok
            ? [formatClock(info.duration, false), info.bitrate ? `${info.bitrate}kbps` : '', info.sampleRate ? `${info.sampleRate}Hz` : '']
                .filter(Boolean)
                .join(' · ')
            : f.error || '读取中…'
          return (
            <div className="file-item" key={f.path}>
              <span className="name" title={f.path}>
                {info.name || f.path.split('/').pop()}
              </span>
              {info.ok && <span className="pill">{info.ext || '?'}</span>}
              {!info.ok && f.error && <span className="pill bad">!</span>}
              <span className="sub">{sub}</span>
              <button className="remove" title="移除" onClick={() => removeFile(f.path)}>
                <Icon name="close" size={13} />
              </button>
            </div>
          )
        })}
      </div>
    </>
  )
}
