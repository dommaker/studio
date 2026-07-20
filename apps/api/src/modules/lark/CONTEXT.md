# lark

> 此文件描述 apps/api/src/modules/lark 目录的职责和上下文

## 职责

处理飞书机器人回调事件，包括 URL 验证（首次配置）、卡片按钮点击事件（card.action.trigger）以及其他未处理事件。提供健康检查端点。

## 核心导出

| 导出 | 文件 | 说明 |
| --- | --- | --- |
| `default` (Router) | `routes.ts` | 飞书回调路由，包含 `/callback` 和 `/health` 两个端点 |

## 依赖关系

- 上游：`../../utils/logger.js`（日志工具）、`express`、`crypto`（Node.js内置）
- 下游：`apps/api/src/route-registry.ts`（注册路由）

## 注意事项

- 签名验证使用 HMAC-SHA256，需确保 `LARK_APP_SECRET` 环境变量正确配置
- 飞书回调需返回 `challenge` 字段以通过 URL 验证
- 按钮点击事件中 `action` 从 `event.action.value.action` 或 `event.action.value` 提取
- 已移除会议模块，按钮点击仅记录日志并返回成功

## 修复历史

<!-- SESSION_SUMMARY_FIXES -->
- ✅ `f80cfeae`: 203 TypeScript 错误全部清零
