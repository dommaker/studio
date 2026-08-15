---
status: done
version: "1.0"
slug: agent-network-ops-migration
title: Agent Network 运维层重构：Monitor/Auditor/DataAnalyst 迁移 — 任务
created: 2026-07-13
tags:
  - agent-network
  - migration
  - task
  - test-planning
---

## 契约测试规划

### AC Group 1: DataAnalyst 删除

| AC | 测试文件 | 测试用例 | 验证方法 |
|----|---------|---------|---------|
| AC-1.1 | — | 文件不存在验证 | `ls studio/apps/api/src/modules/agents/data-analyst-agent.service.ts 2>&1; echo $?` → 非 0 |
| AC-1.2 | — | 文件不存在验证 | `ls studio/apps/api/src/modules/agents/__tests__/data-analyst-agent.service.test.ts 2>&1; echo $?` → 非 0 |
| AC-1.3 | — | import 引用验证 | `grep -c "dataAnalyst\|data-analyst" studio/apps/api/src/index.ts` → 0 |
| AC-1.4 | — | 事件类型引用验证 | `grep -r "knowledge:data_analysis" studio/apps/api/src/` → 0 |
| AC-1.5 | 全量测试套件 | 全量测试通过 | `pnpm test -- --coverage` exit code = 0 |
| AC-1.6 | — | spec 文件不存在验证 | `ls studio/docs/specs/agents/data-analyst-agent.md 2>&1; echo $?` → 非 0 |

### AC Group 2: 公共统计层

| AC | 测试文件 | 测试用例 |
|----|---------|---------|
| AC-2.1 | `anomaly-detector.test.ts` | 导出检查: 验证 6 个函数均可 import |
| AC-2.2 | `anomaly-detector.test.ts` | 依赖检查: 测试文件运行不依赖项目模块 |
| AC-2.3 | `anomaly-detector.test.ts` | 每个函数 3+ 用例覆盖: 正常值、边界值、异常值 |
| AC-2.4 | `anomaly-detector.test.ts` | `zScoreTest(5, {mean:0, stddev:2})` → `isAnomaly=true, severity='warning'` |
| AC-2.5 | `anomaly-detector.test.ts` | `zScoreTest(1, {mean:0, stddev:2})` → `isAnomaly=false, severity='normal'` |
| AC-2.6 | `anomaly-detector.test.ts` | `detectTrend([1,2,3,4], 3)` → `direction='up', consecutiveDays=4` |
| AC-2.7 | `anomaly-detector.test.ts` | `detectTrend([1,2,1,2], 3)` → `direction='stable', consecutiveDays=0` |
| AC-2.8 | `anomaly-detector.test.ts` | 异常输入: 空数组 → `{mean:0,stddev:0}`; NaN 过滤 → 正确计算; Infinity → 不抛异常 |
| AC-2.9 | — | barrel export 验证: `grep "stats" index.ts` → 匹配 |
| — | `anomaly-detector.test.ts` | 附加: `rollingBaseline([10,20,30], 2)` → 基于最后 2 个值计算 |
| — | `anomaly-detector.test.ts` | 附加: `detectDelta(15, 10, 0.5)` → `deltaRatio=0.5, isAnomaly=true` |
| — | `anomaly-detector.test.ts` | 附加: `percentile([1,2,3,4,5], 50)` → 3 |

### AC Group 3: OKR 异常检测

| AC | 测试文件 | 测试用例 |
|----|---------|---------|
| AC-3.1 | — | 文件存在验证: `ls okr-anomaly-detector.ts` → exit 0 |
| AC-3.2 | `okr-anomaly-detector.test.ts` | 正常数据: mock KRHistory 返回 7 天数据, 验证分组正确 |
| AC-3.3 | `okr-anomaly-detector.test.ts` | z-score 异常场景: mock 数据使 z-score > 2, 验证 event 写入 |
| AC-3.4 | `okr-anomaly-detector.test.ts` | 趋势异常场景: mock 连续 3 天递减数据, 验证 trend event |
| AC-3.5 | `okr-anomaly-detector.test.ts` | 空数据: KRHistory 无记录 → 返回空列表 |
| AC-3.6 | `okr-anomaly-detector.test.ts` | LLM 检查: grep 源文件无 LLM 关键词 |
| AC-3.7 | — | schema 检查: `grep "model KRHistory" schema.prisma` → 匹配 |
| AC-3.8 | — | trigger 检查: `grep okr-metric-sync default-triggers.ts` → 匹配 |
| — | `okr-anomaly-detector.test.ts` | 附加: 部分空数据（某指标只有 2 天记录）→ 不抛异常, 跳过基线不足的指标 |
| — | `okr-anomaly-detector.test.ts` | 附加: 多指标同时异常 → 每个指标写入独立 event |

### AC Group 4: Monitor Agent 去 LLM + 系统健康

| AC | 测试文件 | 测试用例 |
|----|---------|---------|
| AC-4.1 | `monitor-agent.test.ts` | `grep "modelGateway\|promptJson" monitor-agent.service.ts` → 0 |
| AC-4.2 | `system-health.test.ts` | 导出检查: `collectSystemHealth`, `checkThresholds`, `runGC` 均可 import |
| AC-4.3 | `system-health.test.ts` | snapshot 完整性: 验证返回的 `SystemHealthSnapshot` 包含所有字段 |
| AC-4.3 | `system-health.test.ts` | CPU 采集: mock `os.loadavg()` 验证数值正确 |
| AC-4.4 | `system-health.test.ts` | CPU 超阈值: loadAvg > cores → 返回 critical Alert |
| AC-4.4 | `system-health.test.ts` | 内存超阈值: heapUsedMB > 512 → 返回 warning Alert |
| AC-4.4 | `system-health.test.ts` | 磁盘超阈值: percentUsed > 90 → 返回 critical Alert |
| AC-4.4 | `system-health.test.ts` | 全正常: 所有指标低于阈值 → 返回空数组 |
| AC-4.5 | `system-health.test.ts` | GC 清理: mock 文件系统, 验证过期文件被清理 |
| AC-4.5 | `system-health.test.ts` | GC 空运行: 无可清理项 → 返回 `{cleaned: 0, details: [], duration: number}` |
| AC-4.6 | `monitor-agent-cpu.test.ts` | 集成测试: 验证修改后 Monitor 5min 轮询可正常启动和运行 |
| AC-4.7 | `monitor-agent-cpu.test.ts` | 修改后全部通过 |
| AC-4.7 | `monitor-agent-resilience.test.ts` | 修改后全部通过（7 describe 块） |
| — | `monitor-agent-cpu.test.ts` + `monitor-agent-resilience.test.ts` | Mock 清理: 删除 modelGateway/promptJson mock（源文件已无 LLM 调用），删除对应 import 和 mockResolvedValue/RejectedValue 调用 |

### AC Group 5: Auditor Agent 去 LLM

| AC | 测试文件 | 测试用例 |
|----|---------|---------|
| AC-5.1 | `auditor-agent.test.ts` | `grep "modelGateway\|promptJson" auditor-agent.service.ts` → 0 |
| AC-5.2 | `auditor-agent.test.ts` | `grep "diagnoseRootCause\|aggregateDiagnosticSignals" auditor-agent.service.ts` → 0 |
| AC-5.3 | `auditor-agent.test.ts` | Circuit 7 触发: attainment=45%, trend='down' → WorkUnitService.create() 被调用 |
| AC-5.3 | `auditor-agent.test.ts` | Circuit 7 不触发: attainment=60%, trend='down' → 不创建 WorkUnit |
| AC-5.3 | `auditor-agent.test.ts` | Circuit 7 不触发: attainment=45%, trend='up' → 不创建 WorkUnit |
| AC-5.4 | `auditor-agent.test.ts` | metadata shape 验证: attainment, trend, currentValue, targetValue, historyCount |
| AC-5.5 | `auditor-agent.test.ts` | diagnosis=null 验证 |
| AC-5.6 | `auditor-agent.test.ts` | 纯代码审计功能不变: 执行统计、技能分析、OKR 跟踪、eval case、Resolution 的 mock 仍被调用 |
| AC-5.7 | `auditor-agent.test.ts` | 修改后全部通过（4 describe 块, 392 行） |

---

## 执行顺序

### 总体依赖图

```
Step 1 (DataAnalyst 删除) ───────── 无依赖 ──┐
Step 2 (stats/ 新建) ───────────── 无依赖 ──┤
Step 4 (default-triggers 加 trigger) ─ 无依赖 ─┤  Wave 1 (并行)
Step 5 (system-health 新建) ──────── 无依赖 ──┘
                                              │
Step 3 (okr-anomaly-detector 新建) ─ 依赖 Step 2 + Step 4 ── Wave 2
                                              │
                 ┌────────────────────────────┘
                 ▼
Step 6 (Monitor 删 LLM) ─────────── 依赖 Step 5 ─┐  Wave 3 (并行)
Step 7 (Auditor 删 LLM) ─────────── 依赖 Step 3  ─┘
                 │
                 ▼
Step 8 (CAPABILITIES + 全量测试) ─── 依赖全部完成 ── Wave 4
```

### Wave 1: 独立任务（可并行）

#### Step 1: DataAnalyst 删除

**文件**:
- 删除 `data-analyst-agent.service.ts`
- 删除 `data-analyst-agent.service.test.ts`
- 删除 `data-analyst-agent.md`
- 修改 `index.ts`（删 import + start）
- 修改 `studio/CAPABILITIES.md`（删 L244）
- 修改 `studio/apps/api/CAPABILITIES.md`（删 L34）

**验证 checkpoints**:
- CP-1.1: 3 个文件不存在 → `ls` 确认
- CP-1.2: `index.ts` 无 dataAnalyst 引用 → `grep` 确认
- CP-1.3: `pnpm test` 仍通过

---

#### Step 2: 公共统计层

**文件**:
- 新建 `studio/packages/studio-shared/src/stats/anomaly-detector.ts`（6 纯函数）
- 新建 `studio/packages/studio-shared/src/stats/__tests__/anomaly-detector.test.ts`
- 修改 `studio/packages/studio-shared/src/index.ts`（barrel export）

**验证 checkpoints**:
- CP-2.1: 文件存在 + 6 函数导出 → `ls` + `grep`
- CP-2.2: `anomaly-detector.test.ts` 全部用例通过
- CP-2.3: barrel export 可通过 import

---

#### Step 4: 加 syncKRProgress trigger

**文件**:
- 修改 `default-triggers.ts`（after L101 加 okr-metric-sync）

**验证 checkpoints**:
- CP-4.1: trigger 定义正确 → `grep 'okr-metric-sync' default-triggers.ts`
- CP-4.2: cron 表达式 '47 3 * * *' 正确
- CP-4.3: Trigger types 校验通过（TypeScript compile）

---

#### Step 5: system-health.ts 新建

**文件**:
- 新建 `studio/apps/api/src/modules/agents/system-health.ts`
- 新建 `studio/apps/api/src/modules/agents/__tests__/system-health.test.ts`

**验证 checkpoints**:
- CP-5.1: 文件存在 + 3 函数导出
- CP-5.2: `system-health.test.ts` 全部用例通过
- CP-5.3: TypeScript compile 通过

---

### Wave 2: 依赖 Wave 1

#### Step 3: OKR 异常检测

**依赖**: Step 2（stats 库）+ Step 4（trigger 注册）

**文件**:
- 新建 `studio/apps/api/src/modules/pmo/okr-anomaly-detector.ts`
- 新建 `studio/apps/api/src/modules/pmo/__tests__/okr-anomaly-detector.test.ts`
- 修改 `studio/packages/studio-prisma/prisma/schema.prisma`（加 KRHistory model）

**验证 checkpoints**:
- CP-3.1: 文件存在 + `detectAnomalies()` 导出
- CP-3.2: schema.prisma 包含 `model KRHistory`
- CP-3.3: `okr-anomaly-detector.test.ts` 全部通过（mock KRHistory + stats）
- CP-3.4: `pnpm test -- --testPathPattern=okr` 通过

---

### Wave 3: 并行（相互独立）

#### Step 6: Monitor Agent 删 LLM

**依赖**: Step 5（system-health.ts 已提取）

**文件**:
- 修改 `monitor-agent.service.ts`（删除 L136-141, L1513-1524, L1584-1595）
- 修改 `monitor-agent-cpu.test.ts` + `monitor-agent-resilience.test.ts`（删除 modelGateway/promptJson mock 残留学）

**验证 checkpoints**:
- CP-6.1: `grep modelGateway monitor-agent.service.ts` → 0 matches
- CP-6.2: Monitor 测试中无 modelGateway mock 残留
- CP-6.3: `pnpm test -- --testPathPattern=monitor` 全部通过（包括 cpu 131 行 + resilience 306 行）
- CP-6.4: TypeScript compile 通过（删除后 import 无残留）

---

#### Step 7: Auditor Agent 删 LLM

**依赖**: Step 3（okr-anomaly-detector 提供纯代码 WorkUnit 创建模式）

**文件**:
- 修改 `auditor-agent.service.ts`（删 diagnoseRootCause + aggregateDiagnosticSignals; Circuit 7 替换）

**验证 checkpoints**:
- CP-7.1: `grep modelGateway auditor-agent.service.ts` → 0 matches
- CP-7.2: `grep diagnoseRootCause|aggregateDiagnosticSignals` → 0 matches
- CP-7.3: Circuit 7 纯代码 WorkUnit 创建 → 测试验证 metadata shape
- CP-7.4: `pnpm test -- --testPathPattern=auditor` 全部通过（392 行, 4 describe）
- CP-7.5: TypeScript compile 通过

---

### Wave 4: 最终验证

#### Step 8: CAPABILITIES 更新 + 全量测试

**依赖**: Steps 1-7 全部完成

**文件**:
- `studio/CAPABILITIES.md` — 已更新（Step 1）
- `studio/apps/api/CAPABILITIES.md` — 已更新（Step 1）

**验证 checkpoints**:
- CP-8.1: `pnpm test -- --coverage` 全部通过，覆盖率不下降
- CP-8.2: `npx tsc --noEmit` 类型检查通过
- CP-8.3: CAPABILITIES 无 stale 条目（运行 `harness sync-docs` 验证）
- CP-8.4: 无开发活动时 modelGateway 定时调用 = 0（检查 trigger 列表确认无残留）

---

## 执行顺序总结

```
Wave 1 (并行):
  ├── Step 1: DataAnalyst 删除 ── CP-1.1 → CP-1.2 → CP-1.3
  ├── Step 2: stats 新建 ──────── CP-2.1 → CP-2.2 → CP-2.3
  ├── Step 4: trigger ─────────── CP-4.1 → CP-4.2 → CP-4.3
  └── Step 5: system-health ──── CP-5.1 → CP-5.2 → CP-5.3

Wave 2 (依赖 Wave 1):
  └── Step 3: okr-anomaly ────── CP-3.1 → CP-3.2 → CP-3.3 → CP-3.4

Wave 3 (并行, 相互独立):
  ├── Step 6: Monitor 删 LLM ─── CP-6.1 → CP-6.2 → CP-6.3 → CP-6.4
  └── Step 7: Auditor 删 LLM ─── CP-7.1 → CP-7.2 → CP-7.3 → CP-7.4 → CP-7.5

Wave 4 (最终):
  └── Step 8: CAPABILITIES + 全量 ── CP-8.1 → CP-8.2 → CP-8.3 → CP-8.4
```

---

## 风险与回退策略

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| stats 函数在某边缘输入崩溃 | 低 | 中 | AC-2.8 硬约束 + 边界测试覆盖 NaN/Infinity/空数组 |
| KRHistory model 与已有迁移 SQL 不一致 | 中 | 高 | 先读已有迁移 SQL 再定义 model（迁移 SQL 已存在） |
| Auditor Circuit 7 替换后测试不通过 | 低 | 高 | Circuit 7 逻辑不变（触发条件不变），只改 LLM→纯代码 |
| Monitor 测试因删除 LLM 调用而失败 | 低 | 中 | 测试中 mock 的 LLM 调用移除 → 删除对应 mock 即可 |
| Wave 内并行导致 Git 冲突 | 低 | 中 | 各 Step 无文件重叠，可独立分支提交 |

**回退策略**: 每个 Wave 独立提交。Wave 1 提交后若 Wave 2 有问题，只回退 Wave 2。Wave 3 两 Step 独立提交，互不影响。
