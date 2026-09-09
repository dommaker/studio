# apps/api/src/modules/action-center

### 职责

统一行动中心（#468）：一个端点回答「现在需要我做什么」。`GET /api/v1/action-center`（requireAuth + requireNotGuest）返回三段：`stateItems`（状态派生：reply=blocked+waitingForInput / review=in_review∩MANUAL_GATE_TYPES / confirm=pending，无已读概念、状态变即消）+ `notifications`（NotificationService 持久面）+ `unreadCount`。

### 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `ActionCenterService`, `ActionCenterStateItem`, `ActionCenterPayload` | `action-center.service.ts` | stateItems 派生 + 通知合并，无新存储 |
| `actionCenterRoutes` | `routes.ts` | 挂载于 route-registry `/api/v1/action-center`（middleware: auth） |

### 依赖关系

上游：`../workunit/workunit.service.js`（list 状态过滤）、`../workunit/workunit.types.js`（MANUAL_GATE_TYPES）、`../workunit/wu-metadata.js`（parseWuMetadata/parseWuTitle）、`@dommaker/studio-notification`。
下游：前端 `apps/web/src/stores/notificationStore.ts`（行动中心唯一数据源）。

### 注意事项

- 状态派生项**不做已读/dismiss**（状态机即真相，dismiss 会撒谎——设计稿 §4 明确不做）。
- reply 口径**不排除 decision/spec**（设计稿决策：排除规则改为面板分区解决），与 chip 旧口径刻意不同。
- 通知持久面的写入方不在本模块：`wu-messenger.ts`（milestone 双写）、`utils/notifier.ts`（monitor_alert sink）、`agents/triage/incident-notification.ts`（incident.created/escalated）。
