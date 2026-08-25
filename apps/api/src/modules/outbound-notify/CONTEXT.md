# apps/api/src/modules/outbound-notify

### 职责

本模块提供基于 Discord 的通知发送服务，支持多种任务与会议相关通知类型。内部封装了对 `discordNotifier` 的调用，并通过 `eventBus` 将通知事件发布到消息总线。还暴露 HTTP 路由供内部模块通过 POST /api/v1/notify/send 触发通知。另提供用户通知渠道配置的保存与状态查询（持久化到 `~/.studio/notify-config.json`，重启自动恢复）：POST /api/v1/notify/config、GET /api/v1/notify/config/status，供 Settings 页同步用户 Webhook 配置并提示"已同步/需重存"。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `NotifyService` | `notify.service.ts` | 通知发送服务类，提供 `send()`、`sendHighRiskNotification()`、`sendMediumRiskNotification()` 方法 |
| `notifyService` | `notify.service.ts` | `NotifyService` 的单例实例 |
| `NotifyMessage` | `notify.service.ts` | 通知消息的类型接口，定义支持的通知类型和字段 |
| `NotifyEvent` | `notify.service.ts` | 通知事件类型（TypeScript 类型导出） |
| `default router` | `routes.ts` | Express 路由器，处理 `/send`、`/config`（POST）、`/config/status`（GET）端点 |

### 依赖关系

**上游**:
- `../../utils/logger`（日志记录）
- `@dommaker/studio-shared`（`eventBus`，发布通知事件到 `notifications` 频道）
- `../../utils/discord-notifier`（Discord 消息发送工具）
- `@dommaker/studio-shared`（路由模块中使用的日志）

**下游**:
- `apps/api/src/route-registry.ts`：注册本模块暴露的路由。

### 注意事项

- `send()` 方法自动将 `components`（旧格式按钮）转换为 Discord 按钮格式；新调用应优先使用 `sendHighRiskNotification` 等方法。
- 高风险会议通知使用 `sendWithConfirmButtons` 生成带确认按钮的Discord消息，中风险使用普通文字通知。
- 路由 POST `/api/v1/notify/send` 要求请求体必须包含 `type`、`title`、`content`，否则返回 400。
- 用户渠道配置（`POST /config`、`GET /config/status`）持久化到 `~/.studio/notify-config.json`，模块加载时自动恢复，服务重启不丢（C5 修复，2026-08-06；此前仅存进程内存，重启即丢、Settings 页提示重新保存）。挂载点为 `/api/v1/notify`（middleware: admin）。
- `notifyService` 为单例，直接经 `eventBus.publish` 发通知事件，无需注入。
- 通知发布到事件总线频道为 `'notifications'`，其他模块可通过订阅该频道消费。
