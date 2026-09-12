# apps/api/src/modules/workspaces

> AS-020 遗留：本机 Workspace 记录 + CLI 运行时清单（远程节点/心跳方向已放弃；#481 起记录彻底退出执行面）

### 职责

本机 Workspace 记录的自动注册与查询（只读 list/get + 删除）、CLI 运行时清单扫描。Token 管理已随 #481 退役删除。

### 核心导出

| 文件 | 职责 |
|------|------|
| workspace.routes.ts | Workspace 只读查询（list/get/runtimes）+ 删除 API |
| local-workspace.ts | VPS 本地 Workspace 自动注册 + 本地 CLI 运行时扫描（`rescanLocalRuntimes` 供按需重扫） |
| workspace-store.ts | 记录读取与 root 解析（`getWorkspaceRecord`/`resolveWorkspaceRoot`），仅供 wu-verification 的 workspace 级 `verifyCommands` 覆盖、file-ref-vocabulary 候选集与 channel.routes 绑定存在性校验使用（**无执行语义**） |

### 依赖关系

- 被依赖：`agents/`（wu-verification 的 verifyCommands 覆盖）、`channels/`（file-ref-vocabulary 候选集、channel PATCH 绑定校验）、`web/`（WorkspacePage）

### 远程节点方向已判死（分两批清完）

- **2026-08（bdaf0dd3）**：删 `ws-gateway.ts`（/ws/daemon 远程执行 WS 网关）+ `RemoteExecutor` 簇 + `monitor.service` 节点离线扫描。第一性复审依据：生产 594 个 profile 无 nodeId、UI 创建角色不下发 nodeId、WS 客户端从未实现。当时**保留**了 workspace 注册/心跳/token/runtimes 链路，理由是角色向导要消费 `/workspaces/runtimes`。
- **2026-09-10（本次）**：把那份保留的残骸清掉——`daemon/{registration, workspace-config, discover-handler, path-sandbox}.ts` 四文件（唯一入口是 `studio daemon start`，其注册的对面根本没有客户端）、`studio daemon start` 命令本身、`POST /workspaces/register`、`PUT /:id/heartbeat`（全仓库零调用方）。保留 `daemon/cli-scanner.ts`：它是本机 CLI 扫描的实现，被 `local-workspace` 与 `agents/default-provider` 用着。
- **2026-09-11（#481）**：workspace 记录的 `workspaceRoot` 退出执行面。原先两条执行链——agent-loop「WU 绑定 workspaceId → 记录 root 当 cwd」（F6）与 worktree-resolver「无归属兜底读本机记录 root」——都已拆除：记录的 root 是服务器首次启动时从 `REPO_DIR` 抄入的一次性抄件（改配置不生效、启动顺序决定生效方）。替代机制：执行根 = 归属链直接路径（metadata.workspaceRoot）→ 代码类专属 worktree → 显式配置的共享工作目录（`REPO_DIR`，**执行时现场读**）→ 未配置落隔离 scratch。同时退役：「默认执行机器」设置面（web）、workspace token 子系统（见下）、归属链的显式/频道默认机器指针两级。记录本身保留（`runtimes` = 本机 CLI 清单唯一存放处；`workspaceRoot` 仅供 file-ref-vocabulary legacy 候选集与展示）。

### 注意事项

- Local workspace token=NULL，Server 启动时自动创建
- **'VPS' 命名约定的唯一属主在 studio-shared（2026-08 seam 修复）**：判定"哪条记录是本机 VPS workspace"（name='VPS' 且无 tokenId）由 `@dommaker/studio-shared/node` 的 `resolveVpsWorkspace()` 统一定义；本模块的 `local-workspace.findLocalWorkspace` 委托给它。改写存储格式/重命名 VPS workspace 时需同步该函数。
- 本地 CLI 扫描链（2026-07 修复后）：`local-workspace.scanLocalRuntimes()` 复用 `daemon/cli-scanner.scanAllProviders()`（provider 注册表驱动：内置 claude/kimi/codex/opencode，用户可经 `~/.studio/providers.json` 扩展），结果**全量替换 local workspace 记录的 `runtimes` 数组**；每次启动重扫 + `GET /workspaces/runtimes` 返回前 best-effort 重扫。扫描在 Server 所在机器执行：线上扫服务器，本地起服务扫本地。
- **`GET /workspaces/runtimes` = 本机 CLI 清单，不是节点聚合（2026-09-10 收敛）**：原语义「聚合所有 workspace 记录的 runtimes」（AC-2.6）是远程节点时代的产物，遍历 `listWorkspaces()` 全表。多节点执行已无活路径（bdaf0dd3 2026-08-04 判死），全表聚合的实际后果是：任何历史 daemon 注册记录（含 `status: offline` 的失效节点）的 runtimes 会**永久**出现在角色创建候选列表里且无回收机制——生产数据区一条 2026-07 的遗留记录躺了 54 天仍可勾选。现数据源改为 `resolveVpsWorkspace()`（本机那条），响应项收敛为 `{provider, version}`，`nodeId`/`workspaceName` 不再下发（创建角色只需 provider，见 `channelApi.createAgent`）。测试：`__tests__/runtimes-local-only.test.ts`。
- **workspace token 子系统已随 #481 删除（2026-09-11）**：`token.routes.ts`（生成/列表/撤销 API）+ route-registry 挂载 + `workspaceAuth()`（middleware/auth.ts）+ `WorkspaceTokenData`/`WORKSPACE_TOKENS_DIR` + 前端零引用的 `workspaceTokenApi` + 两处自证测试，全部移除（零行为变化：2026-09-10 盘点确认 `workspaceAuth()` 零路由引用、磁盘 token 文件全部缺 `workspaceId` 字段恒 401、UI 无入口）。无读取方的数据目录：`~/.studio/workspace-tokens/`、`~/.studio/data/workspace-tokens/`、`~/.studio/data/workspaces/`（后两个属旧 STUDIO_DATA_DIR 根）不夹代码 PR 处理。
- **承重面（勿删）**：`workspace.routes.ts` 的只读/删除端点（真实 HTTP 级测试 `__tests__/workspace-routes.test.ts`，#481 由自建内存 store 自证重写）+ `workspace-store.ts`——剩余链路：`channel.defaultWorkspaceId` 绑定存在性校验（channel PATCH）、file-ref-vocabulary legacy 候选集、wu-verification 按 `wu.workspaceId` 取 workspace 级 `verifyCommands` 覆盖（#481 未动；新 WU 已不再落 workspaceId，该覆盖只作用于历史绑定记录，后续另票评估）。
- **鉴权级别（2026-07 安全修复）**：本模块所有面向 UI 的端点（workspace 只读/删除/runtimes）= `requireAuth() + requireAdmin()` —— 生产环境必须 Admin 角色。⚠️ 前提修正（2026-07-24）：guest session `userId=null` 查不到用户记录，guest token **实际过不了 `requireAuth()`/Lurk Wall 大门**（等同匿名）；requireAdmin 的真实防线意义在于防御未来 User 角色账号与大门逻辑回归（workspace 记录含 workspaceRoot/runtimes.path/仓库路径等服务器信息）。
- **`GET /workspaces/runtimes` 挂 apiCache 60s（#403，ADR 2026-08-31 决策 5，已实施）**：每请求 best-effort 全量重扫（`cli-scanner.scanAllProviders()` 对每个 provider 同步 `execFileSync` 跑 `which` + `--version`，timeout 5s/个，阻塞事件循环最坏数十秒）→ 60s 档把重扫频次压到至多一次/分钟（缓存 seam 决策树第 2 问：HTTP 响应、秒级陈旧可接受）；apiCache 挂在 `requireAuth()+requireAdmin()` 之后（缓存 key 不含用户身份，不缓存 401/403）。前端三个挂载点中 ChannelMemberManager 已改懒挂载（成员面板首次展开才请求，决策 4）；RolesSetup 已随 E8-3 删除，CreateRoleModal 为低频设置面维持现状。配套：api-cache 中间件补「≥400 不缓存」护栏（错误响应不得钉死 TTL 窗口）。
- 历史坑（已修）：扫描结果曾写到 `~/.studio/workspace-runtimes/*.json` 且全仓库无读取方（断链），且硬编码列表漏扫 kimi、只在首次创建时扫一次 —— 2026-07 全部修正，旧目录写入已删除。
- 历史坑（#481 已清）：`__tests__/workspace.test.ts` 与 `__tests__/token.routes.test.ts` 通篇在自建内存 store 上断言，不 import 任何生产代码（假绿）。token.routes 随子系统删除；workspace 只读/删除端点重写为真打 HTTP 的 `workspace-routes.test.ts`（样板 runtimes-local-only.test.ts）。
