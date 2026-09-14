# apps/api/src/modules/notify-channels

### 职责

通知渠道配置（#525 P2-6，决策 #516 项⑦⑧）：服务端配置存储 + 读写 API + ClawBot（iLink 协议）内嵌轻量直连。/settings「通知渠道」配置区的服务端支撑——#434 死配置的「复活成真功能」版：配置有真实消费方（notifyAlert 告警/催办外推 fan-out，见 utils/notifier.ts）。

### 核心导出

- `config-store.ts` — `~/.studio/notify-channels.json` 读写（仿 project-exclude-config：load 失败降级空、写前 mkdir -p）；`resolveWeComWebhookUrl()` 是企微 URL 唯一解析口（配置存储优先、env `WECOM_WEBHOOK_URL` 兜底作部署默认，带 source）
- `clawbot-client.ts` — iLink 协议三端点：`getBotQrcode` / `getQrcodeStatus` / `sendText`（fetch 可注入，10s 超时，body errcode 透传抛错）
- `wecom-client.ts` — 企微群机器人 markdown 发送唯一出口 `postWeComMarkdown`（5s 超时；非 2xx 不抛返回 status，网络/超时错误抛出），notifier 告警 sink 与 `/wecom/test` 共用
- `routes.ts` — `GET /`（状态，URL/密钥掩码展示）/ `PUT /wecom`（空串清除，须 `https://qyapi.weixin.qq.com/` 开头）/ `POST /wecom/test` / `POST /clawbot/bind/start` / `GET /clawbot/bind/status`（confirmed 时凭据持久化）/ `POST /clawbot/unbind` / `POST /clawbot/test`

### 依赖关系

- 上游：utils/notifier.ts（企微 sink 改走 resolveWeComWebhookUrl；fan-out 第 4 个 sink = ClawBot，已绑定才发）
- 下游：apps/web /settings「通知渠道」配置区（api/notifyChannels.ts）；route-registry 挂 `/api/v1/notify-channels`（admin）

### 注意事项

- **ClawBot 能力约束（公开协议拆解，未真机验证）**：接入域 `ilinkai.weixin.qq.com`，纯 HTTP/JSON 无需 OpenClaw 网关；主动推送受限——用户最后一条消息后 24h 内最多 10 条（context_token 可留空）；仅文本；errcode=-14 = 会话过期需重新扫码绑定。字段名/状态词表（wait/scaned/confirmed）来自协议拆解文档，实机有出入时改动面集中在 clawbot-client.ts 映射层
- **企微测试消息的局限**：`POST /wecom/test` 只判 HTTP 2xx，不解析企微业务体 errcode（与 notifier 现有口径一致）——失效 key 也回 200，「测试成功」≠ key 有效
- **掩码口径**：`maskValue`（length<=8 → `****`，否则 first4...last4）与 CLI config.ts 同款；响应永不出现完整 webhookUrl/botToken
