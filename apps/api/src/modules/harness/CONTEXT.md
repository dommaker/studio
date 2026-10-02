# apps/api/src/modules/harness

### 职责

Harness 监控与治理 API（FL-029 / T-015）：轨迹采集分析、约束生命周期、
知识引擎、会话/Agent 管理、错误分类与验证、仪表盘。
（安全护栏 guards.routes 已随 harness 1.2.0 删除 InputGuardrail/OutputGuardrail/Sandbox（ADR-0003）移除，2026-08。）

路由结构（T3 大文件拆分 5/N，2026-07-19）：`routes.ts` 为挂载门面，
处理器按资源拆分为子路由，共享运行时集中于 `runtime.ts`：

| 文件 | 职责 |
|------|------|
| `runtime.ts` | @dommaker/harness 懒加载、Collector/Analyzer/KnowledgeStore 单例、TTL 缓存 |
| `routes.ts` | 挂载门面（默认导出 Router，route-registry 挂 /api/v1/harness，2026-07 起 requireAuth+requireAdmin） |
| `traces.routes.ts` | 轨迹采集/分析（/traces、/analysis；/diagnose 随 harness 1.2.0 ADR-0003 断链删除）。/analysis* 走 harness#100 报告入口 `analyzeRecentReport()`，响应含 `skippedLines` 坏行计数（>0 打 warn，#451）。harness 1.10.0（ADR-0029）起 trace 字段 level→severity：/traces 查询参数与 POST body 均收 `severity`，错误文案同步 |
| `constraints.routes.ts` | 约束清单 + 质量门（/constraints*、/check-constraints——#641 起同样剥离请求体自报的 hasRequirement 并以 strippedEvidenceFlags 标注，不再缺省 true；1.15.0 适配：违规抛 ConstraintViolationError → 200 部分视图数据（violationPartialView），500 只留真实 harness 故障；degrade/schedule 已随 0.17.0 移除；条目字段随 harness 1.10.0 换 severity 显式面，stats 聚合桶 byLevel→bySeverity；retired/rollback = config.yml 单落点——custom-constraints.yml 落点通道已随 #617 拆除，customConstraintsPath 一并删除；#646 起 rollback 写操作走 harness reactivate CLI，见注意事项）。`POST /constraints/propose-upgrade`（ADR-0033 子项 8，harness ≥1.12.0）：校验 constraintId 是应用层约束（`<repoRoot>/.harness/constraints.yml` 有定义）→ 建 constraint kind 提案卡（action='upgrade'，带 traces 统计白话）发 #系统；approve 后落点（spawn pack-proposal + 材料回帖）归 evolution/constraint-adapter |
| `knowledge.routes.ts` | 知识引擎（/knowledge*） |
| `sessions.routes.ts` | 上下文管理（/estimate-tokens、/sessions*） |
| `agents.routes.ts` | Agent 生命周期（/agents*） |
| `diagnostics.routes.ts` | 错误分类（/classify、/failures；/check-spec、/verify* 随 harness 1.2.0 ADR-0003 断链删除） |
| `dashboard.routes.ts` | 健康检查（/health；/dashboard 随 harness 1.2.0 ADR-0003 断链删除） |
| `cso.routes.ts` | CSO 验证（/validate；2026-07 起 /api/v1/cso 只挂本文件，不再整挂 routes.ts 门面——否则 harness 的 Admin 收紧可被 /cso/* 双挂载绕过） |
| `iron-laws.routes.ts` | Iron Laws（独立子路由，挂 /api/v1/iron-laws；#641 起 /check 与 /check-all 剥离请求体自报的 has* 证据标志，依赖项由 harness 降级 skip，响应以 strippedEvidenceFlags 标注降级；1.15.0 适配：/check-all 捕获 ConstraintViolationError → 200 部分视图数据（violationPartialView），500 只留真实 harness 故障；/check 走 checkConstraint(id) 不抛、违规天然走数据面） |
| `sanitize-context.ts` | #641 证据标志信任边界唯一口（mcp/safety.tools 复用）：被检查者不能自证，sanitizeConstraintContext 剥离请求侧 has* 标志；downgradeAnnotation/degradedChecksOf 负责响应面降级标注（strippedEvidenceFlags + 顶层 degradedChecks 清单，三态不可混淆）；violationAsPartialView + VIOLATION_PARTIAL_VIEW 承接 block 模式违规 → 部分视图数据（仅首个违规，与 degradedChecks 同族口径） |

### 核心导出

- `index.ts` — 模块公共出口 barrel（P2-c 立界：跨模块唯一合法 import 面，实际消费反推生成；深路径 import 由 eslint `local/no-deep-module-import` 拦截）
- `routes.ts` default export：express Router（32 个端点，见门面注释）

### 依赖关系

- 依赖 `@dommaker/harness`（懒加载，不可用时端点降级 503）
- 依赖 `@dommaker/studio-shared`（logger）、`../knowledge/knowledge-singletons.js`（UNIFIED_KNOWLEDGE_DIR）
- 被 `apps/api/src/route-registry.ts` 引用（/api/v1/harness = requireAuth+requireAdmin；/api/v1/cso 仅挂 cso.routes 的 /validate，公开不变）

### 注意事项

- `.harness/` 文件所有权裁定（#646 grilling，2026-09-28）：`config.yml` 归 harness（写操作只能走
  harness API/CLI，如 constraints retire/reactivate）；`constraints.yml`（应用层约束正本）归应用仓，
  harness 仅加载期读+schema 校验——studio 读写它不算绕过 harness。格式漂移由读方校验暴露。
- rollback 落点（#646 实现，2026-09-28）：POST /constraints/:id/rollback 改 spawn harness
  `constraints reactivate <id> --yes`（复用 evolution/applier 的 resolveHarnessBin/runCmd 纪律，
  并同 retire 路径钉 KNOWLEDGE_BASE_DIR=UNIFIED_KNOWLEDGE_DIR——复活与退役沉淀同根）。
  CLI 的 skip 与成功退出码同为 0，判定不碰 stdout 文案：前置读墓碑定 404（只认 retired+enabled:false，
  裸 disable 404）、写后复查墓碑摘除定成功、非零退出 500。retired 墓碑直读豁免的切换前置已满足
  ——harness 1.15.0 已公共导出 listRetiredConstraints（harness#188/#192，签名无 cwd 缺省）；
  切换动作未随采纳票做（不单方面扩范围），待后续票承接。
- 子路由路径首段字面前缀互不重叠；唯一前缀包含关系 /constraints/stats 先于
  /constraints/:id 注册（constraints.routes.ts 内保持顺序）。
- 提案面退役（#648，2026-09-28）：proposals.routes（GET /proposals、POST /:id/review、
  POST /:id/execute，持久化 `process.cwd()/.harness/proposals/`）整体删除——生产者早随
  harness 0.17.0 移除（GET 恒空 / review 恒 404 / execute 恒 410），web 零调用，提案生命周期
 归 review-proposal 正本（#351）；CLI `studio approve skill` 断链分支同票改为明确不支持提示。
- 会话与 AgentLifecycle 为内存态。
- GET /knowledge 有 30s TTL 缓存（runtime.ts）。
- harness 1.15.0 采纳（harness#183 证据源重构，2026-09-28）：`no_completion_without_verification`
  不再读 `ConstraintContext.hasVerificationEvidence`（字段已退役），改读
  `<projectPath>/.harness/evidence/` 独立链路证据，新鲜度 = 最新证据 mtime ≥ 变更文件 mtime；
  证据缺失 = error 级 fail（本仓暂无证据生产方，触发域含 code_implementation 的直调面会恒 fail，
  生产方建设待 harness 侧口径落定）。`sanitize-context.ts` 剥离清单同步缩为 7 项。
- 违规数据面适配（2026-09-28，1.15.0 后续）：`checkConstraints` block 模式对首个 error 级违规
  即抛 `ConstraintViolationError`（只带该条结果，后续 error/warning 未跑）。三个消费面
  （iron-laws /check-all、constraints /check-constraints、MCP checkConstraint）统一
  `instanceof` 捕获 → 200 部分视图数据（`violationPartialView: {truncated, reason}` 标注，
  与 degradedChecks/strippedEvidenceFlags 同族）；500/harnessUnavailable 只留给真实调不通
  harness。注意 `checkConstraint(id)` 单约束面不抛，无需处理；docs-freshness 传
  `module_modification`，不在该约束触发域（trigger=code_implementation），不受影响未改。
  真根因（本仓缺 .harness/evidence 证据生产方）另票处理。
- listRetiredConstraints 已随 harness 1.15.0（#188/#192）成公共面（签名 target: RunTarget，
  无 cwd 默认值）；constraints.routes.ts 的 retired 墓碑直读豁免切换属后续单票，本仓当前零调用点。
- **契约驱动迁移（2026-10 批次 6/7）**：harness 八子路由 + cso + iron-laws 全端点走 defineRoute——必填 guard 收进 zod（traces 三件套/knowledge budget+三件套/sessions id+event/agents id/diagnostics message/estimate-tokens 二选一 refine/propose-upgrade constraintId 字符集/check-constraints operation；iron-laws lawId/context，MISSING_LAW_ID/MISSING_CONTEXT 手写码退役）；列表壳内层 data 键改名词键进 `{ data }` 壳（traces/constraints/retired/knowledge entries/lint issues/agents，避免 data.data 双包，无消费方）；propose-upgrade success 标志与 iron-laws `{ success, data, count, source }` 壳退役；rollback rolledBack、check-constraints 与 iron-laws 标注键（strippedEvidenceFlags/degradedChecks/violationPartialView）收进 data 内；#641 证据标志剥离依赖 schema 声明保留 has* 键（check-constraints hasRequirement 声明、iron-laws context 用 record）；503 统一 code SERVICE_UNAVAILABLE（GET /health 的 status:'unknown' 兄弟键退役）；500 message 由固定串变为实际错误消息。cso /validate 恒 200 降级语义不变（原注释的前端 api.validateCSO() 死面清除）。
