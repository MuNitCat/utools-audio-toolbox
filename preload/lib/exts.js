'use strict'

/**
 * 音频 / 视频扩展名（preload 侧）。
 *
 * 数据在 shared/exts.json，前端 src/core/paths.js 读的是同一个文件——
 * 以前这里是两份手抄的数组，靠人眼同步，现在只有一份。
 * 构建脚本会把 shared/ 一起拷进 dist，所以这里的相对路径在产物里同样成立。
 *
 * 注意：本文件只放常量。输出命名规则（resolveOutput / numberedOutput 等）
 * 的唯一实现在前端 src/core/paths.js。
 */

const { audio, video } = require('../../shared/exts.json')

/** 音频扩展名 */
const AUDIO_EXTS = audio

/** 视频容器：全部走「视频提取音频」，不单独做视频处理 */
const VIDEO_EXTS = video

const MEDIA_EXTS = [...AUDIO_EXTS, ...VIDEO_EXTS]

module.exports = { AUDIO_EXTS, VIDEO_EXTS, MEDIA_EXTS }
