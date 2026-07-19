# src

> 此文件描述 packages/studio-notification/src 目录的职责和上下文

## 职责

本目录提供 studio-notification 包的核心代码，包含通知的创建、查询、标记和 CLI 操作。CLI 部分提供模拟通知的发送、列表、标记功能，服务层基于 FileStore 实现持久化通知管理。

## 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `Notification`, `SendOptions`, `ListOptions`, `MarkOptions` | `types.ts` | 通知与 CLI 选项的类型定义 |
| `runSend`, `runList`, `runMark` | `cli/send.ts`, `cli/list.ts`, `cli/mark.ts` | CLI 命令实现（基于 Mock 数据） |
| `NotificationService`, `notificationService`, `CreateNotificationInput` | `services/notification-service.ts` | 通知服务类，支持创建、查询、标记（基于文件存储） |
| 全部导出 | `index.ts` | 导出 `services`、`types`、`cli` 的所有内容 |

## 依赖关系

上游：依赖 `@dommaker/studio-shared`（FileStore, logger）、`node:path`、`node:os`。
下游：被 `apps/api` 模块引用，具体文件：`apps/api/src/modules/agents/auditor-execution.ts`、`apps/api/src/modules/notifications/routes.ts`、`apps/api/src/modules/spec-reviews/spec-review.service.ts`。

## 注意事项

- CLI 模块（`cli/`）使用硬编码的 Mock 数据（用户、通知），仅用于演示或测试，生产环境中应替换为真实数据源。
- 服务层 `NotificationService` 使用 JSONL 文件存储，路径固定为 `~/.studio/logs/notifications.jsonl`，注意文件锁和并发写入问题。
- `types.ts` 中的 CLI 选项类型与 `notification-service.ts` 中的 `CreateNotificationInput` 结构不同，不要混用。
- `CreateNotificationInput` 的 `type` 为 `review_request | review_approved | review_rejected | system | auditor_suggestion`，与 CLI 的 `info | warning | alert` 不同，需根据使用场景选择。
