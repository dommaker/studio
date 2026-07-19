# agent-configs

> 此文件描述 apps/api/src/modules/agent-configs 目录的职责和上下文

## 职责

提供 Agent 配置管理的 REST 路由，支持 Agent 的增删改查以及版本快照（HZ-024, HZ-025）。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `router` | `routes.ts` | Express Router 实例，挂载了所有 Agent 配置相关的路由 |

## 依赖关系

上游依赖：
- `@dommaker/studio-shared` (FileStore)
- `express` (Router, Request, Response)
- `fs`, `os`, `path` (Node 内置)
- `../../utils/logger.js` (logger)

下游依赖：
- `apps/api/src/route-registry.ts` 引用此模块的路由，用于注册到主应用路由。

## 注意事项

- Agent 配置存储在用户目录 `~/.studio/agents/` 下，以 JSON 文件保存。
- 更新 Agent 前会自动创建版本快照，快照存储在 `agents/{agentId}/versions.jsonl`。
- 环境名称通过 `environments.json` 解析环境 ID。
- 默认使用 `FileStore` 进行文件 I/O。
