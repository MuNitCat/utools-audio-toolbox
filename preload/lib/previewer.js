'use strict'

/**
 * 快速预览：不产出交付文件，只渲染一张临时 PNG 给界面看。
 * 长音频按「中间 N 秒」取样，否则 1.5 小时的素材要解码一分多钟。
 */

const fs = require('node:fs')
const path = require('node:path')
const { run } = require('./ffmpeg')
const fsx = require('./fsx')

const FILTERS = {
  spectrum: (w, h) => `showspectrumpic=s=${w}x${h}:legend=1:scale=log`,
  waveform: (w, h) => `showwavespic=s=${w}x${h}:colors=#4C9AFF:split_channels=0`
}

/**
 * @param {{input:string, kind?:'spectrum'|'waveform', width?:number, height?:number,
 *          mode?:'quick'|'full', seconds?:number, duration?:number, token?:string}} opts
 */
async function render(opts = {}) {
  const {
    input,
    kind = 'spectrum',
    width = 1280,
    height = 640,
    mode = 'quick',
    seconds = 60,
    duration = 0,
    token = ''
  } = opts

  if (!input || !fs.existsSync(input)) throw new Error('文件不存在')

  const dir = fsx.tempDir()
  const out = path.join(dir, `audio-batch-preview-${process.pid}-${Date.now()}.png`)

  const args = ['-hide_banner', '-nostdin', '-y']
  let from = 0
  let length = 0

  if (mode === 'quick' && Number(duration) > Number(seconds) + 1) {
    from = Math.max(0, Number(duration) / 2 - Number(seconds) / 2)
    length = Number(seconds)
    args.push('-ss', from.toFixed(2), '-t', String(length))
  }

  const filter = (FILTERS[kind] || FILTERS.spectrum)(Math.round(width), Math.round(height))
  args.push('-i', input, '-lavfi', filter, '-frames:v', '1', '-update', '1', out)

  try {
    await run(`preview:${token || path.basename(out)}`, args)
    const dataUrl = `data:image/png;base64,${fs.readFileSync(out).toString('base64')}`
    return {
      dataUrl,
      kind,
      width,
      height,
      from,
      seconds: length || Number(duration) || 0,
      trimmed: length > 0
    }
  } finally {
    // 预览图是临时的，读完就删，不留在临时目录里堆积
    try {
      fs.rmSync(out, { force: true })
    } catch (_) {}
  }
}

module.exports = { render }
