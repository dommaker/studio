# apps/api/src/modules/deploy

### 职责

Deploy Webhook：GitHub push 事件触发的自动部署入口（触发式部署，替代每分钟轮询的主通道）。仅接受 push 到 `refs/heads/master`，detached spawn + 台账 complete 后回 202，不等待部署脚本结束（脚本幂等可重入，内含方向检查/flock/build/restart/health/rollback）。

### 核心导出

- `webhook.routes.ts` — `deployWebhookRoutes` Router，`POST /webhook` 处理 GitHub push 事件

### 依赖关系

- 上游：`@dommaker/studio-shared`（logger）
- 下游：`route-registry.ts`（挂载 `/api/v1/deploy`）、`app.ts`（`/api/v1/deploy/webhook` 挂 `express.raw` 保留原始 body 供签名校验，同 discord/interactions 先例）

### 注意事项

- **安全**：HMAC-SHA256 校验 `X-Hub-Signature-256`（timing-safe 比较），secret = env `DEPLOY_WEBHOOK_SECRET`；未配置按 503 处理（`DEPLOY_SCRIPT` 同）。HMAC 即认证，`app.ts` 鉴权白名单放行该路径。SEC-09 起 master push 必须带 `X-GitHub-Delivery` 与合法非零 `after` commit；`deploy-delivery:<id>` + `deploy-commit:<sha>` 经 core `ReplayGuard` 同锁原子 claim。delivery 完成记录 24h，commit 完成记录永久；重复均 202 ignored，不写部署日志、不 spawn。同步 spawn 失败证明未启动部署，可 release；spawn 后 complete 失败回 503 并保留 processing，后续不得重试。processing 无 TTL；spawn 后、complete 前崩溃同样保留 processing，须人工核对实际部署状态后处理台账。
- **触发与响应**：`detached + unref` spawn 后立即 complete 台账，成功才回 202；不等待部署脚本结束，脚本仍负责异步 build/restart/health/rollback。
- **日志**：脚本 stdout/stderr 追加到 env `DEPLOY_LOG`（默认 `/var/log/studio-deploy.log`）——`stdio: 'ignore'` 曾导致 webhook 通道部署零日志（2026-08-09 事故）；`DEPLOY_LOG` 不可写时降级为丢弃并 warn
- **契约驱动迁移（2026-10 批次 7/8）**：/webhook 为协议面例外保持原样（express.raw HMAC-SHA256，202 机器串约定），出参形状（`{ accepted }` / `{ ignored }` / `{ error }`）声明在 studio-contract deploy.ts。
