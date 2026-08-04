# workspaces

> AS-020 P2/P4/P5/P6: Workspace 管理 + Daemon 通信 + 任务分发

## 职责

远程 Workspace 注册/心跳、Token 管理、WS 网关（Daemon 通信）。

## 核心导出

| 文件 | 职责 |
|------|------|
| workspace.routes.ts | Workspace CRUD + 注册/心跳 API |
| token.routes.ts | Token 生成/列表/撤销 API |
| local-workspace.ts | VPS 本地 Workspace 自动注册 + 本地 CLI 运行时扫描（`rescanLocalRuntimes` 供按需重扫） |

## 依赖关系

- 被依赖：`agents/`（任务分发）、`channels/`（Channel Workspace 设置）、`web/`（UI 组件）

> ws-gateway.ts（/ws/daemon 远程执行 WS 网关）已随远程节点方向放弃于 2026-08 删除：
> 生产 594 个 profile 无 nodeId、UI 创建角色不下发 nodeId、WS 客户端从未实现。

## 注意事项

- Token hash 用 SHA-256，原始 token 只在生成时返回一次
- WS 网关同端口 nginx upgrade（`location /ws/`）
- Local workspace token=NULL，Server 启动时自动创建
- 本地 CLI 扫描链（2026-07 修复后）：`local-workspace.scanLocalRuntimes()` 复用 `daemon/cli-scanner.scanAllProviders()`（provider 注册表驱动：内置 claude/kimi/codex/opencode，用户可经 `~/.studio/providers.json` 扩展），结果**全量替换 local workspace 记录的 `runtimes` 数组**（与 daemon 注册同构）；每次启动重扫 + `GET /workspaces/runtimes` 聚合前 best-effort 重扫。扫描在 Server 所在机器执行：线上扫服务器，本地起服务扫本地。
- **鉴权级别（2026-07 安全修复）**：本模块所有面向 UI 的端点（workspace CRUD/runtimes、token.routes）= `requireAuth() + requireAdmin()` —— 生产环境必须 Admin 角色。⚠️ 前提修正（2026-07-24 实测）：guest session `userId=null` 查不到用户记录，guest token **实际过不了 `requireAuth()`/Lurk Wall 大门**（等同匿名）；requireAdmin 的真实防线意义在于防御未来 User 角色账号与大门逻辑回归（workspace 记录含 workspaceRoot/runtimes.path/仓库路径等服务器信息，token 管理泄露=节点被冒名）。daemon 专用端点（register/heartbeat）保持 `workspaceAuth()` token 鉴权不变。
- 历史坑（已修）：扫描结果曾写到 `~/.studio/workspace-runtimes/*.json` 且全仓库无读取方（断链），且硬编码列表漏扫 kimi、只在首次创建时扫一次 —— 2026-07 全部修正，旧目录写入已删除。
