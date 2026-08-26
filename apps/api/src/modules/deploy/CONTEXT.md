# apps/api/src/modules/deploy

### 职责

Deploy Webhook：GitHub push 事件触发的自动部署入口（触发式部署，替代每分钟轮询的主通道）。仅接受 push 到 `refs/heads/master`，202 立即返回后异步触发部署脚本（幂等可重入，脚本内含方向检查/flock/build/restart/health/rollback）。

### 核心导出

- `webhook.routes.ts` — `deployWebhookRoutes` Router，`POST /webhook` 处理 GitHub push 事件

### 依赖关系

- 上游：`@dommaker/studio-shared`（logger）
- 下游：`route-registry.ts`（挂载 `/api/v1/deploy`）、`app.ts`（`/api/v1/deploy/webhook` 挂 `express.raw` 保留原始 body 供签名校验，同 discord/interactions 先例）

### 注意事项

- **安全**：HMAC-SHA256 校验 `X-Hub-Signature-256`（timing-safe 比较），secret = env `DEPLOY_WEBHOOK_SECRET`；未配置按 503 处理（`DEPLOY_SCRIPT` 同）。HMAC 即认证，`app.ts` 鉴权白名单放行该路径
- **先响应再触发**：部署会重启本进程，必须 202 返回后再 spawn（`detached + unref`）
- **日志**：脚本 stdout/stderr 追加到 env `DEPLOY_LOG`（默认 `/var/log/studio-deploy.log`）——`stdio: 'ignore'` 曾导致 webhook 通道部署零日志（2026-08-09 事故）；`DEPLOY_LOG` 不可写时降级为丢弃并 warn
