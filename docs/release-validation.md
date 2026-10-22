# 公开快照验证记录

核验日期：2026-10-22。环境：Windows、Node.js v24.18.1。所有运行验证均使用发布副本与独立测试数据，未使用生产数据库。

| 检查 | 结果 |
| --- | --- |
| 锁文件修复 | 补齐 26 个缺失条目；原有条目的依赖版本变更数为 0 |
| 干净依赖安装 | `npm ci --no-audit --no-fund --registry=https://registry.npmjs.org` 成功，安装 310 个包 |
| 工具注册 | `node dist/server.js --list-tools` 返回 `##TOOLS##` 与 25 个默认工具 |
| 内核语法 | `npm run lint`：133 PASS / 0 FAIL |
| MCP 协议冒烟 | `node dist/smoke-mcp.js`：`MCP ALL PASS`，包含初始化、工具发现、记忆写入/检索/回读与任务生命周期 |
| 壳层单元测试 | `node --test tests/shell.test.js`：32 PASS / 0 FAIL |
| 看板 HTTP | 独立实例 `127.0.0.1:8795` 的鉴权首页和 `/api/summary` 均返回 HTTP 200 |
| 宣传页浏览器检查 | Edge 实际渲染；390 像素移动视口；接入锚点跳转与复制命令成功 |
| 发布内容检查 | 暂存文件未包含数据库、凭据目录、依赖、运行时、Android、原生托盘模块或大于 100 MB 的文件；凭据模式扫描无高风险命中 |

安装时 npm 提示部分依赖安装脚本需要本机审核。本次使用 `EMBED_MODE=fake` 验证协议流程，未验证本地真实嵌入、外部 LLM、所有聚合冒烟或完整 Electron 发行包；不能据此宣称这些能力全部通过。

## 可复现方法

按 README 创建独立 `data/` 目录后，设置 `MEMORY_DB`、`MEMORYOS_DATA_DIR` 与 `EMBED_MODE=fake`，在内核目录运行工具检查、语法检查和 MCP 冒烟。在仓库根目录运行壳层测试。不要用现有生产数据做试验。
