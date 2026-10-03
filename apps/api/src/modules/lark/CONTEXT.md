# apps/api/src/modules/lark

### 职责

处理飞书机器人回调事件，包括 URL 验证（首次配置）、卡片按钮点击事件（card.action.trigger）以及其他未处理事件。提供健康检查端点。

### 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `default` (Router) | `routes.ts` | 飞书回调路由，包含 `/callback` 和 `/health` 两个端点 |

### 依赖关系

- 上游：`../../utils/logger.js`（日志工具）、`express`、`crypto`（Node.js内置）
- 下游：`apps/api/src/route-registry.ts`（注册路由）

### 注意事项

- 签名验证使用 HMAC-SHA256，需确保 `LARK_APP_SECRET` 环境变量正确配置
- 飞书回调需返回 `challenge` 字段以通过 URL 验证
- 按钮点击事件中 `action` 从 `event.action.value.action` 或 `event.action.value` 提取
- 已移除会议模块，按钮点击仅记录日志并返回成功
- **验签（2026-08-25 接线）**：/callback 校验 verification token（body.token / header.token，timingSafeEqual），`LARK_VERIFICATION_TOKEN` 未配置时 fail-closed 503；此前 verifyLarkSignature（方案错误且从未调用）已删除。
- **契约驱动迁移（2026-10 批次 7/8）**：GET /health 走 defineRoute 进 `{ data }` 壳（无消费方）；/callback 为协议面例外保持原样（verification token 比对依赖 body 原始键位置，响应 `{ challenge }` / `{ code: 0, msg }` 由飞书协议定形），出参形状声明在 studio-contract lark.ts。
