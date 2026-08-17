---
status: "done"
version: "1.1"
created: 2026-06-30
updated: 2026-06-30
---

# Task: Phase 1.1 MonitorAgent Pipeline 查询迁移

## 执行状态

✅ **全部完成**（2026-06-30）。Phase 1.1a + 1.1b 均已实现并验证。

## 实际执行顺序

Phase 1.1a（直接替换 + no-op）→ Phase 1.1b（适配重写），逐步实现逐步验证。

## 测试覆盖

**实际测试文件**：`apps/api/src/modules/agents/__tests__/monitor-agent-resilience.test.ts`（单文件 14 tests）

实际测试结构：
1. Alert source type coverage（AC-3.1-3.2）：验证 12 种 MonitorAlertSource
2. StudioEvent query contract（AC-3.3-3.5）：验证查询类型和 alert shape
3. escalateToTriage source coverage（AC-3.6）：验证 12 种 source 映射
4. WorkflowObserver（B9-025）：验证 observeWorkflow 方法
5. B48-1A: reviewQuality + orphan cleanup：reviewScore=0/40 测试 + autoAbandonStaleRunning no-op 验证
6. Auto-fail time-critical workUnits：checkTotalExecutionTime 超时/未超时测试

**测试修复记录**：
- 1.1a 后：checkReviewQuality 测试从 mockGoalFindMany+context 改为 mockWuFindMany+metadata
- 1.1a 后：autoAbandonStaleRunning 测试改为验证 no-op（无 prisma 调用）
- 1.1b 后：checkTotalExecutionTime 测试从 mockGeFindMany/mockGeUpdate 改为 mockWuFindMany/mockWuUpdate，状态 `failed` → `closed`

## 里程碑

| 里程碑 | 状态 | 验证 |
|--------|------|------|
| M1 AC-1.1~1.3 超时/blocked/orphan | ✅ | tsc 通过 + tests 14/14 |
| M2 AC-1.4~1.6 指标/GC | ✅ | tsc 通过 |
| M3 AC-2.1~2.3 Goal 查询 | ✅ | tsc 通过 |
| M4 全量测试 | ✅ | monitor-agent-resilience 14/14 |
| M5 Checkpoint | ✅ | `grep "prisma.goal" monitor-agent.service.ts` → 0 matches |

## 实际实现与原计划差异

1. **测试策略**：原计划 9 个独立测试文件，实际合并到 monitor-agent-resilience.test.ts 单文件
2. **no-op 数量**：原计划 4 处，实际 5 处（+checkSessionEscalation）
3. **适配重写数量**：原计划 9 处，实际 3 处（其余为直接替换或 no-op）
