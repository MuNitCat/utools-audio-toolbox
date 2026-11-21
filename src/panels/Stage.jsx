import { useState } from 'react'
import { clearFiles, removeFile, useStore } from '../core/store.js'
import { addPaths, pickFiles } from '../core/ingest.js'
import { formatBytes, formatClock, formatShort } from '../core/format.js'
import Icon from '../components/Icon.jsx'

/**
 * 拖放处理。Electron 32+ 拿不到 File.path，必须走 preload 的 pathForFile。
 * @returns {{over: boolean, setOver: (v: boolean) => void, handleDrop: Function, handleOver: Function}}
 */
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

/**
 * 文件区：空态是拖放区，有文件时列出名称/格式/时长/码率/采样率。
 * 视频文件的码率显示音轨码率，容器总码率放进悬停提示。
 * @returns {JSX.Element}
 */
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
          // 视频的总码率含画面，列表里给音轨码率；容器码率放进悬停提示
          const isVideo = Boolean(info.hasVideo)
          const bitrate = isVideo ? info.streamBitrate || info.bitrate : info.bitrate
          const sub = info.ok
            ? [
                formatClock(info.duration, false),
                bitrate ? `${isVideo ? '音频 ' : ''}${bitrate}kbps` : '',
                info.sampleRate ? `${info.sampleRate}Hz` : ''
              ]
                .filter(Boolean)
                .join(' · ')
            : f.error || '读取中…'
          const subTitle = info.ok
            ? [
                isVideo ? `视频容器总码率 ${info.bitrate || '?'}kbps` : '',
                info.codec ? `编码 ${info.codec}` : '',
                info.channels ? `${info.channels} 声道` : '',
                info.bitsPerSample ? `${info.bitsPerSample}bit` : ''
              ]
                .filter(Boolean)
                .join(' · ')
            : ''
          return (
            <div className="file-item" key={f.path}>
              <span className="name" title={f.path}>
                {info.name || f.path.split('/').pop()}
              </span>
              {info.ok && <span className="pill">{info.ext || '?'}</span>}
              {!info.ok && f.error && <span className="pill bad">!</span>}
              <span className="sub" title={subTitle}>
                {sub}
              </span>
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
