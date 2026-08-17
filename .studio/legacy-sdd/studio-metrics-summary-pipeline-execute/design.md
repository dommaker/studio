---
id: "cmq9nbhrt00j2ox1vvve76mht"
goalId: "cmq9nbjee00jmox1vjd5r1a5d"
slug: "studio-metrics-summary-pipeline-execute"
title: "studio metrics summary — 管线执行指标总览"
status: "stale"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["cli", "metrics", "pipeline", "observability"]
createdAt: "2026-06-11T15:21:53.845Z"
updatedAt: "2026-06-11T15:21:55.987Z"
---

# studio metrics summary — 管线执行指标总览

在 CLI metrics 命令下新增 summary 子命令，查询 PipelineRun 表按 phase 分组统计最近 24h 执行数据，输出表格和总览

<!-- TASK_TIER {"tier":"fast","reason":"2 文件改动（metrics.ts + studio-cli.ts），无 schema 变更，无跨模块依赖，复用现有 groupBy 模式和 formatTable 工具"} -->

## Architecture Context

**Functions**
- getComparison(taskName: string): Promise<{pipeline?, window?} | null> @ metrics.ts:L170 — 现有查询函数，参考其 prisma 查询模式
- printComparison(pipeline?, window?): string @ metrics.ts:L189 — 现有格式化函数，参考其 formatMs/formatPct 辅助函数
- recordPipelineRun(entry: MetricEntry): Promise<boolean> @ metrics.ts:L62 — 写入函数，不修改
- mapRun(r: any): MetricEntry @ metrics.ts:L232 — 内部映射函数，不修改
- formatTable(data: any[], headers?: string[]): string @ formatter.ts:L47 — 共享表格格式化工具，printSummary 应导入使用

**Call Chain**
studio metrics summary → studio-cli.ts case 'metrics' → if args[1]==='summary' → import { getPhaseSummary, printSummary } from metrics.js → getPhaseSummary() → prisma.pipelineRun.groupBy + findMany → printSummary() → formatTable() → console.log

**Imports**
- import { prisma } from '@dommaker/studio-prisma' (已在 metrics.ts:L2 存在)
- import { formatTable } from '@dommaker/studio-shared' (新增到 metrics.ts，或在 printSummary 内 lazy import)

**Types in Scope**
- MetricEntry @ metrics.ts:L5-L21 — source/phase/taskName/model/inputTokens/outputTokens/cacheHitTokens/durationMs/success 等字段
- PipelineRun (Prisma model) @ schema.prisma L1191-L1213 — id/source/phase/taskName/model/inputTokens/outputTokens/cacheHitTokens/durationMs/success/testPassed/lintPassed/diffLines/error/sessionId/goalId/createdAt

**Test Mocks**
- vi.mock('@dommaker/studio-prisma', () => ({ prisma: { pipelineRun: { groupBy: vi.fn(), findMany: vi.fn(), create: vi.fn() } } }))
- vi.mock('@dommaker/studio-shared', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, formatTable: vi.fn((data, headers) => 'mocked-table') }))

**Danger Zones**
- metrics.ts:L62-L96 recordPipelineRun — 不修改，dead letter 逻辑保持原样
- metrics.ts:L170-L187 getComparison — 不修改
- metrics.ts:L189-L230 printComparison — 不修改，box-drawing 风格保持独立
- studio-cli.ts:L1424-L1432 compare 子命令 — 不修改

## AC Groups

### metrics-summary

#### 实现指南
步骤: 1) metrics.ts 添加 formatDuration 纯函数 — 参考 printComparison:L207 的 formatMs 但输出 XmYs 格式。2) metrics.ts 添加 getPhaseSummary — 参考 auditor-agent.service.ts:L1546 groupBy 模式 + okr.service.ts:L633-L645 goalId 聚合模式。查询1: groupBy(['phase']) with _count/_avg.durationMs/_sum.inputTokens/_sum.outputTokens/_sum.cacheHitTokens，过滤 success 计算成功率。查询2: findMany step runs with goalId，JS 中 group by goalId 求平均。3) metrics.ts 添加 printSummary — 使用 formatTable from '@dommaker/studio-shared' 输出表格。4) studio-cli.ts 添加 if args[1] === 'summary' 分支，lazy import。5) metrics.test.ts 添加测试。

#### 参考模式
- groupBy 模式: auditor-agent.service.ts:L1546 — prisma.pipelineRun.groupBy({ by: ['phase'], where: { createdAt: { gte: since } }, _avg: { durationMs: true }, _count: true })
- goalId 聚合: okr.service.ts:L633-L645 — findMany + JS Map group by goalId + sum durationMs
- CLI 子命令: studio-cli.ts:L1423-L1437 — if (args[1] === 'compare' && args[2]) { ... } else { usage }
- formatMs 辅助: metrics.ts:L207 — (ms) => ms ? `${(ms/1000).toFixed(1)}s` : '-'
- formatPct 辅助: metrics.ts:L209-L212 — (hit, total) => `${((hit/total)*100).toFixed(1)}%`

#### ⚠️ 注意事项
- ⚠️ Prisma groupBy 不支持 computed field — cacheHitRate 需在 JS 层计算: _sum.cacheHitTokens / (_sum.inputTokens + _sum.cacheHitTokens)
- ⚠️ cacheHitRate 分母是 inputTokens + cacheHitTokens（AC4 明确定义），不是 inputTokens — 注意复用 printComparison 中的 cacheHitTokens/inputTokens 算法不同
- ⚠️ 平均 goal 耗时: 不能用 Prisma groupBy 直接算（需要先按 goalId 聚合再求平均）— 参考 okr.service.ts:L633-L645 的 JS 层聚合模式
- ⚠️ formatDuration 需处理负数/NaN — 防御性输入，虽然正常数据不会出现
- ⚠️ studio-cli.ts 用 lazy import (await import) — 新的 getPhaseSummary/printSummary 也必须用 lazy import 模式
- ⚠️ prisma.pipelineRun.groupBy 的 where.createdAt 过滤必须用 { gte: new Date(Date.now() - 24*60*60*1000) } 计算 24h 前时间戳