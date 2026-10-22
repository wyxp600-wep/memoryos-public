# 独立内核接入说明

## 环境与数据路径

使用 Node.js 24 LTS 与 npm。在 `resources/memoryos` 执行 `npm ci`，按锁文件安装依赖。`dist/` 就是源码，不需要执行 build。

建议始终显式设置 `MEMORY_DB`。Windows 未设置时可能使用 `%APPDATA%/MemoryOS/data/memory.db`，因此验证应使用独立目录，避免操作已有数据。`MEMORYOS_DATA_DIR` 用于配置与核心发现信息，客户端应保持相关路径一致。

## 嵌入模式

| 模式 | 用途 | 约束 |
| --- | --- | --- |
| `fake` | 工具清单与隔离自测 | 确定性伪向量，没有真实语义；写入可能被生产保护门禁拒绝 |
| `local` | 本地模型嵌入 | 首次可能下载模型，需要模型缓存或网络 |
| `api` | 兼容 API 嵌入 | 需要端点、模型与密钥，文本会发送到配置的服务 |

API 模式使用 `EMBED_API_URL`、`EMBED_API_KEY`、`EMBED_MODEL`；模型维度需与 `EMBED_DIM` 一致。切换模型之前检查已有向量出处和维度，不混用不兼容向量。

## 看板鉴权

启动 `node dist/dashboard.js`，默认绑定 `127.0.0.1`，用 `MEMORY_PORT` 指定端口。令牌在首次启动时生成，写入数据库同目录的 `token` 文件。

在本机浏览器首次访问 `http://127.0.0.1:8795/?token=你的本机令牌`。鉴权后服务器移除 URL 中的令牌并设置 cookie。不要截图、分享或提交含令牌的 URL。也可用 `x-memory-token` 请求头调用本机 API。

另开 PowerShell，替换为实际数据目录：

```powershell
$dataPath = 'C:/memoryos-public/resources/memoryos/data'
$localToken = (Get-Content (Join-Path $dataPath 'token') -Raw).Trim()
Invoke-RestMethod 'http://127.0.0.1:8795/api/summary' -Headers @{ 'x-memory-token' = $localToken }
```

预期返回记忆统计 JSON。`401` 时检查令牌是否来自同一数据目录；`EADDRINUSE` 时更换端口；模块缺失时检查 `npm ci` 是否成功及 Node 版本。

## 工具权限与身份

先用 `--list-tools` 或客户端列表确认实际工具，不依赖固定数量。`MEMORY_AGENT` 标识调用方，它本身不是凭据。部分写入与任务工具需身份凭据或人工授权，应遵循工具返回的门禁提示，在本机看板配置权限。

执行工具默认关闭；只有确实需要时才在可信本机环境中配置权限，不将执行端口暴露到公网。任务委派不意味着客户端会自动执行所有动作。

## 测试与停止

`npm run lint` 检查语法；`npm test` 聚合冒烟，部分依赖真实模型和 LLM。测试使用独立数据路径，先检查每项是否自行隔离。看板按 `Ctrl+C` 停止，MCP 进程由客户端管理。

本快照不附带生产数据、模型、安装包与原生托盘源码，壳层源码不是完整桌面安装包。
