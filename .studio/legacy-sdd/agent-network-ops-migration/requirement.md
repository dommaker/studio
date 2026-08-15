---
status: done
version: "1.0"
slug: agent-network-ops-migration
title: Agent Network 运维层重构：Monitor/Auditor/DataAnalyst 迁移
created: 2026-07-13
tags:
  - agent-network
  - migration
  - monitor
  - auditor
  - data-analyst
  - llm-removal
---

## 源需求清单

| # | 来源 | 描述 | 对应 AC Group |
|---|------|------|---------------|
| S-01 | Design Spec §6 Step 1 | 删除 DataAnalyst Agent（3 文件 + index.ts 引用 + CAPABILITIES 条目） | AC Group 1 |
| S-02 | Design Spec §6 Step 2 | 新建公共统计层 `stats/anomaly-detector.ts`，6 纯函数 | AC Group 2 |
| S-03 | Design Spec §6 Step 3 | 新建 OKR 异常检测 `okr-anomaly-detector.ts`，修复 KRHistory schema | AC Group 3 |
| S-04 | Design Spec §6 Step 4 | 在 `default-triggers.ts` 新增 `okr-metric-sync` SCHEDULE trigger | AC Group 3 |
| S-05 | Design Spec §6 Step 5 | 提取 Monitor 系统健康采集到 `system-health.ts` | AC Group 4 |
| S-06 | Design Spec §6 Step 6 | Monitor Agent 删除 3 处 LLM 调用 | AC Group 4 |
| S-07 | Design Spec §6 Step 7 | Auditor Agent 删除 LLM 调用，Circuit 7 纯代码替代 | AC Group 5 |
| S-08 | Design Spec §6 Step 8 | CAPABILITIES.md 更新 + 全量测试 | AC Groups 1-5 |

---

## AC Group 1: DataAnalyst 删除

**covers**: [S-01]

**目标**：完全删除 DataAnalyst Agent 所有文件、引用和事件类型。

| # | AC | Trigger Condition | Expected Behavior | Edge Cases | Exclusions |
|---|-----|-------------------|-------------------|------------|------------|
| AC-1.1 | `data-analyst-agent.service.ts` 文件不存在 | 删除操作后 | `ls` 确认文件不存在 | — | — |
| AC-1.2 | `data-analyst-agent.service.test.ts` 文件不存在 | 删除操作后 | `ls` 确认文件不存在 | — | — |
| AC-1.3 | `index.ts` 中无 `dataAnalyst` 引用 | 删除 import + start() 后 | `grep dataAnalyst index.ts` → 0 matches | 确保 `data-analyst` 字符串也无残留 | 不修改 AgentNetwork 核心文件 |
| AC-1.4 | `knowledge:data_analysis` 事件类型无任何引用 | 删除事件类型后 | `grep -r knowledge:data_analysis src/` → 0 matches | 检查注释和文档字符串中的引用 | 不删除 `dist/` 构建产物 |
| AC-1.5 | DataAnalyst 删除后全量测试通过 | 删除所有相关文件后 | `pnpm test` 全部通过 | 确保删除不影响其他 Agent 的测试 | 不修改 Agent Network 核心架构 |
| AC-1.6 | `docs/specs/agents/data-analyst-agent.md` 文件不存在 | 删除 spec 文档后 | `ls` 确认文件不存在 | — | — |

**不做**：不删除 `dist/` 构建产物（下次构建自动清理）。不修改 Agent Network 核心架构。

---

## AC Group 2: 公共统计层

**covers**: [S-02]

**目标**：创建零依赖纯函数统计库，提供 z-score 异常检测、趋势检测、突变检测等能力。

| # | AC | Trigger Condition | Expected Behavior | Edge Cases | Exclusions |
|---|-----|-------------------|-------------------|------------|------------|
| AC-2.1 | `stats/anomaly-detector.ts` 存在，导出 6 个函数 | 新建文件后 | `ls` + `grep export` 确认 `meanAndStddev`、`zScoreTest`、`rollingBaseline`、`detectTrend`、`detectDelta`、`percentile` 全部导出 | — | — |
| AC-2.2 | 所有函数零依赖（不 import 项目模块） | 模块创建后 | `grep import` → 无 studio 内部依赖，仅允许标准库或 lodash | import 第三方纯函数库（如 lodash）允许 | — |
| AC-2.3 | 每个函数有单元测试（正常/边界/异常输入） | 测试文件创建后 | test 文件覆盖全部 6 个函数，每个函数 ≥ 3 个用例（正常、边界、异常） | — | 不要求 e2e 集成测试 |
| AC-2.4 | `zScoreTest(value=5, baseline={mean:0,stddev:2})` → `isAnomaly=true, severity='warning'` | z-score=2.5 > 2 | 返回 `{zScore:2.5, isAnomaly:true, severity:'warning'}` | — | — |
| AC-2.5 | `zScoreTest(value=1, baseline={mean:0,stddev:2})` → `isAnomaly=false` | z-score=0.5 ≤ 2 | 返回 `{zScore:0.5, isAnomaly:false, severity:'normal'}` | — | — |
| AC-2.6 | `detectTrend([1,2,3,4], 3)` → `direction='up', consecutiveDays=4` | 连续递增 4 天 | 返回 `{direction:'up', consecutiveDays:4}` | — | — |
| AC-2.7 | `detectTrend([1,2,1,2], 3)` → `direction='stable'` | 未连续 3 天同向 | 返回 `{direction:'stable', consecutiveDays:0}` | 输入不足 minConsecutive 时返回 stable | — |
| AC-2.8 | 空数组/单元素/NaN/Infinity 输入不抛异常，返回安全默认值 | 异常输入 | `meanAndStddev([])` → `{mean:0,stddev:0}`；含 NaN 自动过滤；Infinity 不抛出 | 空数组、单元素、全是 NaN、全是 Infinity | — |
| AC-2.9 | `studio-shared/src/index.ts` 新增 stats barrel export | 导出添加后 | `grep "stats" studio-shared/src/index.ts` → `export * from './stats/anomaly-detector'` 或类似 | — | — |

**不做**：不做持久化、不做 UI、不做生产环境集成（Step 3 才集成）。

---

## AC Group 3: OKR 异常检测

**covers**: [S-03, S-04]

**目标**：创建基于统计的 OKR 指标异常检测，替代 DataAnalyst Agent 的 LLM 分析。修复 KRHistory model 定义。

| # | AC | Trigger Condition | Expected Behavior | Edge Cases | Exclusions |
|---|-----|-------------------|-------------------|------------|------------|
| AC-3.1 | `okr-anomaly-detector.ts` 文件存在 | 新建文件后 | `ls` 确认文件存在于 `apps/api/src/modules/pmo/` | — | — |
| AC-3.2 | `detectAnomalies()` 可从 KRHistory 读取 7 天数据 | 调用时 | 查询 KRHistory 表最近 7 天记录，按 `okrId + krId` 分组 | KRHistory 表为空 → 返回空结果 | — |
| AC-3.3 | 指标值偏离基线 > 2σ 时写入 `metric:anomaly` event | z-score > 2 | 通过 `studioEvent` 写入 type=`metric:anomaly`，payload 含异常指标详情 | 多个指标同时异常 → 每个写入独立 event | — |
| AC-3.4 | 连续 3 天同向变化时写入 `metric:anomaly` event | detectTrend 返回 direction!='stable', consecutiveDays>=3 | 写入 type=`metric:anomaly` event，payload 含 trend 信息 | 已触发 z-score 异常的指标不重复触发 trend 异常 | — |
| AC-3.5 | KRHistory 无数据时不报异常（返回空列表） | KRHistory 表为空 | `detectAnomalies()` 返回 `{anomalies: [], summary: {totalMetrics: 0, anomalyCount: 0}}` | 表存在但无记录 vs 表不存在（应区分） | — |
| AC-3.6 | 零 LLM 调用 | grep 检查 | `grep -E 'modelGateway|openai|anthropic|deepseek'` → 0 matches | 检查 import 和注释中的引用 | — |
| AC-3.7 | KRHistory model 在 schema.prisma 中定义 | model 添加后 | `grep "model KRHistory" schema.prisma` → found，字段与设计一致 | 确保迁移 SQL（已存在）与 model 定义一致 | — |
| AC-3.8 | `default-triggers.ts` 包含 `okr-metric-sync` 条目 | trigger 添加后 | trigger 定义：`condition: { type: 'SCHEDULE', cron: '47 3 * * *' }`，`action: { type: 'EXECUTE', target: 'okr-metric-sync' }` | 在 `getDefaultTriggerConfigs` 之前，不覆盖已有 trigger 配置 | — |

**不做**：不新增 UI/看板。不新增通知渠道（Phase 2 做）。

---

## AC Group 4: Monitor Agent 去 LLM + 系统健康提取

**covers**: [S-05, S-06]

**目标**：删除 Monitor Agent 3 处 LLM 调用，提取系统健康采集到独立纯代码模块。

| # | AC | Trigger Condition | Expected Behavior | Edge Cases | Exclusions |
|---|-----|-------------------|-------------------|------------|------------|
| AC-4.1 | Monitor Agent 中 `modelGateway` 调用为 0 | 删除 LLM 调用后 | `grep modelGateway monitor-agent.service.ts` → 0 matches | 检查字符串/注释中的残留 | — |
| AC-4.2 | `system-health.ts` 文件存在，导出 3 个函数 | 新建文件后 | `ls` + `grep export` 确认 `collectSystemHealth`、`checkThresholds`、`runGC` 全部导出 | — | — |
| AC-4.3 | `collectSystemHealth()` 读 `/proc/loadavg`、`/proc/meminfo` 采集系统指标 | 调用时 | 返回完整的 `SystemHealthSnapshot` 对象，含 CPU/内存/磁盘/DB/WorkUnit 各维度 | `/proc` 文件不可读（容器环境）→ 回退到 `os` 模块 API | — |
| AC-4.4 | `checkThresholds()` 对 CPU/内存/磁盘做硬编码阈值比较，返回 `Alert[]` | 传入 SystemHealthSnapshot | 超阈值返回对应 Alert，未超阈值返回空数组 | CPU load > cores → critical；heap > 80% → warning；disk > 90% → critical | — |
| AC-4.5 | `runGC()` 清理 stale worktrees、session 文件 | 调用时 | 返回 `GCResult` 含清理项列表 | 无可清理项 → 返回空列表 | — |
| AC-4.6 | Monitor 5min 轮询仍工作（删 LLM 后功能不受影响） | 删除 LLM 调用后 | Monitor Agent `check()` 和 `start()` 循环正常执行 | — | 轮询循环暂保留（Phase 2 迁移） |
| AC-4.7 | 所有 Monitor 测试通过 | 修改后 | `pnpm test -- --testPathPattern=monitor` 全部通过 | monitor-agent-cpu.test.ts + monitor-agent-resilience.test.ts 均通过 | — |

**不做**：Monitor 轮询循环暂保留（Phase 2 迁移到 THRESHOLD trigger）。不调整阈值和频率。

---

## AC Group 5: Auditor Agent 去 LLM + 纯代码 OKR 提案

**covers**: [S-07]

**目标**：删除 Auditor Agent 中 LLM 调用（diagnoseRootCause + aggregateDiagnosticSignals），Circuit 7 改为纯代码 WorkUnit 创建。

| # | AC | Trigger Condition | Expected Behavior | Edge Cases | Exclusions |
|---|-----|-------------------|-------------------|------------|------------|
| AC-5.1 | Auditor Agent 中 `modelGateway` 调用为 0 | 删除 LLM 调用后 | `grep modelGateway auditor-agent.service.ts` → 0 matches | 检查 import 和注释 | — |
| AC-5.2 | `diagnoseRootCause()` 和 `aggregateDiagnosticSignals()` 方法删除 | 删除方法后 | `grep -E 'diagnoseRootCause|aggregateDiagnosticSignals' auditor-agent.service.ts` → 0 matches | — | — |
| AC-5.3 | Circuit 7 达成率 < 60% && 趋势 ≤ 0 → 直接创建 okr_proposal WorkUnit（不调 LLM） | 检测到低达成率 + 负/零趋势 | 调用 WorkUnitService 创建工作单元，不调用 `diagnoseRootCause()` | 达成率 = 60% → 不触发；趋势 > 0 → 不触发 | — |
| AC-5.4 | 创建的 WorkUnit metadata 包含 `{attainment, trend, currentValue, targetValue, historyCount}` | WorkUnit 创建时 | metadata 字段包含全部 5 个属性，类型正确 | — | — |
| AC-5.5 | 创建的 WorkUnit `diagnosis` 字段为 `null` | WorkUnit 创建时 | 断言 `workUnit.diagnosis === null` | — | — |
| AC-5.6 | 纯代码审计功能不受影响 | 删除 LLM 后 | 执行统计、技能分析、OKR 跟踪、eval case 生成、Resolution 创建、doc-freshness 均正常工作 | — | — |
| AC-5.7 | 所有 Auditor 测试通过 | 修改后 | `pnpm test -- --testPathPattern=auditor` 全部通过 | Circuit 7 测试用例更新以匹配纯代码 WorkUnit 创建 | — |

**不做**：Auditor 24h 轮询暂保留（Phase 2 迁移到 EVENT trigger）。不调整审计逻辑。

---

## AC 与文件映射

| AC | 主要文件 | 辅助文件 | 验证命令 |
|----|---------|---------|---------|
| AC-1.1 | `data-analyst-agent.service.ts` | — | `ls path 2>/dev/null; echo $?` → 非 0 |
| AC-1.2 | `data-analyst-agent.service.test.ts` | — | `ls path 2>/dev/null; echo $?` → 非 0 |
| AC-1.3 | `index.ts` | — | `grep dataAnalyst index.ts` → 0 matches |
| AC-1.4 | — | 全 `src/` 目录 | `grep -r knowledge:data_analysis src/` → 0 |
| AC-1.5 | — | 全量测试套件 | `pnpm test` exit code = 0 |
| AC-1.6 | `data-analyst-agent.md` | — | `ls path 2>/dev/null; echo $?` → 非 0 |
| AC-2.1 | `anomaly-detector.ts` | `studio-shared/src/index.ts` | `ls` + `grep export` |
| AC-2.2 | `anomaly-detector.ts` | — | `grep "^import "` → 仅标准库 |
| AC-2.3 | `anomaly-detector.test.ts` | — | test count ≥ 18 (6 functions × 3) |
| AC-2.4 | `anomaly-detector.test.ts` | `anomaly-detector.ts` | 测试断言验证 |
| AC-2.5 | `anomaly-detector.test.ts` | `anomaly-detector.ts` | 测试断言验证 |
| AC-2.6 | `anomaly-detector.test.ts` | `anomaly-detector.ts` | 测试断言验证 |
| AC-2.7 | `anomaly-detector.test.ts` | `anomaly-detector.ts` | 测试断言验证 |
| AC-2.8 | `anomaly-detector.test.ts` | `anomaly-detector.ts` | 测试断言验证 |
| AC-2.9 | `studio-shared/src/index.ts` | — | grep 确认 barrel export |
| AC-3.1 | `okr-anomaly-detector.ts` | — | `ls` exit code = 0 |
| AC-3.2 | `okr-anomaly-detector.ts` | `KRHistory` model | 测试验证 |
| AC-3.3 | `okr-anomaly-detector.ts` | `studioEvent` | 测试验证 |
| AC-3.4 | `okr-anomaly-detector.ts` | `studioEvent` | 测试验证 |
| AC-3.5 | `okr-anomaly-detector.ts` | — | 测试验证 |
| AC-3.6 | `okr-anomaly-detector.ts` | — | `grep -E` → 0 matches |
| AC-3.7 | `schema.prisma` | — | `grep "model KRHistory"` |
| AC-3.8 | `default-triggers.ts` | — | grep trigger id |
| AC-4.1 | `monitor-agent.service.ts` | — | `grep modelGateway` → 0 |
| AC-4.2 | `system-health.ts` | — | `ls` + `grep export` |
| AC-4.3 | `system-health.ts` | — | 测试验证 |
| AC-4.4 | `system-health.ts` | — | 测试验证 |
| AC-4.5 | `system-health.ts` | — | 测试验证 |
| AC-4.6 | `monitor-agent.service.ts` | — | 集成测试 |
| AC-4.7 | `monitor-agent.service.ts` | `__tests__/` | `pnpm test -- --testPathPattern=monitor` |
| AC-5.1 | `auditor-agent.service.ts` | — | `grep modelGateway` → 0 |
| AC-5.2 | `auditor-agent.service.ts` | — | `grep` → 0 |
| AC-5.3 | `auditor-agent.service.ts` | `WorkUnitService` | 测试验证 |
| AC-5.4 | `auditor-agent.service.ts` | `WorkUnitService` | 测试验证 |
| AC-5.5 | `auditor-agent.service.ts` | — | 测试断言 |
| AC-5.6 | `auditor-agent.service.ts` | 全部审计模块 | 测试验证 |
| AC-5.7 | `auditor-agent.service.ts` | `__tests__/` | `pnpm test -- --testPathPattern=auditor` |
