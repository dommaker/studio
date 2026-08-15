---
status: "done"
version: "1.0"
---

# Pipeline 代码移除 — 任务

## 执行顺序

### Phase 1: 语义层修复（AC-1）— 串行先行

| 步骤 | 操作 | 文件 | Checkpoint |
|------|------|------|-----------|
| 1.1 | AC-1.1: pipeline_health_degraded 全链路 | types.ts, auditor-agent, error-class, triage-agent, triage test | `npx tsc --noEmit` + `grep -r "pipeline_health_degraded" src/` 零 |
| 1.2 | AC-1.3: auditor-agent 改名 | auditor-agent.service.ts | `npx tsc --noEmit` |
| 1.3 | AC-1.2: monitor-agent 改名 | monitor-agent.service.ts | `npx tsc --noEmit` |
| 1.4 | AC-1.4: types.ts 残留 | types.ts | `npx tsc --noEmit` |

### Phase 2: SDD frontmatter（AC-2）— 可与 Phase 3/4 并行

| 步骤 | 操作 | 文件 | Checkpoint |
|------|------|------|-----------|
| 2.1 | sdd-utils.ts 类型+函数改名 | sdd-utils.ts | `npx tsc --noEmit` |
| 2.2 | 5 个消费方改名 | agent-runner, wiki.service, analyst-trigger, channel.routes | `npx tsc --noEmit` |
| 2.3 | 29 个 SDD 文件机械替换 | docs/sdd/*/requirement.md | `grep -r "goalId" docs/sdd/*/requirement.md` 零 |
| 2.4 | 测试更新 | sdd-utils.test.ts | `npx vitest run sdd-utils` 通过 |

### Phase 3: 重度依赖清理（AC-3）— 等 Phase 1 完成（auditor-agent/monitor-agent 被 AC-1 和 AC-3 共享）

| 步骤 | 操作 | 文件 | Checkpoint |
|------|------|------|-----------|
| 3.1 | AC-3.5: channel.routes.ts | channel.routes.ts | `npx tsc --noEmit` |
| 3.2 | AC-3.1: studio-cli.ts | studio-cli.ts | `npx tsc --noEmit` |
| 3.3 | AC-3.2: okr.service.ts | okr.service.ts | `npx tsc --noEmit` |
| 3.4 | AC-3.3: monitor-agent 死代码 | monitor-agent.service.ts | `npx tsc --noEmit` |
| 3.5 | AC-3.4: auditor-agent PipelineRun | auditor-agent.service.ts | `npx tsc --noEmit` |

### Phase 4: 中度+轻度依赖（AC-4）— 可与 Phase 2/3 并行

| 步骤 | 操作 | 文件 | Checkpoint |
|------|------|------|-----------|
| 4.1 | 整文件删除（5 文件） | deploy-agent, execution-alarm, trace-pipeline, init-trace, conversation-converter | `npx tsc --noEmit` |
| 4.2 | 方法删除+改名（4 文件） | knowledge-service, skill-extraction, metrics, executions/routes | `npx tsc --noEmit` |
| 4.3 | 单方法删除（2 文件） | data-analyst-agent, review-agent, analyst-trigger | `npx tsc --noEmit` |
| 4.4 | 25 个轻度文件注释/字符串修复 | requirement AC-4.2 全表 | `npx tsc --noEmit` |

### Phase 5: 目录删除（AC-5）— 等 Phase 3/4 完成

| 步骤 | 操作 | Checkpoint |
|------|------|-----------|
| 5.1 | `rm -rf modules/goals/` | `ls modules/goals/` 不存在 |
| 5.2 | `rm -rf modules/pipeline-dashboard/` | `ls modules/pipeline-dashboard/` 不存在 |
| 5.3 | 删除 `post-eval-agent.service.ts`（AC-4.1 的 4 个文件已在 Phase 4.1 删除） | `ls` 不存在 |
| 5.4 | `npx tsc --noEmit` | 编译通过（无 dangling import） |

### Phase 6: Prisma 模型删除（AC-6）— 等 Phase 1-5 全清

| 步骤 | 操作 | Checkpoint |
|------|------|-----------|
| 6.1 | 最终 grep 确认零残留 | 7 个 grep 全零（见 AC-7.3） |
| 6.2 | 删除 6 个 model 定义 | schema.prisma 无 Goal/GoalPlan/GoalExecution/PipelineRun/PipelineReview/PipelineDecision |
| 6.3 | `npx prisma migrate dev` | migration 生成 |
| 6.4 | `npx prisma generate` | client 重新生成 |
| 6.5 | `npx tsc --noEmit` | 零错误 |

### Phase 7: 测试清理+验证（AC-7）

| 步骤 | 操作 | Checkpoint |
|------|------|-----------|
| 7.1 | 删除随目录/文件的测试 | goals/__tests__/, execution-alarm.test, post-eval-agent.test, conversation-converter.test |
| 7.2 | 修改 10 个外部测试 | checklist §7.2 全表 |
| 7.3 | `pnpm test` | 全量通过 |
| 7.4 | 最终 grep 验证 | 7 个 grep 全零 |

---

## 契约测试规划

| AC | 测试策略 | 验证方式 |
|----|---------|---------|
| AC-1 | 现有 triage-agent.test.ts 更新 type | `npx vitest run triage-agent` |
| AC-2 | 现有 sdd-utils.test.ts 更新字段名 | `npx vitest run sdd-utils` |
| AC-3 | 无新增测试 — 纯删除，tsc 验证即可 | `npx tsc --noEmit` |
| AC-4 | 无新增测试 — 纯删除/改名 | `npx tsc --noEmit` |
| AC-5 | 无新增测试 — 纯目录删除 | `ls` 验证 |
| AC-6 | Prisma migration 验证 | `npx prisma migrate dev` + `npx tsc --noEmit` |
| AC-7 | 全量回归 | `pnpm test` |

测试原则：本任务是大规模删除/改名，不新增功能代码。测试策略以**现有测试不 break** 为目标，不为删除操作写新测试。

---

## 里程碑

| 里程碑 | 完成标准 | 预计 Phase |
|--------|---------|-----------|
| M1: 语义干净 | `grep -r "pipeline_health_degraded" src/` 零，所有 Goal/Pipeline 变量名已改 | Phase 1 |
| M2: 引用清零 | `grep -r "prisma\.pipelineRun\." src/` 零 | Phase 3+4 |
| M3: 目录清除 | goals/ + pipeline-dashboard/ 不存在 | Phase 5 |
| M4: Schema 迁移 | 6 个 Pipeline model 删除，migration 生成 | Phase 6 |
| M5: 全量验证 | `pnpm test` 通过 + 7 个 grep 全零 | Phase 7 |

---

## 风险缓解

| 风险 | 缓解 |
|------|------|
| 删除后 dangling import | 每 Phase 后 `npx tsc --noEmit` |
| 测试 break | Phase 7 统一修复，Phase 1-6 不修改测试（除非 tsc 报错） |
| Prisma migration 不可逆 | Phase 6.1 最终 grep 确认零残留后才执行 |
| channel.routes.ts 共享冲突 | AC-2 先改 goalId，AC-3.5 再删 start_execution |
| auditor-agent 共享冲突 | AC-1.3 和 AC-3.4 在同一步骤处理 |
