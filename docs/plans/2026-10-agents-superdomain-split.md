# P2-d：agents 超级域拆分为顶层模块

日期：2026-10-02　状态：实施中　类型：架构重构（Phase 2 第四刀，上位 plan：docs/plans/2026-09-arch-refactor.md §4 Phase 2.3）

## 方案

### 移动映射

| 源（modules/agents/） | 目标 | 说明 |
|---|---|---|
| `loop/` | `modules/agent-loop/` | 决策循环 + WU 执行链（agent-loop/prompt-composer/executor/completion-gates 等 24 文件） |
| `monitor/` | `modules/agent-monitor/` | Monitor Agent（5min 轮询健康监控 + 渐进告警）；命名避开既有 `monitoring`（指标聚合） |
| `auditor/` | `modules/agent-auditor/` | Auditor Agent（24h 日审） |
| `ops/` | `modules/agent-ops/` | 进程级守护（preflight/health 轮询自愈） |
| `knowledge/` | `modules/agent-knowledge/` | 知识维护 Agent；解决与顶层 `knowledge`（知识引擎）命名冲突 |
| `triage/` | 并入 `modules/triage/` | Triage Agent 与既有错误分类（error-class）同域合并；非新增模块 |
| `monitor/exec-async.ts` | `core/exec-async.ts` | 零依赖异步 exec 原语（loop/monitor/triage 三方消费），下沉防 triage↔agent-monitor 环（P2-c 手法③先例） |
| `dispatch-reconciliation.ts` | `modules/agent-loop/` | 依赖 review-dispatcher + monitor-alerts；留 agents 会拉成 agents↔agent-loop 静态环 |
| `instance-timeout-scan.ts` | `modules/agent-monitor/` | 依赖 monitor-alerts；实例超时巡检与 monitor 同为周期扫描 |
| `types.ts` | 拆分后删除 | Triage 类型 → `triage/types.ts`；MonitorAlert 类型 → `monitor/types.ts`；KnowledgeExtraction/KnowledgeEntryDraft 零引用死类型删除 |
| `wu-test-guards.ts` | 删除 | 死代码（真身 = loop/agent-loop-guards.ts，零引用） |
| `agent-knowledge-analysis.ts` | 删除 | 死代码（零调用方，agent-loop.types.ts 注记工单 43 已删） |

### agents 本体剩余（瘦身后）

profiles（agent-profile.\*）/ instances（agent-instance.\*）/ token-usage（token-usage.\*）三条线 + 支撑件：routes.ts（legacy）、default-provider、default-triggers、system-executor、system-role（core 门面）、session-summary.service。

### 公共面（index.ts，按实际消费反推）

- `agent-loop`：agentLoopRegistry、getReviewDispatcher、getDailyTokenUsage/resolveDailyTokenBudget/tokenBudgetGuardEnabled、EXECUTION_STREAM_SSE_TYPE、CODE_WORKTREE_TYPES/resolveVerifyCommands/runWuVerification、reconcileDispatchBreaks
- `agent-monitor`：monitorService、dispatchMonitorAlerts、emitMonitorEvent、scanStaleAgentInstances、MonitorAlert（type）
- `agent-auditor`：auditorService、getAuditorReviewAdapter
- `agent-ops`：createOpsService
- `agent-knowledge`：knowledgeCurator、getExtractFromTextSystemPrompt
- `triage`（增量）：triageService、TriageIncidentInput/TriageLogEntry/TriageIncidentType（type）
- `agents`（瘦身）：summarizeRoleStates、ensureStudioProfile、backfillProfileProviders、registerDefaultTriggers、sessionSummaryService、getSystemExecutor、StudioRoleNotConfiguredError、isSystemRole、STUDIO_ROLE_NAME、aggregateTreeTokens、sumTokensForWorkUnits

### 依赖方向（静态值边，无环）

```
agent-loop ─→ agents(barrel: system-executor) ─┐
agent-loop ─→ agent-monitor ─→ triage ─→ knowledge
agent-loop ─→ workunit/pmo/channels/skills/...（既有边）
agent-monitor ─→ agents(barrel: agent-instance)  # instance-timeout-scan
agent-auditor ─→ audit-logs/channels/knowledge/review-proposal/skills/workunit
agent-ops ─→ auth/core
agent-knowledge ─→ agents(barrel: system-executor) + knowledge
agents ─→ （不依赖任何新模块）
```

反向边（knowledge→agent-knowledge、workunit→agent-loop、audit-logs→agent-auditor、pmo→agent-monitor 等）全部维持动态 import（现状即如此），静态值边保持清零。

### 刀序（每刀独立 commit、独立验证）

1. 预备：本 plan + exec-async 下沉 core + types.ts 拆分 + 死文件 ×2 删除
2. triage 并入 modules/triage（monitor 对 triage.service 引用改 barrel，先行解耦）
3. ops → agent-ops（叶子）
4. auditor → agent-auditor
5. loop → agent-loop（dispatch-reconciliation 随迁；先于 monitor，避免 dispatch-reconciliation 的 monitor-alerts 引用在 agents↔agent-monitor 间成环）
6. monitor → agent-monitor（instance-timeout-scan 随迁）
7. knowledge → agent-knowledge
8. 收尾：agents CONTEXT.md 改写 + agents-md:sync + 冒烟

### 约束

- route-registry 挂载 URL 零变化（纯内部结构调整）
- bootstrap/ 装配 import 同步改
- 每刀 `npx eslint apps/api/src` 零违规、`npx vitest run apps/api/src` 全绿、`pnpm typecheck` 无新错误
- 测试跟源走（agents root `__tests__` 83 文件按主题分配到新模块 `__tests__/`；深度不变，相对路径仅调前缀）
