# discord

> 此文件描述 apps/api/src/modules/discord 目录的职责和上下文

## 职责

处理 Discord 集成，包括命令行 (`studio run`) 和 Discord 斜杠命令 (`/studio run`) 共享的命令运行逻辑，以及 Discord 交互端点（按钮点击回调）的路由处理。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `triggerRequirement` | `command-runner.ts` | 提交需求到 #研发 频道并创建 WorkUnit，返回确认消息 |
| `router` | `routes.ts` | Express Router，处理 `/interactions` POST 端点，含 Ed25519 签名验证 |

## 依赖关系

**上游（本目录依赖）：**
- `@dommaker/studio-shared`：提供 `FileStore`、`WorkUnitSnapshot`、`logger`
- `../channels/channel-message.service.ts`：`channelMessageService`
- `../workunit/workunit.service.ts`：`WorkUnitService`
- `../../utils/logger.ts`：logger
- `../../core/event-store.ts`：`eventStore`
- `express`、`crypto` 等标准库

**下游（引用本目录）：**
- `apps/api/src/route-registry.ts`：注册本模块提供的路由

## 注意事项

- 签名验证必须优先于任何业务逻辑，Discord 会通过无效签名请求检测服务器是否验证
- 必须配置环境变量 `DISCORD_PUBLIC_KEY`，否则交互端点返回 500
- `triggerRequirement` 依赖 `#研发` 频道存在，否则抛出错误
- WorkUnit 创建时 `creationMode` 标记为 `'discord'`，用于区分来源

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `126982df`: channels): update stale @Analyst comment in command-runner
- ✅ `f80cfeae`: 203 TypeScript 错误全部清零
- ✅ `a88bccd6`: tsc-gate surgical baseline update + fix 13 pre-existing TS errors
