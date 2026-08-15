---
status: "done"
version: "1.0"
source: docs/issues/2026-07-03-pipeline-removal-checklist.md
type: cleanup
---

# Pipeline 代码移除

## 源项目清单

| # | 源项目（checklist 章节） | 产出类型 | SDD AC |
|---|------------------------|---------|--------|
| S1 | §5B-1 pipeline_health_degraded 全链路 | 代码改名 | AC-1 |
| S2 | §5B-2 变量名/文案修复 | 代码改名 | AC-1 |
| S3 | §5B-5 SDD frontmatter goalId→workUnitId | 代码改名+数据迁移 | AC-2 |
| S4 | §3.1.1 studio-cli.ts 死代码 | 代码删除 | AC-3 |
| S5 | §3.1.2 okr.service.ts PipelineRun 方法 | 代码删除 | AC-3 |
| S6 | §3.1.3 monitor-agent 死代码+改名 | 代码删除+改名 | AC-3 |
| S7 | §3.1.4 auditor-agent PipelineRun+改名 | 代码删除+改名 | AC-3 |
| S8 | §3.1.5 channel.routes.ts 死代码 | 代码删除 | AC-3 |
| S9 | §3.2 中度依赖（11 文件） | 代码删除+改名 | AC-4 |
| S10 | §3.3 轻度依赖（25 文件） | 注释/字符串修复 | AC-4 |
| S11 | §1 整目录删除（goals/ + pipeline-dashboard/） | 目录删除 | AC-5 |
| S12 | §4 Pipeline Agent 删除 | 文件删除 | AC-5 |
| S13 | §2 Prisma 模型删除（6 模型） | Schema 迁移 | AC-6 |
| S14 | §7 测试文件清理 | 测试删除+修改 | AC-7 |
| S15 | §5C-2 约束反馈能力缺口 | 记录（不阻塞） | N/A — 独立任务 |

排除决策：S15（约束反馈能力补建）不纳入本次 SDD，理由：§5C-2 明确标注"不阻塞本次 Pipeline 清理"，作为独立任务后续跟进。

---

## AC-1: 语义层污染修复

`covers: [S1, S2]`

消除所有"操作 WorkUnit 但叫 Goal/Pipeline"的概念污染。

### AC-1.1: `pipeline_health_degraded` → `workunit_health_degraded` 全链路

- **触发**：alert type 在 types.ts 定义
- **预期**：
  1. `agents/types.ts` L20: type literal 改为 `'workunit_health_degraded'`
  2. `auditor-agent.service.ts` L517-538: 触发方 type 值同步改名
  3. `triage/error-class.ts` L106: match 改为 `workunit_health_degraded`，action 改为 `check agent health + examine failed WorkUnits`（不是 restart server）
  4. `triage-agent.service.ts` L110, 301-303: type 匹配改名，修复动作改为检查 WorkUnit 失败原因（不是 pm2 restart）
  5. `agents/__tests__/triage-agent.test.ts` L32: 测试更新 type
- **边界**：`FailureCategory = 'pipeline'`（error-class.ts L123-176）**保留** — 这是 CI/CD pipeline 含义
- **不做**：不改 triage 其他 alert type

### AC-1.2: monitor-agent 变量名/文案修复

- **预期**：
  1. `checkReviewQuality()` L495-526: `goal` → `wu`，"Goal xxx" → "WorkUnit xxx"
  2. `checkTokenBudget()` L528-572: 同上
  3. `dataLifecycle` catch L1802-1811: "GoalExecution cleanup" → "WorkUnit cleanup"
- **不做**：不改 checkReviewQuality/checkTokenBudget 的查询逻辑（已正确查 workUnit）

### AC-1.3: auditor-agent 改名

- **预期**：
  1. L111-142: `### Goal 状态` → `### WorkUnit 状态`
  2. L758-798: `Draft Goal` → `Draft WorkUnit`，变量 `goal` → `wu`
  3. L758-798: `type: 'task'` → `type: 'okr_proposal'`（防止 AgentLoop 误认领 OKR 提案）
  4. L1627-1636: `recentGoals` → `recentWorkUnits`，"相似 Goal" → "相似 WorkUnit"
- **边界**：AgentLoop claim 逻辑（`agent-loop.ts` L156-164）空 acceptedTypes → 无 type 过滤 → 认领所有 unassigned WorkUnit。`okr_proposal` 类型不会被认领（不在任何 role 的 acceptedTypes 中）

### AC-1.4: agents/types.ts 残留

- **预期**：
  1. L45: 注释 `one per GoalExecution` → `one per WorkUnit`
  2. L146: `'stuck_goals'` → `'stuck_workunits'`（确认无消费方后）

---

## AC-2: SDD frontmatter goalId → workUnitId

`covers: [S3]`

- **触发**：`packages/studio-shared/src/utils/sdd-utils.ts` 中 `SddFrontmatter.goalId` 类型定义
- **预期**：
  1. 类型定义 L17: `goalId?: string` → `workUnitId?: string`
  2. 函数名 L237: `findSddDocByGoalId` → `findSddDocByWorkUnitId`
  3. 函数名 L250: `readSddDocByGoalId` → `readSddDocByWorkUnitId`
  4. 函数签名 L417: `findSddDocs({ goalId })` → `findSddDocs({ workUnitId })`
  5. 序列化 L152: `writeStr('goalId', ...)` → `writeStr('workUnitId', ...)`
  6. 消费方改名：`agent-runner.ts` L959, `wiki.service.ts` L95/201, `analyst-trigger.service.ts` L97/666, `channel.routes.ts` L427/435-437/768
  7. 29 个 SDD 文件 `docs/sdd/*/requirement.md`: `goalId:` → `workUnitId:`（机械替换）
  8. 测试 `sdd-utils.test.ts` L445-463: `goalId` → `workUnitId`
- **不做**：~~post-eval-agent~~ 随 AC-5 删除，无需改名
- **边界**：29 个 SDD 文档的 goalId 值全部悬空（Goal 表已空），改名后值保持悬空

---

## AC-3: 重度依赖清理

`covers: [S4, S5, S6, S7, S8]`

5 个重度依赖文件的逐行清理。

### AC-3.1: studio-cli.ts（~340 行删除）

- **预期**：删除以下区域，保留非 Pipeline 代码：
  - L173-260: `waitForGoalCreated` + `pollForGoalCreated`
  - L265-274: `--pipeline` flag 解析
  - L319-511: 6 阶段等待循环
  - L362-373: `cancelRunningExecutions`
  - L727-799: `studioPipeline()`
  - L990-1001: E2E `goal_creation` 测试
  - L1539-1557: `studio metrics` 子命令
  - L1565-1567: `studio pipeline` 子命令
  - L1574-1575: `studio goal` 子命令
  - L1624-1626, 1629: help text
- **验证**：`studio --help` 不显示 pipeline/goal/metrics 命令

### AC-3.2: okr.service.ts（9 删除 + 1 改名）

- **预期**：
  - DELETE: `queryPipelineDurationP90`, `queryPipelineDurationPerPhase`, `queryCacheHitRate`, `queryTokenSavingRatio`, `queryPipelineCostTokens`, `queryTestPassRate`, `queryPipelineGoalCost`, `queryRollbackRate`, `checkDataSourceHealth` 中 PipelineRun 部分
  - RENAME: METRIC_REGISTRY `dataSource: 'goal'` → `dataSource: 'execution'`
  - KEEP: `_count.Execution`, `Execution: { select }`, `prisma.execution` 引用（Execution 是独立旧模型，不在本次范围）
- **验证**：无 `prisma.pipelineRun` 引用残留

### AC-3.3: monitor-agent.service.ts（删除 + 3 改名）

- **预期**：
  - DELETE 死代码：`checkPipelineLatency()`, `checkStuckGoals()`, `analyzeRoutingEvolution()`, `applyRoutingOptimizations()`, `applyTokenBudgetGate()`, `checkSessionEscalation()`, `dailyReflection` PipelineRun 块, `precipitateRouting()` + routing.jsonl TTL
  - RENAME：`checkReviewQuality()` goal→wu, `checkTokenBudget()` goal→wu, `dataLifecycle` catch 日志
  - CONDITIONAL DELETE: `dataLifecycle` PipelineRun TTL（PipelineRun 表 DROP 后）
- **验证**：无 `prisma.pipelineRun`、无 routing.jsonl 引用

### AC-3.4: auditor-agent.service.ts（2 删除 + 2 改名）

- **预期**：
  - DELETE: Pipeline cache efficiency 审计 L645-677, 诊断信号 PipelineRun 聚合 L1559-1577
  - RENAME: 已在 AC-1.3 覆盖
- **验证**：无 `prisma.pipelineRun` 引用残留

### AC-3.5: channel.routes.ts（~400 行删除 + 1 改名）

- **预期**：
  - DELETE: `start_execution` L410-804（首条 `return 503`，后续全死代码）
  - DELETE: `PIPELINE_DEPRECATED` L755-762
  - DELETE: `readSddDocByGoalId` import L6
  - RENAME: `POST /:id/convert` 函数名 `convertConversationToPipeline` → `triggerAnalyst`
  - KEEP: `DELETE /:id` L1009-1058（已用 prisma.workUnit，改注释）

---

## AC-4: 中度+轻度依赖清理

`covers: [S9, S10]`

### AC-4.1: 中度依赖（11 文件）

| 文件 | 操作 |
|------|------|
| `agents/deploy-agent.service.ts` | DELETE 整文件 |
| `agents/execution-alarm.ts` | DELETE 整文件 |
| `monitoring/trace-pipeline.service.ts` | DELETE 整文件 |
| `monitoring/init-trace.ts` | DELETE 整文件 |
| `knowledge/knowledge-service.ts` | DELETE `pipelineFeedback()` 方法 + `pipeline` 枚举值 |
| `tools-std/skill-extraction.service.ts` | RENAME `extractFromGoalExecution` → `extractFromWorkUnit` |
| `daemon/metrics.ts` | DELETE Pipeline 指标 |
| `channels/conversation-converter.ts` | DELETE 整文件 |
| `executions/routes.ts` | DELETE Goal include（L183-225 `(exec as any).Goal?.name`），保留 `prisma.execution` 引用 |

### AC-4.2: 轻度依赖（25 文件）

| 文件 | 行 | 操作 |
|------|---|------|
| `route-registry.ts` | 78-79, 157-158, 189, 236-237 | 删除 4 个 Goal/Pipeline 路由条目 |
| `index.ts` | 1, 149-150, 205 | 删除 `initTracePipeline()` 调用 + 更新注释 |
| `triage/error-class.ts` | 106-176 | `pipeline_health_degraded` 已在 AC-1.1 处理；`FailureCategory = 'pipeline'` **保留**（CI/CD 含义） |
| `workunit/workunit.service.ts` | 19-28 | 改注释（Goal/GoalExecution 字段映射 → WorkUnit） |
| `roles/role-config.service.ts` | 206 | 改 prompt 文案 `GoalExecution 失败` → `WorkUnit 失败` |
| `llm/creation-analyzer.ts` | 159 | 从 workflowKeywords 数组删除 `'pipeline'` |
| `channels/analyst-prompt.ts` | 48-208 | 更新 prompt（Goal 创建相关 + trace-pipeline 示例） |
| `channels/analyst-synthesizer.ts` | 48 | 改文案 `已实现的需求不创建 Goal` → `...不创建 WorkUnit` |
| `channels/analyst-trigger.service.ts` | 829, 876, 880 | L876 删除 PipelineRun 写入；L829/L880 改注释 |
| `channels/analyst-prescan.ts` | 54 | 从关键词列表删除 `'pipeline'` |
| `channels/multi-repo-split.ts` | 2-5 | 改注释 `Multi-repo Goal splitting` → `Multi-repo WorkUnit splitting` |
| `channels/discovery-exposure.service.ts` | 55 | 改注释 `trigger automatic @analyst for pipeline execution` |
| `channels/sdd-verification.ts` | 5 | 改注释 `affect pipeline logic` |
| `knowledge/decision-chain-extractor.ts` | 2, 134 | 2 处注释 "Goal" → "WorkUnit"（文件不碰 Goal 表） |
| `knowledge/eval-case-generator.ts` | 80-89 | 参数名 `goalId` → `workUnitId`（不查 Prisma，仅存文件） |
| `knowledge/resolution.service.ts` | 269 | 从 tags 删除 `'pipeline'` |
| `knowledge/improver-scheduler.service.ts` | 89 | 从 sourceDirs 数组删除 `'...modules/goals'` |
| `agents/types.ts` | 20, 45 | AC-1.1 + AC-1.4 已覆盖 |
| `agents/session-summary-agent.service.ts` | 4 | 改注释 `非 Goal 维度` → `非 WorkUnit 维度` |
| `agents/requirement-gate.ts` | 4 | 改注释 `Goal 创建前验证` → `WorkUnit 创建前验证` |
| `agents/review-agent.service.ts` | 282 | 删除 `prisma.pipelineReview.upsert` 调用 |
| `agents/data-analyst-agent.service.ts` | 160-167 | DELETE `collectRecentRuns()`（PipelineRun LLM 遥测，WorkUnit 无等价数据） |
| `agents/knowledge-agent.service.ts` | 58-514 | 改 prompt `Pipeline 9-Stage Flow` + 删 `tags: ['pipeline']` |
| `test-executor.ts` | 18-57 | 改注释 `Creating test Goal`（已全用 prisma.workUnit） |
| `knowledge/knowledge-bus.service.ts` | 613 | 改注释示例 `"pipeline-logging"` |

---

## AC-5: 目录 + Agent 删除

`covers: [S11, S12]`

### AC-5.1: 目录删除

- `rm -rf modules/goals/`（16 源码 + 27 测试 + 2 文档 = 45 文件）
- `rm -rf modules/pipeline-dashboard/`（2 文件）
- `route-registry.ts`: 删除 4 个路由条目（AC-4.2 已覆盖）
- `index.ts`: 删除 `initTracePipeline()` 调用（AC-4.2 已覆盖）
- **验证**：`ls modules/goals/` 不存在，`ls modules/pipeline-dashboard/` 不存在

### AC-5.2: Pipeline Agent 删除

AC-4.1 已覆盖 deploy-agent / execution-alarm / trace-pipeline / init-trace 的整文件删除。本节仅补充 post-eval-agent：

| 文件 | 理由 |
|------|------|
| `post-eval-agent.service.ts` | Skill 系统（code-review + sdd-review）已覆盖 AC 审计 |

- **验证**：`grep -r "post-eval-agent" src/` 零

---

## AC-6: Prisma 模型删除

`covers: [S13]`

- **前置**：AC-1 ~ AC-5 全部完成，`grep -r "prisma\.goal\.\|prisma\.goalExecution\.\|prisma\.pipelineRun\.\|prisma\.pipelineReview\.\|prisma\.pipelineDecision\." src/` 零
- **预期**：
  1. 删除 6 个 model 定义：Goal, GoalPlan, GoalExecution, PipelineRun, PipelineReview, PipelineDecision
  2. **保留** Execution 模型（独立旧 workflow，PMO/OKR 使用）
  3. `npx prisma migrate dev` 生成 migration
  4. `npx prisma generate` 重新生成 client
- **验证**：`npx tsc --noEmit` 零错误

---

## AC-7: 测试清理 + 最终验证

`covers: [S14]`

### AC-7.1: 测试删除

- `modules/goals/__tests__/` 整目录（随 AC-5.1）
- `agents/__tests__/execution-alarm.test.ts`, `post-eval-agent*.test.ts`（随 AC-5.2）
- `channels/__tests__/conversation-converter.test.ts`（随 AC-4.1）

### AC-7.2: 测试修改

| 测试文件 | 改动 |
|---------|------|
| `pmo/__tests__/okr-b8.test.ts` | 删除 PipelineRun seed + 14 Pipeline KR 测试 |
| `pmo/__tests__/okr-goal-stats-fix.test.ts` | 删除 |
| `pmo/__tests__/okr-query-fix.test.ts` | 删除 `queryPipelineGoalCost` 测试 |
| `agents/__tests__/data-analyst-agent.service.test.ts` | 删除 `pipelineRun` mock |
| `agents/__tests__/triage-agent.test.ts` | 更新 `handleAlert` type |
| `agents/__tests__/default-triggers.test.ts` | 删除 `stale-recovery` mock |
| `channels/__tests__/multi-repo-split.test.ts` | 改注释 |
| `knowledge/__tests__/knowledge-service.test.ts` | 删除 `pipelineFeedback` 测试 |
| `knowledge/__tests__/selfdoc-arch.test.ts` | 删除 Pipeline 文档测试 |
| `daemon/__tests__/metrics.test.ts` | 删除 `pipelineRun` mock |

### AC-7.3: 最终验证

```bash
# 零残留
grep -r "prisma\.goal\." src/           # 零
grep -r "prisma\.goalExecution\." src/  # 零
grep -r "prisma\.pipelineRun\." src/    # 零
grep -r "prisma\.pipelineReview\." src/ # 零
grep -r "prisma\.pipelineDecision\." src/ # 零
grep -r "modules/goals" src/            # 零
grep -r "pipeline-dashboard" src/       # 零

# 编译通过
npx tsc --noEmit

# 全量测试
pnpm test
```
