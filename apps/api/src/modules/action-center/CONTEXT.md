# apps/api/src/modules/action-center

### 职责

统一行动中心（#468）：一个端点回答「现在需要我做什么」。`GET /api/v1/action-center`（requireAuth + requireNotGuest）返回三段：`stateItems`（状态派生：reply=blocked+waitingForInput / review=in_review∩MANUAL_GATE_TYPES / confirm=pending，无已读概念、状态变即消）+ `notifications`（NotificationService 持久面）+ `unreadCount`。

### 核心导出

| 导出 | 文件 | 说明 |
|------|------|------|
| `ActionCenterService`, `ActionCenterStateItem`, `ActionCenterPayload` | `action-center.service.ts` | stateItems 派生 + 通知合并；PERF-05 起 notifications+unreadCount 取 NotificationService 同一份 view，不重复 fold |
| `actionCenterRoutes` | `routes.ts` | 挂载于 route-registry `/api/v1/action-center`（middleware: auth）。契约驱动迁移（2026-10 批次 4/7）：defineRoute 化——响应统一 `{ data }` 壳（原平铺裸 payload），契约正本 = `packages/studio-contract/src/action-center.ts`（ActionCenterStateItem 等实体 z.infer alias，schema 即正本） |

### 依赖关系

上游：`../workunit/index.js`（status 过滤 getIndex + snapshotToData、MANUAL_GATE_TYPES、parseWuMetadata/parseWuTitle）、`../notifications/index.js`（NotificationService，#684 包下沉）。
下游：前端 `apps/web/src/stores/notificationStore.ts`（行动中心唯一数据源）。

### 注意事项

- **鉴权（P2-e 声明式统一）**：route-registry 挂 authNotGuest（requireAuth+requireNotGuest），路由内不再挂载；身份取 req.user.id。

- 状态派生项**不做已读/dismiss**（状态机即真相，dismiss 会撒谎——设计稿 §4 明确不做）。
- reply 口径**不排除 decision/spec**（设计稿决策：排除规则改为面板分区解决），与 chip 旧口径刻意不同。
- **D-2 reply 深链锚点 `messageId`**（additive 字段，仅 reply 项携带）：waitingForInput metadata 不记消息 id，派生口径 = 该 WU 频道线程**最新一条非人类消息**（**B2（2026-09-27）起** `fileStore.readMessagesTail(channelId, { limit: 1, match: workUnitId 相等 + authorType!=='human' })` 谓词倒扫——倒扫序 = 新→旧，首个命中即最新，同 message-routing resolveMergeTarget 的 #524 P1-1 先例；原为 `queryMessages` 无 limit 全热文件串行扫）。**#533 起为「WU 当前提问消息」唯一派生点**：频道页回复区/提升/chip 定位全消费本字段，前端 latestQuestionIdByWu 反推已删（注释对齐退休）——提问消息形态不统一（agent-loop「需要输入:」/ 归属提问 / 裁决轮卡），不按时效/文案再过滤。fail-closed：无 channelId / 无匹配消息 / 查询失败 → 字段缺省，前端各消费方 fail-closed（不拼 ?highlight= / 不挂回复区 / 定位 toast 反馈）。已知边界：挂起期间若发过超时提醒里程碑，锚点指向提醒而非提问本体（前后端同口径因此天然 parity）。
- **PERF-07 读路径**：blocked/in_review/pending 经一次 `getIndex({statuses:[...]})` 下推过滤，每次派生只做一次 index mtime/cache 校验，底层读穿 miss single-flight 共享，只克隆三类 actionable 行并分组排序；不做未过滤全量或 per-WU 聚合读取。reply 锚点按 `wuId:channelId` 缓存，先以 `getChannelVersion().lastMessageId` 校验，同版本不重复全尾扫，版本推进自动重扫。缓存为 64 项 LRU，非 waiting 键在每次派生时清理，容量只影响重扫成本、不影响 stateItems 正确性。通知读取 single-flight 在 NotificationService 内，不改变响应、接收者隔离或 fail-closed 语义。
- 通知持久面的写入方不在本模块：`wu-messenger.ts`（milestone 双写）、`notifications/alert-notifier.ts`（monitor_alert sink）、`agents/triage/incident-notification.ts`（incident.created/escalated）。
