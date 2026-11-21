/**
 * 渲染进程入口。
 * import 顺序有讲究：core/register.js 必须在 App 之前执行 ——
 * MCP 调用会在插件窗口未打开时静默拉起插件，只等 registerTool 完成，
 * 所以工具注册只能放在模块加载阶段，不能挪进组件生命周期。
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import './core/register.js'
import App from './App.jsx'
import './styles/global.css'

createRoot(document.getElementById('root')).render(<App />)
