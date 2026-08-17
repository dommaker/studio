---
id: "cmq9nbhrt00j2ox1vvve76mht"
workUnitId: "cmq9nbjee00jmox1vjd5r1a5d"
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
## Schema First Verification

<!-- INTERFACE_VERIFICATION {"verified":["prisma.pipelineRun.groupBy — Prisma Client 标准 API，auditor-agent.service.ts:L1546 已有使用先例","prisma.pipelineRun.findMany + select — okr.service.ts:L617-L640 已有 goalId 聚合先例","PipelineRun schema: phase(String), success(Boolean), durationMs(Int), inputTokens/outputTokens/cacheHitTokens(Int), createdAt(DateTime), goalId(String?)","CLI case 'metrics' 结构 — studio-cli.ts:L1423-L1437，if/else 子命令模式","formatTable — @dommaker/studio-shared formatter.ts:L47，ASCII 表格格式化","prisma import — metrics.ts:L2 from '@dommaker/studio-prisma'"],"unverified":[],"newRequired":[]} -->

### Verified
- ✅ prisma.pipelineRun.groupBy — Prisma Client 标准 API，auditor-agent.service.ts:L1546 已有使用先例
- ✅ prisma.pipelineRun.findMany + select — okr.service.ts:L617-L640 已有 goalId 聚合先例
- ✅ PipelineRun schema: phase(String), success(Boolean), durationMs(Int), inputTokens/outputTokens/cacheHitTokens(Int), createdAt(DateTime), goalId(String?)
- ✅ CLI case 'metrics' 结构 — studio-cli.ts:L1423-L1437，if/else 子命令模式
- ✅ formatTable — @dommaker/studio-shared formatter.ts:L47，ASCII 表格格式化
- ✅ prisma import — metrics.ts:L2 from '@dommaker/studio-prisma'

## AC Groups

### metrics-summary
<!-- MODEL_TIER {"tier":"fast","reason":"2 文件改动，复用现有 groupBy/formatTable 模式，无 schema 变更，无跨模块依赖"} -->

#### 验收标准
- [ ] AC1: 在 metrics.ts 中添加 getPhaseSummary() 函数；使用 prisma.pipelineRun.groupBy 按 phase 分组查询最近 24h 数据，返回每 phase 的 count/成功率/avgDurationMs/totalTokens/cacheHitRate；无数据时返回空数组；不修改现有 getComparison/recordPipelineRun 等函数
- [ ] AC2: 在 metrics.ts 中添加 formatDuration(ms: number): string 纯函数；将毫秒转为人类可读格式（<60s 显示 Xs，>=60s 显示 XmYs，>=3600s 显示 XhYm）；0ms 显示 '0s'；不引入外部依赖
- [ ] AC3: 在 metrics.ts 中添加 printSummary(phases, overview): string 函数；使用 formatTable 输出 phase/执行次数/成功率/平均耗时/总token/缓存命中率 六列表格；底部输出总览行（总执行次数、总 token、平均 goal 耗时）；缓存命中率计算公式: cacheHitTokens / (inputTokens + cacheHitTokens) × 100%；不修改 printComparison 的 box-drawing 风格
- [ ] AC4: 在 studio-cli.ts L1423 case 'metrics' 中添加 'summary' 子命令分支；lazy import getPhaseSummary + printSummary；无数据时输出 'No pipeline runs in the last 24h'；在 usage 帮助文本中添加 'studio metrics summary' 条目；不改动 'compare' 子命令逻辑
- [ ] AC5: 在 metrics.test.ts 中添加 getPhaseSummary + formatDuration + printSummary 测试；mock prisma.pipelineRun.groupBy 和 findMany；覆盖: 正常多 phase 数据、空数据返回空数组、formatDuration 各段（s/min/h）、缓存命中率 0% 和 100% 边界、总 token 汇总正确

#### 涉及文件
- apps/api/src/daemon/metrics.ts (添加 getPhaseSummary, formatDuration, printSummary)
- apps/api/src/cli/studio-cli.ts L1423-L1437 (添加 summary 子命令分支 + usage 文本)
- apps/api/src/daemon/__tests__/metrics.test.ts (添加测试)
## 约束
- 不修改现有 metrics 函数（getComparison, recordPipelineRun, printComparison 等）
- 不修改 PipelineRun schema
- 不改动 compare 子命令
- formatTable 从 @dommaker/studio-shared 导入，不自建表格格式化
- CLI 子命令用 lazy import 模式（与 compare 一致）
- 缓存命中率公式: cacheHitTokens / (inputTokens + cacheHitTokens) × 100%（AC4 明确定义）

## AC Groups

```json
[
  {
    "id": "metrics-summary",
    "targetRepo": "studio",
    "acs": [
      "AC1: 在 metrics.ts 中添加 getPhaseSummary() 函数；使用 prisma.pipelineRun.groupBy 按 phase 分组查询最近 24h 数据，返回每 phase 的 count/成功率/avgDurationMs/totalTokens/cacheHitRate；无数据时返回空数组；不修改现有 getComparison/recordPipelineRun 等函数",
      "AC2: 在 metrics.ts 中添加 formatDuration(ms: number): string 纯函数；将毫秒转为人类可读格式（<60s 显示 Xs，>=60s 显示 XmYs，>=3600s 显示 XhYm）；0ms 显示 '0s'；不引入外部依赖",
      "AC3: 在 metrics.ts 中添加 printSummary(phases, overview): string 函数；使用 formatTable 输出 phase/执行次数/成功率/平均耗时/总token/缓存命中率 六列表格；底部输出总览行（总执行次数、总 token、平均 goal 耗时）；缓存命中率计算公式: cacheHitTokens / (inputTokens + cacheHitTokens) × 100%；不修改 printComparison 的 box-drawing 风格",
      "AC4: 在 studio-cli.ts L1423 case 'metrics' 中添加 'summary' 子命令分支；lazy import getPhaseSummary + printSummary；无数据时输出 'No pipeline runs in the last 24h'；在 usage 帮助文本中添加 'studio metrics summary' 条目；不改动 'compare' 子命令逻辑",
      "AC5: 在 metrics.test.ts 中添加 getPhaseSummary + formatDuration + printSummary 测试；mock prisma.pipelineRun.groupBy 和 findMany；覆盖: 正常多 phase 数据、空数据返回空数组、formatDuration 各段（s/min/h）、缓存命中率 0% 和 100% 边界、总 token 汇总正确"
    ],
    "files": [
      "apps/api/src/daemon/metrics.ts (添加 getPhaseSummary, formatDuration, printSummary)",
      "apps/api/src/cli/studio-cli.ts L1423-L1437 (添加 summary 子命令分支 + usage 文本)",
      "apps/api/src/daemon/__tests__/metrics.test.ts (添加测试)"
    ],
    "dependencies": [],
    "implementationNotes": "步骤: 1) metrics.ts 添加 formatDuration 纯函数 — 参考 printComparison:L207 的 formatMs 但输出 XmYs 格式。2) metrics.ts 添加 getPhaseSummary — 参考 auditor-agent.service.ts:L1546 groupBy 模式 + okr.service.ts:L633-L645 goalId 聚合模式。查询1: groupBy(['phase']) with _count/_avg.durationMs/_sum.inputTokens/_sum.outputTokens/_sum.cacheHitTokens，过滤 success 计算成功率。查询2: findMany step runs with goalId，JS 中 group by goalId 求平均。3) metrics.ts 添加 printSummary — 使用 formatTable from '@dommaker/studio-shared' 输出表格。4) studio-cli.ts 添加 if args[1] === 'summary' 分支，lazy import。5) metrics.test.ts 添加测试。",
    "architectureContext": {
      "functions": [
        "getComparison(taskName: string): Promise<{pipeline?, window?} | null> @ metrics.ts:L170 — 现有查询函数，参考其 prisma 查询模式",
        "printComparison(pipeline?, window?): string @ metrics.ts:L189 — 现有格式化函数，参考其 formatMs/formatPct 辅助函数",
        "recordPipelineRun(entry: MetricEntry): Promise<boolean> @ metrics.ts:L62 — 写入函数，不修改",
        "mapRun(r: any): MetricEntry @ metrics.ts:L232 — 内部映射函数，不修改",
        "formatTable(data: any[], headers?: string[]): string @ formatter.ts:L47 — 共享表格格式化工具，printSummary 应导入使用"
      ],
      "callChain": "studio metrics summary → studio-cli.ts case 'metrics' → if args[1]==='summary' → import { getPhaseSummary, printSummary } from metrics.js → getPhaseSummary() → prisma.pipelineRun.groupBy + findMany → printSummary() → formatTable() → console.log",
      "imports": [
        "import { prisma } from '@dommaker/studio-prisma' (已在 metrics.ts:L2 存在)",
        "import { formatTable } from '@dommaker/studio-shared' (新增到 metrics.ts，或在 printSummary 内 lazy import)"
      ],
      "typesInScope": [
        "MetricEntry @ metrics.ts:L5-L21 — source/phase/taskName/model/inputTokens/outputTokens/cacheHitTokens/durationMs/success 等字段",
        "PipelineRun (Prisma model) @ schema.prisma L1191-L1213 — id/source/phase/taskName/model/inputTokens/outputTokens/cacheHitTokens/durationMs/success/testPassed/lintPassed/diffLines/error/sessionId/goalId/createdAt"
      ],
      "testMock": [
        "vi.mock('@dommaker/studio-prisma', () => ({ prisma: { pipelineRun: { groupBy: vi.fn(), findMany: vi.fn(), create: vi.fn() } } }))",
        "vi.mock('@dommaker/studio-shared', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }, formatTable: vi.fn((data, headers) => 'mocked-table') }))"
      ],
      "dangerZones": [
        "metrics.ts:L62-L96 recordPipelineRun — 不修改，dead letter 逻辑保持原样",
        "metrics.ts:L170-L187 getComparison — 不修改",
        "metrics.ts:L189-L230 printComparison — 不修改，box-drawing 风格保持独立",
        "studio-cli.ts:L1424-L1432 compare 子命令 — 不修改"
      ],
      "verifiedAt": "36e12f74"
    },
    "codePatterns": [
      "groupBy 模式: auditor-agent.service.ts:L1546 — prisma.pipelineRun.groupBy({ by: ['phase'], where: { createdAt: { gte: since } }, _avg: { durationMs: true }, _count: true })",
      "goalId 聚合: okr.service.ts:L633-L645 — findMany + JS Map group by goalId + sum durationMs",
      "CLI 子命令: studio-cli.ts:L1423-L1437 — if (args[1] === 'compare' && args[2]) { ... } else { usage }",
      "formatMs 辅助: metrics.ts:L207 — (ms) => ms ? `${(ms/1000).toFixed(1)}s` : '-'",
      "formatPct 辅助: metrics.ts:L209-L212 — (hit, total) => `${((hit/total)*100).toFixed(1)}%`"
    ],
    "gotchas": [
      "⚠️ Prisma groupBy 不支持 computed field — cacheHitRate 需在 JS 层计算: _sum.cacheHitTokens / (_sum.inputTokens + _sum.cacheHitTokens)",
      "⚠️ cacheHitRate 分母是 inputTokens + cacheHitTokens（AC4 明确定义），不是 inputTokens — 注意复用 printComparison 中的 cacheHitTokens/inputTokens 算法不同",
      "⚠️ 平均 goal 耗时: 不能用 Prisma groupBy 直接算（需要先按 goalId 聚合再求平均）— 参考 okr.service.ts:L633-L645 的 JS 层聚合模式",
      "⚠️ formatDuration 需处理负数/NaN — 防御性输入，虽然正常数据不会出现",
      "⚠️ studio-cli.ts 用 lazy import (await import) — 新的 getPhaseSummary/printSummary 也必须用 lazy import 模式",
      "⚠️ prisma.pipelineRun.groupBy 的 where.createdAt 过滤必须用 { gte: new Date(Date.now() - 24*60*60*1000) } 计算 24h 前时间戳"
    ],
    "modelTier": "fast",
    "modelTierReason": "2 文件改动，复用现有 groupBy/formatTable 模式，无 schema 变更，无跨模块依赖"
  }
]
```

## Files

- apps/api/src/cli/studio-cli.ts L1423-L1437 (添加 summary 子命令分支 + usage 文本)
- apps/api/src/daemon/__tests__/metrics.test.ts (添加测试)
- apps/api/src/daemon/metrics.ts (添加 getPhaseSummary, formatDuration, printSummary)