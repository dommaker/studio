# apps/api/src/modules/discord

### 职责

处理 Discord 集成，包括命令行 (`studio run`) 和 Discord 斜杠命令 (`/studio run`) 共享的命令运行逻辑，以及 Discord 交互端点（按钮点击回调）的路由处理。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `triggerRequirement` | `command-runner.ts` | 提交需求到 #研发 频道并创建 WorkUnit，返回确认消息 |
| `router` | `routes.ts` | Express Router，处理 `/interactions` POST 端点，含 Ed25519 签名验证 |

### 依赖关系

**上游（本目录依赖）：**
- `@dommaker/studio-shared`：提供 `FileStore`、`logger`
- `../channels/channel-message.service.ts`：`getChannelMessageService()`（惰性单例）
- `../workunit/workunit.service.ts`：`WorkUnitService`（#550 起关闭走 `close()` 状态机单口，wu-closure 已删）
- `../../utils/logger.ts`：logger
- `express`、`crypto` 等标准库

**下游（引用本目录）：**
- `apps/api/src/route-registry.ts`：注册本模块提供的路由

### 注意事项

- **worktrees 目录口径（P2-e）**：`progress` 子命令读 `<worktreesDir>/<execId>/.progress.json`，目录解析 `WORKTREES_DIR > studioPath('worktrees')`（契约 §8 双口径收编；progress 文件是 CLI 进程产物，FileStore 不管）。
- 签名验证必须优先于任何业务逻辑，Discord 会通过无效签名请求检测服务器是否验证；SEC-09 起 Ed25519 通过后要求 timestamp 距当前不超过 300s（过去/未来均拒绝），合法 interaction 必须带 id。`discord-interaction:<id>` 在业务日志、WU 写、消息响应前经 core `ReplayGuard` 原子 claim；24h 内已完成重放只回首个缓存响应，processing 无 TTL、重放恒 409，均不重复业务副作用。complete 失败回 503 且不 release；可能部分成功的业务异常缓存错误响应、不自动重试。只有明确零写入路径（progress 只读失败、stop 首个业务写前的 getIndex 失败、未知类型）可 release；确定性校验/业务拒绝按完成记录。业务副作用后、complete 前崩溃会留下 processing，须人工核对实际结果，不能自动恢复执行。
- 必须配置环境变量 `DISCORD_PUBLIC_KEY`，否则交互端点返回 500
- `triggerRequirement` 依赖 `#研发` 频道存在，否则抛出错误
- WorkUnit 创建时 `creationMode` 标记为 `'discord'`，用于区分来源
- **WU 写路径走 service 单口（#538，ADR 2026-09-15 决策 2）**：按钮 retry/retry-new = `unclaim` 回池 + 重试标记（resumeAfterRetry/extraRounds/freshPrompt）经 WorkUnitService `updateMetadata` 语义口锁内合并（#554 起不再直摸 FileStore 原语）；abandon 与 `/studio stop` = `WorkUnitService.close()`（#550 状态机单口，closedBy: human-command，补 closedAt + status_changed + workunit:closed 记录 + 频道出声；decision/spec 无 closed 边 → 状态机抛错拒绝；#555 起路由层区分「not found」与「状态机拒绝/落库失败」，后者回真实原因不再误报 not found）。旧 closeAndEmit/updateWorkUnitStatus 直写原语已删（metadata 整写覆盖、不写 closedAt、不发事件三宗罪），legacy `events:goal-execution` 事件随 Goal 体系退役停发。测试：`__tests__/routes.test.ts`（按钮两路径 + stop 收口）与 `__tests__/routes-stop.test.ts`（stop 委托 agentRunner）
- **契约驱动迁移（2026-10 批次 7/8）**：/interactions 为协议面例外保持原样（express.raw Ed25519 签名优先于一切解析，响应 `{ type, data.content }` 由 Discord 协议定形），出参形状声明在 studio-contract discord.ts。
