# workspaces

> AS-020 P2/P4/P5/P6: Workspace 管理 + Daemon 通信 + 任务分发

⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/workspaces/ws-gateway.ts, apps/api/src/modules/workspaces/daemon-routes.ts, apps/api/src/modules/workspaces/gc-service.ts, apps/api/src/modules/workspaces/local-workspace.ts, apps/api/src/modules/workspaces/task-routes.ts, apps/api/src/modules/workspaces/token.routes.ts, apps/api/src/modules/workspaces/workspace.routes.ts

<!-- STALE_SINCE: 2026-07-18 -->
⚠️ 以下文件已变更，本节可能过期: apps/api/src/modules/workspaces/ws-gateway.ts, apps/api/src/modules/workspaces/daemon-routes.ts, apps/api/src/modules/workspaces/gc-service.ts, apps/api/src/modules/workspaces/local-workspace.ts, apps/api/src/modules/workspaces/task-routes.ts, apps/api/src/modules/workspaces/token.routes.ts, apps/api/src/modules/workspaces/workspace.routes.ts

## 职责

远程 Workspace 注册/心跳、Token 管理、WS 网关（Daemon 通信）、目录发现代理、任务 claim/事件回报、GC 清理。

## 核心导出

| 文件 | 职责 |
|------|------|
| workspace.routes.ts | Workspace CRUD + 注册/心跳 API |
| token.routes.ts | Token 生成/列表/撤销 API |
| ws-gateway.ts | /ws/daemon WebSocket 网关（auth + 消息路由） |
| discover-proxy.ts | WS 代理转发 /api/discover 到 Daemon |
| task-routes.ts | POST /tasks/:id/claim（Daemon 拉取任务） |
| daemon-routes.ts | Daemon 事件回报 API |
| gc-service.ts | GC 策略（done 24h / orphan 72h / artifact 12h） |
| local-workspace.ts | VPS 本地 Workspace 自动注册 |

## 依赖关系

- 依赖：`ws`（WebSocket 库）
- 被依赖：`agents/`（任务分发）、`channels/`（Channel Workspace 设置）、`web/`（UI 组件）

## 注意事项

- Token hash 用 SHA-256，原始 token 只在生成时返回一次
- WS 网关同端口 nginx upgrade（`location /ws/`）
- Local workspace token=NULL，Server 启动时自动创建

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `0d1ef570`: ci): resolve type errors found by package-level tsc build
- ✅ `13f60e68`: db-removal): migrate 9 more files from Prisma → FileStore (Round 2)
- ✅ `1773bfdf`: db-removal): migrate 11 files from Prisma → FileStore (59 calls eliminated)
