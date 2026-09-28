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
| `constraints.routes.ts` | 约束清单 + 质量门（/constraints*、/check-constraints——#641 起同样剥离请求体自报的 hasRequirement 并以 strippedEvidenceFlags 标注，不再缺省 true；degrade/schedule 已随 0.17.0 移除；条目字段随 harness 1.10.0 换 severity 显式面，stats 聚合桶 byLevel→bySeverity；retired/rollback = config.yml 单落点——custom-constraints.yml 落点通道已随 #617 拆除，customConstraintsPath 一并删除；#646 起 rollback 写操作走 harness reactivate CLI，见注意事项）。`POST /constraints/propose-upgrade`（ADR-0033 子项 8，harness ≥1.12.0）：校验 constraintId 是应用层约束（`<repoRoot>/.harness/constraints.yml` 有定义）→ 建 constraint kind 提案卡（action='upgrade'，带 traces 统计白话）发 #系统；approve 后落点（spawn pack-proposal + 材料回帖）归 evolution/constraint-adapter |
| `knowledge.routes.ts` | 知识引擎（/knowledge*） |
| `sessions.routes.ts` | 上下文管理（/estimate-tokens、/sessions*） |
| `agents.routes.ts` | Agent 生命周期（/agents*） |
| `diagnostics.routes.ts` | 错误分类（/classify、/failures；/check-spec、/verify* 随 harness 1.2.0 ADR-0003 断链删除） |
| `dashboard.routes.ts` | 健康检查（/health；/dashboard 随 harness 1.2.0 ADR-0003 断链删除） |
| `cso.routes.ts` | CSO 验证（/validate；2026-07 起 /api/v1/cso 只挂本文件，不再整挂 routes.ts 门面——否则 harness 的 Admin 收紧可被 /cso/* 双挂载绕过） |
| `iron-laws.routes.ts` | Iron Laws（独立子路由，挂 /api/v1/iron-laws；#641 起 /check 与 /check-all 剥离请求体自报的 has* 证据标志，依赖项由 harness 降级 skip，响应以 strippedEvidenceFlags 标注降级） |
| `sanitize-context.ts` | #641 证据标志信任边界唯一口（mcp/safety.tools 复用）：被检查者不能自证，sanitizeConstraintContext 剥离请求侧 has* 标志；downgradeAnnotation/degradedChecksOf 负责响应面降级标注（strippedEvidenceFlags + 顶层 degradedChecks 清单，三态不可混淆） |

### 核心导出

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
  裸 disable 404）、写后复查墓碑摘除定成功、非零退出 500。retired 墓碑直读记豁免，待
  dommaker/harness#188（listRetiredConstraints）发布后切换。
- 子路由路径首段字面前缀互不重叠；唯一前缀包含关系 /constraints/stats 先于
  /constraints/:id 注册（constraints.routes.ts 内保持顺序）。
- 提案面退役（#648，2026-09-28）：proposals.routes（GET /proposals、POST /:id/review、
  POST /:id/execute，持久化 `process.cwd()/.harness/proposals/`）整体删除——生产者早随
  harness 0.17.0 移除（GET 恒空 / review 恒 404 / execute 恒 410），web 零调用，提案生命周期
 归 review-proposal 正本（#351）；CLI `studio approve skill` 断链分支同票改为明确不支持提示。
- 会话与 AgentLifecycle 为内存态。
- GET /knowledge 有 30s TTL 缓存（runtime.ts）。
