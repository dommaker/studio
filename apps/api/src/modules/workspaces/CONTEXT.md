# workspaces

> AS-020 P2/P4/P5/P6: Workspace 管理 + Daemon 通信 + 任务分发

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
| local-workspace.ts | VPS 本地 Workspace 自动注册 + 本地 CLI 运行时扫描（`rescanLocalRuntimes` 供按需重扫） |

## 依赖关系

- 依赖：`ws`（WebSocket 库）
- 被依赖：`agents/`（任务分发）、`channels/`（Channel Workspace 设置）、`web/`（UI 组件）

## 注意事项

- Token hash 用 SHA-256，原始 token 只在生成时返回一次
- WS 网关同端口 nginx upgrade（`location /ws/`）
- Local workspace token=NULL，Server 启动时自动创建
- 本地 CLI 扫描链（2026-07 修复后）：`local-workspace.scanLocalRuntimes()` 复用 `daemon/cli-scanner.scanAllProviders()`（provider 注册表驱动：内置 claude/kimi/codex/opencode，用户可经 `~/.studio/providers.json` 扩展），结果**全量替换 local workspace 记录的 `runtimes` 数组**（与 daemon 注册同构）；每次启动重扫 + `GET /workspaces/runtimes` 聚合前 best-effort 重扫。扫描在 Server 所在机器执行：线上扫服务器，本地起服务扫本地。
- **鉴权级别（2026-07 安全修复）**：本模块所有面向 UI 的端点（workspace CRUD/runtimes、token.routes、task-routes、discover-proxy）= `requireAuth() + requireAdmin()` —— 生产环境必须 Admin 角色；`/auth/guest-session` 是公开端点，guest token 能过 `requireAuth()`，因此这些端点绝不能再退回只用 requireAuth（workspace 记录含 workspaceRoot/runtimes.path/仓库路径等服务器信息，token 管理泄露=节点被冒名）。daemon 专用端点（register/heartbeat/daemon-routes）保持 `workspaceAuth()` token 鉴权不变。
- 历史坑（已修）：扫描结果曾写到 `~/.studio/workspace-runtimes/*.json` 且全仓库无读取方（断链），且硬编码列表漏扫 kimi、只在首次创建时扫一次 —— 2026-07 全部修正，旧目录写入已删除。

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ 2026-07 安全修复：workspaces 模块 12 个 UI 端点（workspace CRUD/runtimes、token.routes×3、task-routes×3、discover-proxy）从 `requireAuth()` 收紧为 `requireAuth()+requireAdmin()` —— 此前 guest token（/auth/guest-session 公开可领）即可读服务器路径/CLI 信息、删 workspace、甚至签发 workspace token 冒名节点；`requireAdmin` = `requireRole('Admin')` 语义化包装；同批修复 `requireRole` 在 STUDIO_AUTH=none 下因无 session 恒 401 的既有缺陷（none 模式直接放行，pmo/outputs 等 Admin 端点本地恢复可用）
- ✅ 2026-07 频道角色修复：本地 CLI 扫描改走 provider 注册表（修漏扫 kimi），结果写入 workspace.runtimes 修复断链 bug（原写 ~/.studio/workspace-runtimes/ 无读取方），每次启动 + GET /workspaces/runtimes 时重扫
- ✅ `0d1ef570`: ci): resolve type errors found by package-level tsc build
- ✅ `13f60e68`: db-removal): migrate 9 more files from Prisma → FileStore (Round 2)
- ✅ `1773bfdf`: db-removal): migrate 11 files from Prisma → FileStore (59 calls eliminated)
