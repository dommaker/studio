# apps/api/src/modules/outbound-notify

### 职责

本模块提供基于 Discord 的通知发送服务，支持任务类通知类型（task-failed / timeout / crash / zombie / human-needed / user-intervention-needed）。内部封装了对 `discordNotifier` 的调用。还暴露 HTTP 路由供内部模块通过 POST /api/v1/notify/send 触发通知。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `NotifyService` | `notify.service.ts` | 通知发送服务类，提供 `send()` 方法 |
| `notifyService` | `notify.service.ts` | `NotifyService` 的单例实例 |
| `NotifyMessage` | `notify.service.ts` | 通知消息的类型接口，定义支持的通知类型和字段 |
| `default router` | `routes.ts` | Express 路由器，处理 `/send` 端点 |

### 依赖关系

**上游**:
- `../../utils/logger`（日志记录）
- `../../utils/discord-notifier`（Discord 消息发送工具）
- `@dommaker/studio-shared`（路由模块中使用的日志）

**下游**:
- `apps/api/src/route-registry.ts`：注册本模块暴露的路由。

### 注意事项

- `send()` 方法自动将 `components`（旧格式按钮）转换为 Discord 按钮格式。
- 路由 POST `/api/v1/notify/send` 要求请求体必须包含 `type`、`title`、`content`（zod 校验，含 type/priority 词表——契约驱动迁移 2026-10 批次 5/7：词表外值由透传收紧为 400，无消费方收紧安全），否则返回 400。挂载点为 `/api/v1/notify`（middleware: admin）。响应统一 `{ data: { success, message } }` 壳（原平铺进壳）；契约正本 = `packages/studio-contract/src/outbound-notify.ts`
- 用户渠道配置端点（`POST /config`、`GET /config/status`）已于 #434（2026-09-02）删除：配置落盘 `~/.studio/notify-config.json` 后无任何发送方消费（真实通路走 env/外部配置），随设置页死配置清理一并移除。
- 会议相关死面已随架构精简刀6删除（2026-10-08）：meeting-* 四个通知类型（Meeting 模块残骸）、sendHighRisk/Medium/LowRiskNotification 三方法（零调用方）、eventBus `notifications` 死发布点（0 订阅者）、discord-notifier 的 sendWithConfirmButtons（唯一调用方即上述方法；按钮恢复如需要应接 review-proposal 正本链路，另行起票）。
