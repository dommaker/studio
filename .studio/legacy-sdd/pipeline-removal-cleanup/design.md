---
status: "done"
version: "1.0"
---

# Pipeline 代码移除 — 设计

## 文件映射

### AC-1: 语义层污染修复

| 文件 | 改动类型 | 具体操作 |
|------|---------|---------|
| `apps/api/src/modules/agents/types.ts` | RENAME | L20 `'pipeline_health_degraded'` → `'workunit_health_degraded'`；L45 注释改；L146 `'stuck_goals'` → `'stuck_workunits'` |
| `apps/api/src/modules/agents/auditor-agent.service.ts` | RENAME | L111-142 标签改，L517-538 alert type 改，L758-798 文案+变量+type 改，L1627-1636 文案改 |
| `apps/api/src/modules/agents/monitor-agent.service.ts` | RENAME | L495-526 goal→wu，L528-572 goal→wu，L1802-1811 日志改 |
| `apps/api/src/modules/triage/error-class.ts` | RENAME+FIX | L106 match 改 type + action 改（不 restart server） |
| `apps/api/src/modules/agents/triage-agent.service.ts` | RENAME+FIX | L110 type 匹配改，L301-303 修复动作改 |
| `apps/api/src/modules/agents/__tests__/triage-agent.test.ts` | UPDATE | L32 type 改 |

### AC-2: SDD frontmatter

| 文件 | 改动类型 | 具体操作 |
|------|---------|---------|
| `packages/studio-shared/src/utils/sdd-utils.ts` | RENAME | L17 类型, L152 序列化, L237/L250 函数名, L417 签名 |
| `apps/api/src/modules/agents/agent-runner.ts` | RENAME | L959 调用改 |
| `apps/api/src/modules/wiki/wiki.service.ts` | RENAME | L95, L201 字段改 |
| `apps/api/src/modules/channels/analyst-trigger.service.ts` | RENAME | L97, L666 字段改 |
| `apps/api/src/modules/channels/channel.routes.ts` | RENAME | L427, L435-437, L768（部分随 AC-3.5 删除） |
| `docs/sdd/*/requirement.md` ×29 | RENAME | `goalId:` → `workUnitId:` 机械替换 |
| `packages/studio-shared/src/utils/__tests__/sdd-utils.test.ts` | RENAME | L445-463 |

### AC-3: 重度依赖

| 文件 | 改动类型 | 具体操作 |
|------|---------|---------|
| `apps/api/src/cli/studio-cli.ts` | DELETE | ~340 行（见 requirement AC-3.1 行范围清单） |
| `apps/api/src/modules/pmo/okr.service.ts` | DELETE+RENAME | 9 方法删，METRIC_REGISTRY 标签改 |
| `apps/api/src/modules/agents/monitor-agent.service.ts` | DELETE+RENAME | 7 死方法删 + precipitateRouting+TTL 删 + 3 改名 |
| `apps/api/src/modules/agents/auditor-agent.service.ts` | DELETE | 2 个 PipelineRun 查询块删 |
| `apps/api/src/modules/channels/channel.routes.ts` | DELETE+RENAME | ~400 行死代码删，convert 函数改名 |

### AC-4: 中度+轻度依赖

| 文件 | 改动类型 | 具体操作 |
|------|---------|---------|
| `apps/api/src/modules/agents/deploy-agent.service.ts` | DELETE | 整文件 |
| `apps/api/src/modules/agents/execution-alarm.ts` | DELETE | 整文件 |
| `apps/api/src/modules/monitoring/trace-pipeline.service.ts` | DELETE | 整文件 |
| `apps/api/src/modules/monitoring/init-trace.ts` | DELETE | 整文件 |
| `apps/api/src/modules/knowledge/knowledge-service.ts` | DELETE | `pipelineFeedback()` + `'pipeline'` 枚举值 |
| `apps/api/src/modules/tools-std/skill-extraction.service.ts` | RENAME | `extractFromGoalExecution` → `extractFromWorkUnit` |
| `apps/api/src/daemon/metrics.ts` | DELETE | Pipeline 指标 |
| `apps/api/src/modules/channels/conversation-converter.ts` | DELETE | 整文件 |
| `apps/api/src/modules/executions/routes.ts` | DELETE | Goal include 仅 |
| `apps/api/src/modules/agents/data-analyst-agent.service.ts` | DELETE | `collectRecentRuns()` 方法 |
| `apps/api/src/modules/agents/review-agent.service.ts` | DELETE | `prisma.pipelineReview.upsert` 调用 |
| `apps/api/src/modules/channels/analyst-trigger.service.ts` | DELETE | PipelineRun 写入 L876 |
| `apps/api/src/modules/channels/analyst-prompt.ts` | UPDATE | prompt 中 trace-pipeline 示例 |
| 其余 14 个轻度文件 | UPDATE | 注释/字符串/关键词删除 |

**轻度依赖完整清单（25 文件）**：

| 文件 | 行 | 操作 |
|------|---|------|
| `route-registry.ts` | 78-79, 157-158, 189, 236-237 | 删 4 路由条目 |
| `index.ts` | 1, 149-150, 205 | 删 `initTracePipeline()` + 改注释 |
| `error-class.ts` | 106 | AC-1.1 覆盖；L123-176 `FailureCategory='pipeline'` 保留 |
| `workunit.service.ts` | 19-28 | 改注释 |
| `role-config.service.ts` | 206 | 改 prompt 文案 |
| `creation-analyzer.ts` | 159 | 删 `'pipeline'` keyword |
| `analyst-prompt.ts` | 48-208 | 改 prompt |
| `analyst-synthesizer.ts` | 48 | 改文案 |
| `analyst-trigger.service.ts` | 829, 876, 880 | L876 删 PipelineRun 写入；L829/L880 改注释 |
| `analyst-prescan.ts` | 54 | 删 `'pipeline'` 关键词 |
| `multi-repo-split.ts` | 2-5 | 改注释 |
| `discovery-exposure.service.ts` | 55 | 改注释 |
| `sdd-verification.ts` | 5 | 改注释 |
| `decision-chain-extractor.ts` | 2, 134 | 2 处注释 "Goal"→"WorkUnit" |
| `eval-case-generator.ts` | 80-89 | 参数 `goalId`→`workUnitId` |
| `resolution.service.ts` | 269 | 删 `'pipeline'` tag |
| `improver-scheduler.service.ts` | 89 | 删 sourceDirs 元素 |
| `session-summary-agent.service.ts` | 4 | 改注释 |
| `requirement-gate.ts` | 4 | 改注释 |
| `review-agent.service.ts` | 282 | 删 `pipelineReview.upsert` |
| `data-analyst-agent.service.ts` | 160-167 | DELETE `collectRecentRuns()` |
| `knowledge-agent.service.ts` | 58-514 | 改 prompt + 删 tag |
| `test-executor.ts` | 18-57 | 改注释 |
| `knowledge-bus.service.ts` | 613 | 改注释示例 |

### AC-5: 目录+Agent 删除

| 目标 | 操作 |
|------|------|
| `apps/api/src/modules/goals/` | `rm -rf`（45 文件） |
| `apps/api/src/modules/pipeline-dashboard/` | `rm -rf`（2 文件） |

| `apps/api/src/modules/agents/post-eval-agent.service.ts` | DELETE 整文件（AC-4.1 的 4 个文件已在 design AC-4 映射） |

### AC-6: Prisma Schema

| 文件 | 操作 |
|------|------|
| `packages/studio-prisma/prisma/schema.prisma` | DELETE Goal(L222-242), GoalPlan(L244-258), GoalExecution(L260-283), PipelineRun(L1235-1257), PipelineReview(L1296-1310), PipelineDecision(L1315-1332)。保留 Execution(L197-218) |
| `packages/studio-prisma/prisma/migrations/` | 新增 migration |

### AC-7: 测试

| 文件 | 操作 |
|------|------|
| 13 个测试文件 | 删除/修改（见 requirement AC-7.1 + AC-7.2 清单） |

---

## 依赖图

```
AC-1 (语义修复)
  │
  ├─→ AC-2 (SDD frontmatter) ─── 独立
  │
  ├─→ AC-3 (重度依赖) ───┐
  │                       │
  └─→ AC-4 (中+轻度)  ───┤─── 全部并行
                          │
      AC-5 (目录+Agent) ──┘
          │
          ▼
      AC-6 (Prisma) ─── 必须等 AC-1~5 全清
          │
          ▼
      AC-7 (测试+验证) ─── 最后执行
```

### 并行分析

| 组 | 可并行 | 理由 |
|----|--------|------|
| AC-1 | 串行先行 | 语义修复影响后续 grep 验证基准 |
| AC-2 | 独立 | 仅 sdd-utils + 29 SDD 文件 + 5 消费方，不与 AC-3~5 共享文件 |
| AC-3 | 5 个 AC 子项可并行 | 5 个文件互不依赖 |
| AC-4 | 与 AC-3 并行 | 文件无重叠（除 channel.routes.ts 在 AC-3.5 和 AC-2 都有改动 — AC-2 先改 goalId，AC-3.5 再删 start_execution） |
| AC-5 | 与 AC-3/4 并行 | 目录删除独立 |
| AC-6 | 串行 | 必须等所有代码引用清除 |
| AC-7 | 串行 | 最后验证 |

### 文件冲突矩阵

| 文件 | AC-1 | AC-2 | AC-3 | AC-4 | AC-5 |
|------|------|------|------|------|------|
| auditor-agent.service.ts | ✓ | | ✓ | | |
| monitor-agent.service.ts | ✓ | | ✓ | | |
| triage-agent.service.ts | ✓ | | | | |
| error-class.ts | ✓ | | | | |
| types.ts | ✓ | | | | |
| channel.routes.ts | | ✓ | ✓ | | |
| analyst-trigger.service.ts | | ✓ | | ✓ | |
| monitor-agent (routing TTL) | | | ✓ | | |
| goals/ 目录 | | | | | ✓ |

冲突点：`channel.routes.ts` 被 AC-2 和 AC-3.5 共享 → AC-2 先改 goalId，AC-3.5 再删 start_execution。
冲突点：`auditor-agent.service.ts` 被 AC-1.3 和 AC-3.4 共享 → 同一 Phase 内顺序处理。

---

## 约束

| 约束 | 说明 |
|------|------|
| Execution 模型保留 | 独立旧 workflow，PMO/OKR 使用，不在本次范围 |
| FailureCategory='pipeline' 保留 | CI/CD pipeline 含义，非 Pipeline 架构 |
| 每步 checkpoint | `npx tsc --noEmit` 编译通过 |
| Phase 1.5 先行 | 语义修复必须在删除前完成（建立正确 grep 基准） |
| §5C-2 不阻塞 | 约束反馈能力补建为独立任务 |
