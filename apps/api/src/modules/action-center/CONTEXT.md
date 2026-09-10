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
- **D-2 reply 深链锚点 `messageId`**（additive 字段，仅 reply 项携带）：waitingForInput metadata 不记消息 id，派生口径 = 该 WU 频道线程**最新一条非人类消息**（`fileStore.queryMessages(channelId, { workUnitId })` 热层过滤 `authorType !== 'human'`），与频道页 NEED_INPUT chip「当前提问消息」（#279 走查 F4）同口径——提问消息形态不统一（agent-loop「需要输入:」/ 归属提问 / 裁决轮卡），不按时效/文案再过滤。fail-closed：无 channelId / 无匹配消息 / 查询失败 → 字段缺省，前端回退纯频道跳转。已知边界：挂起期间若发过超时提醒里程碑，锚点指向提醒而非提问本体（与 chip 口径一致，刻意保持 parity）。
- 通知持久面的写入方不在本模块：`wu-messenger.ts`（milestone 双写）、`utils/notifier.ts`（monitor_alert sink）、`agents/triage/incident-notification.ts`（incident.created/escalated）。
