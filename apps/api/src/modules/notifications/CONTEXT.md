# apps/api/src/modules/notifications

### 职责

通知域（#682 合一：原 notifications + notify-channels + outbound-notify + utils/notifier + utils/discord-notifier 六个面并为单模块，utils→modules 反向依赖消除），三层结构：

- **service 层**：`notification-service.ts`（站内通知 NotificationService，JSONL 持久化，#684 自 packages/studio-notification 下沉）；`alert-notifier.ts`（notifyAlert 告警统一出口，四 sink fan-out，自 utils/notifier.ts 并入）；`discord-notifier.ts`（Discord 直发客户端 + 单例，自 utils/discord-notifier.ts 并入）；`outbound-notify.service.ts`（Discord 出站 NotifyService，旧 components 按钮格式转换）。
- **routes 层**：`routes.ts`（/api/v1/notifications 站内通知五端点）；`outbound-notify.routes.ts`（POST /api/v1/notify/send，admin）；`channels/routes.ts`（/api/v1/notify-channels 渠道配置七端点，admin）。
- **channels 层**（`channels/`）：`config-store.ts`（`~/.studio/notify-channels.json` 配置存储 + `resolveWeComWebhookUrl` 唯一解析口，配置存储优先、env `WECOM_WEBHOOK_URL` 兜底）；`clawbot-client.ts`（ClawBot iLink 协议三端点：取码/轮询/sendText）；`wecom-client.ts`（企微群机器人 markdown 发送唯一出口 `postWeComMarkdown`）。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `NotificationService` / `getNotificationService` / `toNotificationWire` / `CreateNotificationInput` | `notification-service.ts` | 通知服务类（创建/查询/标记，写 `~/.studio/logs/notifications.jsonl`）；`toNotificationWire` 把内存 Date 归一为 ISO/null 供 notifications 与 action-center 共用；`getNotificationService` 为进程级单例入口（#684，createLazyService 首次调用时才取 getStore()；测试自行 `new NotificationService(显式 store)`） |
| `notifyAlert` / `AlertLevel` / `NotifyAlertOptions` | `alert-notifier.ts` | 告警统一出口，fire-and-forget fan-out 四 sink（告警频道系统消息 / 企微 webhook / 行动中心持久化 / ClawBot），sink 失败仅 warn 不抛 |
| `DiscordNotifier` / `discordNotifier` / `sendDiscordNotification` / `DiscordMessageOptions` | `discord-notifier.ts` | Discord API 直发（token 读 openclaw 配置，频道 env DISCORD_CHANNEL_ID；curl 代理兜底；错误日志不落明文 token） |
| `notificationRoutes` | `routes.ts` | Express 路由器，注册 /api/v1/notifications 下的五个端点（route-registry 深路径挂载） |

渠道内部件（channels/*）与出站 service/routes 不跨模块消费，不进 index.ts 公共面。

### 依赖关系

上游依赖：
- `@dommaker/studio-shared`（FileStore, logger, foldJsonlById）
- `../../utils/services.js`（createLazyService）、`../../core/store.js`（getStore）
- `../channels/index.js`——**无**（Phase 5 SCC 第一刀 #2，2026-10-16）：alert-notifier 频道 sink 改走装配期注入的 `AlertChannelPoster`（注册口在本模块，bootstrap/module-sinks.ts 注 channels 的 createAgentMessage 实现），notifications→channels 模块边消除。**未注册语义：warn 一次 + 跳过该 sink**（与「无可用告警频道」同级口径）

下游依赖：
- `apps/api/src/route-registry.ts`（深路径挂载三套路由：notifications / notify/send / notify-channels）
- `apps/api/src/bootstrap/tunnel.ts`（discordNotifier 隧道 URL 通知）
- 跨模块消费方（经本模块 index.ts 公共面）：action-center、workunit（wu-messenger/gate-escalation）、agent-auditor、agent-loop（daily-token-budget）、ops（monitor-alerts/monitor-reports，#683 起 monitor 并入 ops）、agent-knowledge（knowledge-cold-start）、skills（skill-extraction）、pmo/delivery-notify、triage/incident-notification

### 注意事项

- **notifyAlert fan-out 口径**：告警频道解析 env STUDIO_ALERT_CHANNEL_ID → 名为「系统」/system 的频道 → 跳过并 warn；warning/critical 带 atHuman（响铃）且落 NotificationService（type=monitor_alert，全用户），info 只实时上屏不持久化（防刷屏）；企微/ClawBot 文本同格式 `[LEVEL] **title**\nbody`。
- **企微 URL 解析**（#525 P2-6）：配置存储优先、env 兜底（`resolveWeComWebhookUrl` 带 source）；`POST /wecom/test` 只判 HTTP 2xx 不解析业务 errcode——「测试成功」≠ key 有效。
- **ClawBot 能力约束（公开协议拆解，未真机验证）**：接入域 `ilinkai.weixin.qq.com`；主动推送受限——用户最后一条消息后 24h 内最多 10 条；仅文本；errcode=-14 = 会话过期需重新扫码绑定。
- **渠道配置掩码口径**：`maskValue`（length<=8 → `****`，否则 first4...last4）与 CLI config.ts 同款；响应永不出现完整 webhookUrl/botToken/ilinkUserId。
- **fs 直写保留理由（P2-e 登记）**：`channels/config-store.ts` 持久化根级 `notify-channels.json`（用户配置面，契约 §2② 登记；studioPath 拼接），同步读写自持 store，不收 FileStore。SEC-07 起配置目录强制 0700、文件 0600，写后 `fchmod`，读取时修复历史宽松权限；umask 022 回归在 `channels/__tests__/config-store.test.ts`。
- **discord-notifier 测试隔离**：NODE_ENV=test 且未显式设 OPENCLAW_CONFIG_PATH 时不读用户真实 openclaw 配置（防生产凭证进测试进程）。
- 通知服务通过 `createLazyService` 延迟初始化，底层依赖 `FileStore` 存储
- `CreateNotificationInput` 的 `type` 为 `review_request | review_approved | review_rejected | system | auditor_suggestion | wu_milestone | monitor_alert | incident | gate_reminder`（wu_milestone/monitor_alert/incident 为 #468 行动中心追加，gate_reminder 为 #523 人闸催办/认领滞留 tier1 提醒）；数据行可选 `wuId/channelId` 结构化直链字段，查询透出（无则 null）。
- #468：`createForAllUsers(input)` 把「遍历全用户写入」从 auditor-execution 的 readdir 先例收敛为服务方法（data/users/*.json 文件名，截顶 10，目录缺失返回 0 不抛错）；studio 事实单用户，多用户精确归属另票。
- 当前态投影（PERF-05，2026-11-02）：`notification-projection.ts` 以 notifications.jsonl 为唯一真源，按 `dev/ino/offset` 增量恢复；小 `logs/projections/notifications/manifest.json` 只存提交 head/接收者键，per-entry 存墓碑折叠态，per-recipient 文件存 items+unreadCount。`getUserNotificationView` 只读目标接收者，`getUnreadCount` 直读持久化 count、不构造/排序列表；已知 recipient 文件损坏/丢失仅从真源定向重建该接收者，未知接收者不扫历史。entry→recipient→manifest 分文件提交后的崩溃重放以 recipient 实际已应用项做幂等增减，entry 仅作数据/首墓碑兜底。create/mark 读写在 `notifications.jsonl.lock` 内 append 后推进投影。墓碑语义不变：已读保留可见、首墓碑定 readAt、孤儿墓碑不可见。PERF-07 起同接收者并发 view 经 `recipientFlights` 合并为一次锁内 sync/readRecipient，消除 HTTP 读惊群；各调用方仍独立映射/排序/分页，写路径锁语义不变。稳态 sync 先只读 JSONL 末字节，完整换行即直接采用文件 size，只有末尾半行才倒扫 tail，避免每次 HTTP 查询重复读取 64KB。`loadRecipient` 将本次 sync 的可信 manifest 传给 `readRecipient`，未知接收者零额外文件打开；未传 manifest 时保留既有 recipient 优先恢复语义，已知接收者损坏/缺失仍定向重建。
- 批量已读（PERF-05）：`POST /read` 收 `{ids}`，`markManyAsRead` 一次投影同步/归属过滤后调用 FileStore `appendJsonlBatch` 单句柄写墓碑；他人/不存在/已读 id 不写，纯越权零真源副作用。前端 `markChannelRead` 只发一次批量请求，不再逐条 POST。
- **契约驱动迁移（2026-10 批次 5/7）**：三组路由均 defineRoute 化——响应统一 `{ data }` 壳（`{ success, data }` 壳的 success 标志退役），错误统一 `{ error: { code, message } }`（502 上游失败 code = BAD_GATEWAY、errcode 透传保留）；契约正本 = `packages/studio-contract/src/notifications.ts` / `notify-channels.ts` / `outbound-notify.ts`。
- 未读通知限制获取 50 条，可通过 `unreadOnly` 查询参数控制
- **鉴权（P2-e 声明式统一）**：/api/v1/notifications 全端点姿态 = requireAuth+requireNotGuest；/api/v1/notify 与 /api/v1/notify-channels 整挂 admin；统一挂 route-registry entry，路由内不再挂载。
- 用户渠道配置端点（`POST /config`、`GET /config/status`）已于 #434（2026-09-02）删除：配置落盘 `~/.studio/notify-config.json` 后无任何发送方消费（真实通路走 env/外部配置），随设置页死配置清理一并移除。
- 会议相关死面已随架构精简刀6删除（2026-10-08）：meeting-* 四个通知类型（Meeting 模块残骸）、sendHighRisk/Medium/LowRiskNotification 三方法（零调用方）、eventBus `notifications` 死发布点（0 订阅者）、discord-notifier 的 sendWithConfirmButtons（唯一调用方即上述方法；按钮恢复如需要应接 review-proposal 正本链路，另行起票）。
