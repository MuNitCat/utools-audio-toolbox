/**
 * MCP 工具注册入口。
 * 关键：必须在模块加载时就注册，不能等 React 挂载 ——
 * MCP 调用会在插件未打开时静默拉起插件，只等 registerTool 完成。
 */

import { registerAllTools } from './mcp.js'

let registered = 0

export function registerMcpTools() {
  const utools = typeof window !== 'undefined' ? window.utools : null
  if (!utools || typeof utools.registerTool !== 'function') {
    console.warn('[audio-batch] 当前环境没有 utools.registerTool，跳过 MCP 注册')
    return 0
  }
  try {
    registered = registerAllTools(utools)
    console.log(`[audio-batch] 已注册 ${registered} 个 MCP 工具`)
  } catch (err) {
    console.error('[audio-batch] 注册 MCP 工具失败：', err)
    registered = 0
  }
  return registered
}

registerMcpTools()

export function toolCount() {
  return registered
}
