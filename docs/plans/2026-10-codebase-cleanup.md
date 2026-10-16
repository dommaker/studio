# studio 代码库深度清理与重构计划

> 执行时先落 `docs/plans/2026-10-codebase-cleanup.md`（仓内计划正本），按 Phase 分批 commit 直落 local master，不 push。
> 依据：4 路并行勘察（死代码/结构/前端/重复逻辑）+ SCC 权威边集分析（scripts/p2c-dep-analysis.mjs）。
> 用户已裁决：scripts/visual 删；e2e spec 有用就接 CI；孤儿端点逐模块确认后收缩；SCC 本轮启动第一刀。

## Phase 0 — 确证死代码清除（10 批小 commit）

- [x] **P0.1 删 `workunit.mappers.ts`（顺带修真 bug）**（3baf172b）
- [x] **P0.2 删 7 个空 barrel + 一次性 codemod**
- [x] **P0.3 删 `apps/api/src/scripts/seed-skills.ts`**
- [x] **P0.4 删 `ops/system-health.ts` + 其测试**（c02d4a49）
- [x] **P0.5 删 `studio-shared/src/stats/anomaly-detector.ts` + 测试**，`percentile` 提取为 `stats/percentile.ts` 并接线两处本地拷贝（c02d4a49）
- [x] **P0.6 前端死代码清扫**（72504533；`usePersistentStreamUI` 复查确认仍被 `useChannelStream.ts` 使用，保留未删——计划初稿此项与实际不符，以代码事实为准）
- [x] **P0.7 小收敛**（c02d4a49）
- [x] **P0.8 删 `scripts/visual/` 整目录** + 移除 root devDeps `pixelmatch`/`pngjs`/`@types/pngjs`（锁文件随 P0.10 一并同步）
- [x] **P0.9 git rm `playwright-report/index.html`**（549KB 误提交产物；实际 .gitignore 并未声明该目录——计划描述偏差，本批补 `playwright-report/` 入 .gitignore）
- [x] **P0.10 删 `@xyflow/react` 依赖**（源码零 import）+ `apps/web/vite.config.ts` manualChunks 对应条目

## Phase 1 — 目录结构归位（纯移动，逐批验证）

- [x] **P1.1 studio-shared `file-store-*` 收进 `src/file-store/` 子目录**（纯移动；`file-store-cached.ts`/`file-store-cache.ts` 命名混淆已消，后者改名 cache-primitives）
- [x] **P1.2 api utils 按受众搬家**（bootstrap/cli 6 个归位 + `token-ledger.ts` → modules/workunit/；errors/pagination/studio-events-tail/logger/services 真横切留下）
- [x] **P1.3 system-role 门面三轨归一**（删 `modules/agents/system-role.ts` re-export 壳，消费方与 agents barrel 统一直引 `core/system-role.ts`）
- [x] **P1.4 `getErrorMessage` 下沉 studio-shared**（消 studio-agent 手写拷贝；api 侧 errors.ts 留 re-export 薄壳）
- [x] **P1.5 巨型模块内子目录化**：`modules/knowledge/` 收 routes/ 7 + producers/ 9 + scheduling/ 2（e57b5e7e）；`modules/agent-loop/` 抽 `prompt-sections/`（8 个 prompt-section-*，计划初稿写 11 个，以代码事实为准）与 `loop/`（6 个 loop-*）（ba81f2dc）。
- [x] P1 完成后跑 `pnpm agents-md:sync` 重建模块索引，同步受影响目录 CONTEXT.md。

## Phase 2 — 重复逻辑收敛

- [x] **P2.1 pmo 三件套订阅样板**（be30350d：抽 `subscribeWuStatusChanged` 骨架 `wu-status-subscription.ts`，过滤条件差异以注入参数保留；decision-resolution 第四处形态不同未纳入）
- [x] **P2.2 review-adapter ×3 收敛**（401f8560：`createJsonlReviewAdapter` 工厂落 review-proposal/jsonl-adapter.ts；签名扩 cardType/storeNamespace/author 参；distill 第四份形态不同未纳入）
- [ ] **P2.3 totalPages 收敛**：6 处手搓 `Math.ceil(total/limit)` → core/http.ts 给 paginated() 配 `makePagination(page,limit,total)`。
- [ ] **P2.4 17 处模块级 service 单例改 `createLazyService`**：`export const x = new XService()` 在 import 期捕获 getStore()，正是 core/store.ts 头注明令禁止的模式（eslint 只挡了 FileStore 无参构造，漏了 service 级）。逐个确认构造副作用后统一。
- [ ] **P2.5 logger 双轨统一**：api 侧 pino（24 文件）vs shared console 版（studio-agent 6 文件）→ pino 实现下沉 shared，api 侧留薄壳；运行时可观测性收敛。
- [ ] **P2.6 LLM 动态 import 归一**：knowledge/entries.routes.ts:112、skills/skill-extraction.service.ts:245、channels/convert-to-task.service.ts:143 三处 `await import('../agents/index.js')` 查因（疑似循环规避残留）后改静态。

## Phase 3 — 复杂度热点拆分

- [ ] **前端**：`AuditLogsPage`(564，筛选栏/表格抽出 + StatCard 双份拷贝收敛为 components/ui 一份) → `WorkUnitDrawer`(464，按现成分隔注释拆 WuDetail/ReqChain) → `proposalCardConfigs.tsx`(530，按提案域拆 + index 合并注册表) → `KnowledgePage`/`MonitoringPage`（JSX 段抽子组件 + SectionError 重复模式收敛）→ `ChannelMessageItem`（renderCard 移出 + NEED_INPUT 回复块拆 ChannelNeedInputReply）。不拆清单（已判定内聚）：useStreamFollow、channelMessageStore、ChannelInput、ChannelActivityRail。
- [ ] **后端**：`agent-loop/loop-step.ts agentStep`(492 行，按文件自带分段线切 worktree 解析/会话签发/prompt 组装/执行 4 段) → `ops/metrics-aggregate.ts aggregateOverview`(446，按指标组抽纯函数) → `loop-record-result.ts recordResult`(306，回帖/簿记/事件三阶段) → `ops/monitor-reports.ts dailyReflection`(291 行嵌套 7 层，6 个数据源各抽 collectXxxLines)。顺带把 `(s:any)` 泛滥的 session:summary payload 定型为共享类型。

## Phase 4 — 孤儿端点收缩（逐模块确认消费方后删）

- [ ] 待确认端点面：knowledge 域 ~13 条（inject-context/match-resolutions/record-outcome/flywheel/incident/trend/pattern/decay/merge/audit/health 等）、skills 7 条、evolution 5 条、harness iron-laws 4 条、散点（triggers/agent-instances/agent-profiles/audit-logs/export/admin/docs-freshness/workspaces/runtimes/token-usage/events agent-events）。
- [ ] 每条确认路径：grep `apps/api/src/cli/`、`modules/mcp/`、`bin/studio`、studio-config 仓脚本、docs 消费方 → 无消费方：删端点 + 对应 contract schema + 测试；有消费方：在该模块 CONTEXT.md 记录消费方是谁。
- [ ] 顺带处置 `POST /harness/check-constraints`（P0.6 删前端残桩后成孤儿）。

## Phase 5 — SCC 第一刀：切 3 条单边（21→18 节点）

权威边集分析（p2c-dep-analysis）锁定三条「一个 import 就是一个模块全部出簇边」的切点：

- [ ] **auth → audit-logs**（`auth/routes.ts:13` getAuditService，1 条静态 import）
- [ ] **notifications → channels**（`alert-notifier.ts:21` ChannelMessageService，1 条）
- [ ] **review-proposal → channels**（`card.ts:40` 动态 import channelMessageService，1 条——动态 import 是当时躲循环的临时招，正说明该处需要正经的缝）

手法（三处统一，树立后续解耦的标准模式）：**bootstrap 装配期 DI**——被调方模块暴露注册口（如 `registerAuditSink(fn)`/`registerChannelCardPoster(fn)`），bootstrap/ 装配时把 channels/audit-logs 的实现注进去，静态 import 边消除。事件总线留给真正异步 fire-and-forget 的场景，不滥用。
每切一刀：更新 `scripts/module-cycle-exemptions.mjs` HUB_SCC 成员集 → `pnpm lint:cycles` 验证转绿（门自带 stale 自检，豁免不同步会红，天然验收）。

## Phase 6 — e2e spec 审计与接 CI

- [ ] 审计 8 个 spec（app/auth.setup/channel-e2e/iron-law/pmo/role/security/version）：初判 app/iron-law 断言过弱（条件断言、渲染存在性），channel-e2e 硬编码 localhost:5180/13001 是本地手动工具。
- [ ] 有价值的 spec 改为 playwright `webServer` 模式（CI 内自起 api 测试实例 + web preview，去硬编码端口），加 CI job（playwright 安装 + 跑 spec）；无价值/修复成本过高的删。
- [ ] 决策检查点：若审计发现 spec 大面积腐烂，退回用户裁决（接 CI 预算 vs 删除）。

## 执行纪律

- 每批 commit 前：`pnpm typecheck` + `vitest run --changed origin/master` + 涉及模块结构时 `pnpm lint:cycles`。
- commit 分批直落 local master，refactor/chore/fix 前缀；P0.1 是 fix（含 bug 修复）。
- 目录变动同步 CONTEXT.md + 必要处跑 `pnpm agents-md:sync`。
- 收尾按 exploration-sediment 清单沉淀 + 公开仓脱敏两道自查（本任务涉安全文字面低，仍照跑）。
- 不 push、不部署（用户触发）。

## 预估与次序

P0（约 10 批）→ P1（5 批）→ P2（6 批）→ P5（SCC 三刀，趁热）→ P3（拆分）→ P4（端点收缩，逐模块）→ P6（e2e，含检查点）。工作量跨会话级，按 Phase 推进，每 Phase 完成即一批可验证的绿状态。
