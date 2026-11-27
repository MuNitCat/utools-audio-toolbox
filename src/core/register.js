/**
 * MCP 工具注册入口。
 * 关键：必须在模块加载时就注册，不能等 React 挂载 ——
 * MCP 调用会在插件未打开时静默拉起插件，只等 registerTool 完成。
 */

import { registerAllTools } from './mcp.js'

let registered = 0

/**
 * 注册全部 MCP 工具。宿主没有 registerTool 时只告警不抛错，
 * 否则在没有 AI 能力的旧版本里界面会直接起不来。
 * @returns {number} 成功注册的工具数量；失败或环境不支持时为 0
 */
export function registerMcpTools() {
  const utools = typeof window !== 'undefined' ? window.utools : null
  if (!utools || typeof utools.registerTool !== 'function') {
    console.warn('[utools-audio-toolbox] 当前环境没有 utools.registerTool，跳过 MCP 注册')
    return 0
  }
  try {
    registered = registerAllTools(utools)
    console.log(`[utools-audio-toolbox] 已注册 ${registered} 个 MCP 工具`)
  } catch (err) {
    console.error('[utools-audio-toolbox] 注册 MCP 工具失败：', err)
    registered = 0
  }
  return registered
}

registerMcpTools()

/**
 * @returns {number} 已注册的工具数量（调试 / 状态展示用）
 */
export function toolCount() {
  return registered
}
