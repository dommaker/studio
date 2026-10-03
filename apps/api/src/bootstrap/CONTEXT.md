# apps/api/src/bootstrap

### 职责

启动编排（P2-a，docs/plans/2026-09-arch-refactor.md）：原 `apps/api/src/index.ts`（590 行）按职责拆出的启动步骤集合，`index.ts`（本目录）只做装配，`apps/api/src/index.ts` 只剩 KNOWLEDGE_DIR 钉值 + 调 `bootstrap()`。目标架构（docs/architecture/target-architecture.md）：`bootstrap/` 按域一个文件。

### 核心导出

- `index.ts` — `bootstrap()` 装配入口：按原 index.ts start() 逐行顺序调用各步；catch 兜底 = 拒启（logger.error + process.exit(1)）。P2-b 起首步为 `initConfig()` → `initStore()`（钉定进程级 FileStore，必须先于迁移等一切 store 消费，见 `../core/CONTEXT.md`）
- `config.ts` — `initConfig()`（PORT/HOST 解析 → warnIfNonProdUsesProdRoot → loadConfig 注入 STUDIO_CONFIG_DIR .env）+ `getPort()/getHost()`
- `migrations.ts` — `runDataMigrations()`（数据区 schema 迁移，失败抛 MigrationError = 拒启）+ `reconcileWorkUnitIndex()`（#170 启动对账，失败不阻断）
- `seed.ts` — `seedBuiltinSkillsStep()`（#223 内置 skill 播种，best-effort）
- `warmup.ts` — `startWarmupTasks()`（冷启动异步任务：GAP-16/RKB/SessionSummary/#173/#213/#327/G-002/G-003/P1b；P2-c 起同一 barrel 的多次动态 import 合并为单次——少一次重复模块求值，并消除 vitest 同模块并发动态 import 的 mock 竞态）+ `startPostRoutesWarmup()`（§9.5 members 迁移 / AS-020 本地 workspace 注册）
- `services.ts` — `startCoreServices()`（monitor → auditor → RequirementRollup → PmoProgressRollup → OpsService → EvolutionScheduler）
- `bridges.ts` — `initEventSubscriptions()`（ReviewDispatcher → DistillLoop 共 11 项 workunit.status_changed 等事件订阅，单项失败不阻断）
- `agent-loop.ts` — `startAgentLoops()`（AS-026：内置角色幂等创建 → provider 回填 → scheduler.start → 注册系统触发器（standby 跳过）→ bridges → 挂载 loop → assignee 自检）+ `sweepEmptyAgentDirs()`（#363）
- `channels.ts` — `initChannels()`（ensureDefaultChannels，Goal 管线需要）
- `handlers.ts` — `registerScanHandlers()`（6 个 trigger EXECUTE handler + evolution review-proposal adapter 注册）
- `tunnel.ts` — `startTunnelIfEnabled()` / `stopTunnel()`（cloudflared 守护，#571 默认关）
- `lifecycle.ts` — `createHttpServer()` / `installErrorHandlers()` / `listen()`（#573 EADDRINUSE 拒启）/ `registerShutdown()`（优雅关闭逆序清理）

### 依赖关系

- 上游：`../app.js`（app + registerRoutes）、`@dommaker/studio-shared`（logger/FileStore/migrations/bootstrapHarness）、各业务模块（动态 import 为主，与原 index.ts 同）
- 下游：`apps/api/src/index.ts`（唯一调用方）

### 注意事项

- **顺序即语义**：装配顺序逐项对齐原 index.ts start()，改动须同步 `__tests__/index.test.ts` 的顺序断言。关键约束：迁移必须先于 reconcile（迁移后布局才是对账正本）；warmup 分 registerRoutes 前/后两段；bridges 调用点固定在 trigger 注册之后、loop 挂载之前（standby 实例也保留事件订阅）
- **失败分级**：迁移失败 = 拒启（外层 catch exit 1）；reconcile/seed/warmup/bridges/核心服务单项失败只 log 不阻断
- **优雅关闭逆序**：unmount AgentLoop → 杀在飞 CLI 进程组（#179）→ stopTunnel → stopEvolutionScheduler → monitor.stop → auditor.stop → server.close → 5s 强制 exit 兜底；顺序由 `__tests__/lifecycle.test.ts` 钉死
- 测试：`__tests__/` 每文件一个同名测试，装配顺序/拒启/关闭逆序三条核心语义均有断言
