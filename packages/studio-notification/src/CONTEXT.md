# src

> 此文件描述 packages/studio-notification/src 目录的职责和上下文

## 职责

本目录提供 studio-notification 包的核心代码，包含通知的创建、查询、标记，服务层基于 FileStore 实现持久化通知管理。

## 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `NotificationService`, `notificationService`, `CreateNotificationInput` | `services/notification-service.ts` | 通知服务类，支持创建、查询、标记（基于文件存储） |
| 全部导出 | `index.ts` | 导出 `services` 的所有内容 |

## 依赖关系

上游：依赖 `@dommaker/studio-shared`（FileStore, logger）、`node:path`、`node:os`。
下游：被 `apps/api` 模块引用，具体文件：`apps/api/src/modules/agents/auditor-execution.ts`、`apps/api/src/modules/notifications/routes.ts`。

## 注意事项

- 服务层 `NotificationService` 使用 JSONL 文件存储，路径固定为 `~/.studio/logs/notifications.jsonl`，注意文件锁和并发写入问题。
- `CreateNotificationInput` 的 `type` 为 `review_request | review_approved | review_rejected | system | auditor_suggestion`。
