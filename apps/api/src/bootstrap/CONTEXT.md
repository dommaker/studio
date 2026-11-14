# apps/api/src/bootstrap

### 职责

启动编排（P2-a，docs/plans/2026-09-arch-refactor.md）：原 `apps/api/src/index.ts`（590 行）按职责拆出的启动步骤集合，`index.ts`（本目录）只做装配，`apps/api/src/index.ts` 只剩 KNOWLEDGE_DIR 钉值 + 调 `bootstrap()`。目标架构（docs/architecture/target-architecture.md）：`bootstrap/` 按域一个文件。

### 核心导出

- `index.ts` — `bootstrap()` 装配入口；catch 兜底 = 拒启（logger.error + process.exit(1)）。P2-b 起首步为 `initConfig()` → `initStore()`（钉定进程级 FileStore，必须先于迁移等一切 store 消费，见 `../core/CONTEXT.md`）；ARCH-06 起随后 `registerKnowledgeAdapters()`，再经 `registerModuleSinks()` 注入跨模块 sink，均在路由流量前完成。2026-10-03 起 listen 前移到 registerRoutes 之后（见「注意事项」）
- `knowledge.ts` — ARCH-06 Knowledge 显式组合根：启动时注册 review adapter，保证重启后存量 pending knowledge 提案可审批；导入 `knowledge-service.ts` 不再隐式注册，重复调用仍沿用注册表后者生效语义。
- `config.ts` — `initConfig()`（PORT/HOST 解析 → warnIfNonProdUsesProdRoot → loadConfig 注入 STUDIO_CONFIG_DIR .env）+ `getPort()/getHost()`
- `migrations.ts` — `runDataMigrations()`（数据区 schema 迁移，失败抛 MigrationError = 拒启）+ `reconcileWorkUnitIndex()`（#170 启动对账，失败不阻断）
- `seed.ts` — `seedBuiltinSkillsStep()`（#223 内置 skill 播种，best-effort）
- `soft-steps.ts` — 「失败只 log 不拒启」纪律唯一固化点（#686）：`runSoftSteps`（顺序执行，单项失败只 warn 不阻断）+ `mountSoftSteps`（fire-and-forget，加载/挂载失败只 warn）；bridges/services/handlers/warmup 四处装配表共用，新增步骤 = 对应表加一行
- `warmup.ts` — `startWarmupTasks()`（冷启动异步任务表：GAP-16/RKB/SessionSummary/#173/#213/#327/G-002/G-003/P1b；P2-c 起同一 barrel 的多次动态 import 合并为单次——少一次重复模块求值，并消除 vitest 同模块并发动态 import 的 mock 竞态）+ `startPostRoutesWarmup()`（AS-020 本地 workspace 注册；§9.5 members 迁移已随 #696 验收退役）；#686 起两表走 mountSoftSteps 单循环
- `services.ts` — `startCoreServices()`（CORE_SERVICES 表走 runSoftSteps：monitor → auditor → RequirementRollup → PmoProgressRollup → OpsService → WorkUnitMergeRecovery → ExternalReplyRecovery → EvolutionScheduler；#686 起 monitor/auditor 裸 start 一并纳入软启动纪律；#704 启动扫描 queued/running、merged+not-run、passed 未 settle 及 done 后未清理现场并续跑；#708 起由持久 merge Effect/Receipt 驱动恢复，旧 metadata 仅懒补建意图；#709 同链恢复 external-reply Effect）
- `bridges.ts` — `initEventSubscriptions()`（EVENT_SUBSCRIPTIONS 表走 runSoftSteps：ReviewDispatcher → DistillLoop 共 12 项 workunit.status_changed 等事件订阅，单项失败不阻断）
- `agent-loop.ts` — `startAgentLoops()`（AS-026：内置角色幂等创建 → provider 回填 → scheduler.start → 注册系统触发器（standby 跳过）→ bridges → 挂载 loop → assignee 自检）+ `sweepEmptyAgentDirs()`（#363）
- `channels.ts` — `initChannels()`（ensureDefaultChannels，Goal 管线需要）
- `handlers.ts` — `registerScanHandlers()`（SCAN_HANDLERS 表 5 个周期扫描 handler + evolution-scan；dispatch-reconciliation 除派工/评审对账外，#704 起同轮恢复持久 merge intent，#708 起实际执行统一走 merge Effect 恢复口，#709 起同轮恢复外部回复；2026-10-03 C 批起失败只 warn 不拒启，#686 起纪律经 runSoftSteps 固化）
- `readiness.ts` — 进程级 readiness 状态（`markReady()/isReady()/readyTimestamp()`，`resetReadiness()` 供测试）：listen 前移后「端口可服务 ≠ 全量就绪」，bootstrap 初始化链尾 markReady()，`app.ts` 的 `/readyz` 据此 200/503；deploy 健康检查以 /readyz 为准（/health 仅 liveness）
- `module-sinks.ts` — `registerModuleSinks()`：装配期依赖倒置注入点（auth/notifications/review-proposal + ARCH-02 WorkUnit + ARCH-04 ProjectReadPort），bootstrap() 里挂 registerRoutes 之前。
- `project-read-sinks.ts` — ARCH-04 项目读口生产组合步骤：把 PMO `projectRead` 注入 Requirements 持有的 `ProjectReadPort`；Requirements 不再依赖 PMO barrel/service，未装配读口 fail-fast。
- `workunit-sinks.ts` — ARCH-02 WorkUnit 端口生产组合步骤：把 channels/audit-logs/Requirements/PMO/core verification/AgentLoop/Agents/Ops 实现注入 `workunit-ports.ts`，删除 WorkUnit 上向出边及动态 import；#701 起 review 端口另装配 PMO `validatePlanConfirm`/`PlanTaskLegError`，供 plan 确认闸在 reviewPassed 前校验唯一交付腿；#709 起带 workUnitId 的 agent 消息接 ExternalReplyService，无 WU 消息保持原始发送；测试 setup 只注册轻量 loader，首次实际取端口时才复用本步骤，避免非 WorkUnit 用例提前求值完整生产模块图。
- `tunnel.ts` — `startTunnelIfEnabled()` / `stopTunnel()`（cloudflared 守护，#571 默认关）
- `cloudflared.ts` — `isCloudflaredEnabled()`（#571 冲突 5：仅 CLOUDFLARED_ENABLED=true 拉起隧道；2026-10-16 批次 F 自 utils/ 归位，唯一消费方 tunnel.ts）
- `runtime-paths.ts` — `defaultKnowledgeDir()` / `tunnelUrlFile()`（#571：KNOWLEDGE_DIR/TUNNEL_URL_FILE 归数据根；批次 F 自 utils/ 归位，消费方 = 根 index.ts + cli/server.ts + cli/run-web.ts + tunnel.ts）
- `studio-events-rotation.ts` — `rotateStudioEvents()`（#173 事件保留轮转：信号热 30 天→月 gzip 冷包，噪声 7 天滚删；批次 F 自 utils/ 归位，warmup 动态 import）
- `studio-log-rotation.ts` — `rotateJsonlLog()` / `rotateStudioLogFiles()` / `archiveLegacyStudioLogs()`（#213 泛化 jsonl 保留轮转 + 遗留归档清理；批次 F 自 utils/ 归位，warmup 动态 import + triage 测试直引）
- `listen-error.ts` — `handleServerListenError()`（#573 EADDRINUSE 竞态拒启；批次 F 自 utils/ 归位，唯一消费方 lifecycle.ts）
- `lifecycle.ts` — `createHttpServer()` / `installErrorHandlers()` / `listen()`（#573 EADDRINUSE 拒启）/ `registerShutdown()`（优雅关闭逆序清理）

### 依赖关系

- 上游：`../app.js`（app + registerRoutes）、`@dommaker/studio-shared`（logger/FileStore/migrations/bootstrapHarness）、各业务模块（动态 import 为主，与原 index.ts 同）
- 下游：`apps/api/src/index.ts`（唯一 bootstrap() 调用方）；`cli/server.ts` / `cli/run-web.ts`（直引 `runtime-paths.js`/`listen-host` 经 `../cli/` 反向——批次 F 起启动口径件跨 cli/bootstrap 两目录互引，均属启动链）

### 注意事项

- **顺序即语义**：装配顺序改动须同步 `__tests__/index.test.ts` 的顺序断言。关键约束：迁移必须先于 reconcile（迁移后布局才是对账正本）；warmup 分 registerRoutes 前/后两段；bridges 调用点固定在 trigger 注册之后、loop 挂载之前（standby 实例也保留事件订阅）
- **listen 前移（2026-10-03 冷启动修复）**：`listen`/`installErrorHandlers`/tunnel/shutdown 排在 registerRoutes 之后、startCoreServices 等后台初始化之前——「端口可服务」与「全量就绪」两口径分离（背景与复测数字见 docs/architecture/performance-baseline.md §7）。诱因：启动链上两处同步 `execFileSync` CLI 全扫（workspaces 重扫 + default-provider backfill）阻塞事件循环实测 ≈9s；同批修复 = CLI 扫描异步化（`cli-scanner.scanAllProvidersAsync`，sync 版只留 CLI 一次性检查）。listen 后到达的请求可能早于后台服务就绪
- **readiness 出口（2026-10-03 根因修复 B/C 批）**：两口径分离的对外承载 = `/readyz`（readiness.ts，`bootstrap()` 链尾 markReady() 后 200，此前 503）——deploy 健康检查以它为准（studio-config 的 deploy-quick/auto-deploy 已切），`/health` 退为纯 liveness。配套纪律：listen 后各初始化步（core services/agent loops/channels/sweep/handlers）全部「失败只 warn 不拒启」，bootstrap catch → exit(1) 实际只能由 listen 前步骤（迁移/路由注册）触发——新增 listen 后步骤必须挂进 runSoftSteps/mountSoftSteps（#686 起纪律唯一固化点，见 soft-steps.ts），否则部署判绿后进程死亡、回滚不触发
- **失败分级**：迁移失败 = 拒启（外层 catch exit 1）；reconcile/seed/warmup/bridges/核心服务/handlers 单项失败只 log 不阻断——#686 起该纪律唯一固化在 `soft-steps.ts`，新增 listen 后步骤走 runSoftSteps/mountSoftSteps 即自带纪律，不再各自手写 try/catch
- **优雅关闭逆序**：unmount AgentLoop → 杀在飞 CLI 进程组（#179）→ stopTunnel → stopEvolutionScheduler → monitor.stop → auditor.stop → server.close → 5s 强制 exit 兜底；顺序由 `__tests__/lifecycle.test.ts` 钉死
- 测试：`__tests__/` 每文件一个同名测试，装配顺序/拒启/关闭逆序三条核心语义均有断言
- **SEC-07 启动暴露策略**：`exposure-policy.ts` 在 `initConfig()` 完成 `.env` 加载后统一校验 auth × HOST × tunnel × production × registration × `STUDIO_EXTERNAL_EXPOSURE` / `STUDIO_TRUSTED_REVERSE_PROXY`；外部暴露必须 `STUDIO_AUTH=on`，且禁止 `REGISTER_ENABLED=true`，模糊布尔声明和未知 auth mode fail-closed。`listen-host.ts` 只解析地址，不再分散做安全判定。免登录本地模式另由 `middleware/local-network.ts` 校验回环 Host/Origin，回环 socket 不作为浏览器来源证明。
