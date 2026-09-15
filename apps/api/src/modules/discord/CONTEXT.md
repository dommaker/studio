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
- `../channels/channel-message.service.ts`：`channelMessageService`
- `../workunit/workunit.service.ts`：`WorkUnitService`；`../workunit/wu-closure.ts`：`closeWorkUnitWithNotice`
- `../../utils/logger.ts`：logger
- `express`、`crypto` 等标准库

**下游（引用本目录）：**
- `apps/api/src/route-registry.ts`：注册本模块提供的路由

### 注意事项

- 签名验证必须优先于任何业务逻辑，Discord 会通过无效签名请求检测服务器是否验证
- 必须配置环境变量 `DISCORD_PUBLIC_KEY`，否则交互端点返回 500
- `triggerRequirement` 依赖 `#研发` 频道存在，否则抛出错误
- WorkUnit 创建时 `creationMode` 标记为 `'discord'`，用于区分来源
- **WU 写路径走 service 单口（#538，ADR 2026-09-15 决策 2）**：按钮 retry/retry-new = `unclaim` 回池 + 重试标记（resumeAfterRetry/extraRounds/freshPrompt）经 `updateMetadata` 锁内合并；abandon 与 `/studio stop` = `closeWorkUnitWithNotice`（closedBy: human-command，补 closedAt + workunit:closed 记录 + 频道出声）。旧 closeAndEmit/updateWorkUnitStatus 直写原语已删（metadata 整写覆盖、不写 closedAt、不发事件三宗罪），legacy `events:goal-execution` 事件随 Goal 体系退役停发。测试：`__tests__/routes.test.ts`（按钮两路径 + stop 收口）与 `__tests__/routes-stop.test.ts`（stop 委托 agentRunner）
