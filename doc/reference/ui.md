# 界面约定

## 骨架

三栏在 `pages/MainPage.jsx`：`.sidebar`（内含 `.sidebar-nav` + `.sidebar-foot`）/ `.panel` / `.stage` + `.footer`。

**`featureId === 'visualize'` 是例外**：整块换成 `panels/Viewer.jsx`，不渲染参数栏与底部工具栏。

## 主题

- 三档 `auto` / `light` / `dark` 在 `store.js` 的 `applyTheme()`：用 `matchMedia` 把 `auto` 解析成 `light`/`dark`，再写到 `<html data-theme>`
- CSS 只认 `:root` 与 `:root[data-theme='dark']` 两套变量；新颜色一律两块都加，不要写死颜色
- 监听 `prefers-color-scheme` 变化，但只在 auto 模式下重算
- ⚠️ **不要用 `light-dark()`**：uTools 渲染进程不支持，变量会变成无效值 → `background` / `border` 整条声明失效，界面直接全透明（线上踩过，见 `doc/2026-11-18-theme-light-dark.md`）
- 控件表面色用 `--surface`（浅色白、深色比背景亮一档），别用 `--bg`——深色下和面板同色，按钮看不出边界

## 下拉

一律用 `components/Select.jsx`，**禁止原生 `<select>`**：原生弹层在 uTools 里是系统白底，深色主题直接割裂。自绘版把弹层 portal 到 `body` + `position: fixed`（否则被 `.panel` 的 `overflow-y: auto` 裁掉），空间不够自动向上翻，带 ↑↓ / Home / End / Enter / Esc。

## 层级

`.tip-host::after` 400 > `.toast` 300 > `.modal-mask` 100。新增浮层按这个排，别用 90 之类的中间值（曾因 toast 90 < 蒙版 100，弹窗里点「复制」看不到提示）。

## 频谱 / 波形：两条路径别混

- **即时预览**（`preload/lib/previewer.js` + `core/previewer.js`）：取中间 60 秒渲染到临时目录，读完即删，只塞 `store.preview`，**不产出文件**
- **完整图**（`features.visualize` → 队列）：产出 PNG 到输出目录，完成后 `queue.js` 把图读成 data URL 也写进 `store.preview`（`source: 'full'`）

`store.preview` 会跨功能保留，**只有 `Viewer.jsx` 渲染它**；别在 `Stage` 或别处再读，否则切到别的功能时文件列表上方会莫名多出一张图。

**不要直接 `<img src="file://...">`**：开发模式页面是 `http://localhost:5180`，引用 `file://` 会被 Chromium 拦掉，生产走 `file://` 虽然能用但两边行为不一致。统一走 `coverDataUrl()` 转 data URL。

## 取消要双保险

`queue.js` 的 `cancel()`：先 `aborters.get(id).fire()` 让 task 的每个 await 立刻以「已取消」失败，再调 `api.cancelTask()` 通知 preload 杀进程。只靠杀进程不行——宿主的 `runFFmpeg` 未必能 kill，进程会一直跑到结束，界面就卡在「取消不了」。

批量探测的取消走 `cancelProbe(jobId)`（见 [architecture.md](./architecture.md)），不要复用 `cancelTask`。

## 新增 preload API 时前端必须能力检测

preload 不热更新，开发中很容易出现「界面是新代码、preload 是旧的」。用 `typeof api.xxx === 'function'` 判断，为假时要么降级要么明确提示「需要完全退出插件重进」，不能静默失败（FFmpeg 弹窗曾因此一直显示「尚未扫描」）。

## 调试：页面全白但浏览器正常

⚠️ 先 `curl http://127.0.0.1:5180/`。多半是 dev server 只绑了 IPv6 `[::1]`（Node 17+ 的 `localhost` 常先解析到 `::1`），而 `plugin.json` 写的是 `127.0.0.1`，宿主按 IPv4 连就被拒。

`vite.config.js` 的 `server.host` 必须显式写 `127.0.0.1`。别在这上面怀疑 React 代码——`lsof -nP -iTCP:5180` 看是 `IPv4` 还是 `IPv6` 更快。
