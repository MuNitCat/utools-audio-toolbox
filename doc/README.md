# 文档

两类文档：**技术参考**（`reference/`，随代码长期有效）与**修复日志**（本目录下的日期文件，一次事故一篇）。

## 技术参考

| 文档 | 内容 |
|---|---|
| [architecture](reference/architecture.md) | 数据流、模块职责、两条后端、生命周期 |
| [security](reference/security.md) | 授权模型、guard API、参数白名单、审核红线 |
| [config-and-storage](reference/config-and-storage.md) | 配置键表、同步/本机边界、迁移、探测缓存 |
| [features](reference/features.md) | 加功能 / 加 MCP 工具、字段、并发布局 |
| [ui](reference/ui.md) | 三栏骨架、主题、Select、层级、调试坑 |
| [ffmpeg](reference/ffmpeg.md) | 宿主能力、不可逆参数、已知坑、命名规则 |
| [testing](reference/testing.md) | 构建断言、check 脚本、验证阶梯 |
| [style](reference/style.md) | 依赖、分层、注释与 JSDoc |

工程约定的入口仍然是仓库根的 [AGENTS.md](../AGENTS.md)。

## 修复日志

记录已经发生并修好的缺陷。每条按「现象 → 影响 → 排查 → 根因 → 修复 → 回归防线」写，重点是**下次不要再踩**。

| 日期 | 文档 | 一句话 |
|---|---|---|
| 2026-11-27 | [1.0.0 审核意见整改记录](./2026-11-27-audit-remediation.md) | 3 条必须整改（getPath 扩权 / outputDir 通行证 / concat 绕过）+ 3 条建议整改，以及复核阶段追加的读写分离与迁移边界 |
| 2026-11-18 | [主题变量失效（light-dark）](./2026-11-18-theme-light-dark.md) | 深色下边框/背景全透明，切换白天无效 —— uTools 渲染进程不支持 `light-dark()` |

## 写新日志的约定

- 文件名 `YYYY-MM-DD-短横线小写英文.md`，放在 `doc/` 根下
- 开头必须写清**影响版本 / 严重级别 / 状态**
- 「排查过程」要保留走过的死路，那部分比结论更有复用价值
- 「回归防线」要落到可执行的东西上（构建校验项、AGENTS.md 规则、检查清单），而不是「以后注意点」
- 修完之后回到本文件补索引
