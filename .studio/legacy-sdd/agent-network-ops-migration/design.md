---
status: done
version: "1.0"
slug: agent-network-ops-migration
title: Agent Network 运维层重构：Monitor/Auditor/DataAnalyst 迁移 — 设计
created: 2026-07-13
tags:
  - agent-network
  - migration
  - design
  - llm-removal
---

## 文件映射表

| AC Group | 文件 | 变更类型 | 备注 |
|----------|------|---------|------|
| 1 | `studio/apps/api/src/modules/agents/data-analyst-agent.service.ts` | 删除 | 完整文件删除 |
| 1 | `studio/apps/api/src/modules/agents/__tests__/data-analyst-agent.service.test.ts` | 删除 | 完整文件删除 |
| 1 | `studio/docs/specs/agents/data-analyst-agent.md` | 删除 | 完整文件删除 |
| 1 | `studio/apps/api/src/index.ts` | 修改 | L26-28 删除 import，L166-168 删除 `dataAnalystAgent.start()` |
| 1 | `studio/CAPABILITIES.md` | 修改 | 删除 L244 data-analyst-agent 条目 |
| 1 | `studio/apps/api/CAPABILITIES.md` | 修改 | 删除 L34 data-analyst-agent 条目 |
| 1 | 全 `src/` 目录 | 验证 | `grep -r "knowledge:data_analysis" src/` → 0 matches（事件类型清零） |
| 2 | `studio/packages/studio-shared/src/stats/anomaly-detector.ts` | 新建 | 6 个纯函数统计模块 |
| 2 | `studio/packages/studio-shared/src/stats/__tests__/anomaly-detector.test.ts` | 新建 | 单元测试 |
| 2 | `studio/packages/studio-shared/src/index.ts` | 修改 | 新增 stats barrel export（after L57） |
| 3 | `studio/apps/api/src/modules/pmo/okr-anomaly-detector.ts` | 新建 | OKR 指标异常检测 |
| 3 | `studio/apps/api/src/modules/pmo/__tests__/okr-anomaly-detector.test.ts` | 新建 | 单元测试 |
| 3 | `studio/packages/studio-prisma/prisma/schema.prisma` | 修改 | 添加 KRHistory model |
| 3 | `studio/apps/api/src/modules/agents/default-triggers.ts` | 修改 | 添加 okr-metric-sync trigger（after L101） |
| 4 | `studio/apps/api/src/modules/agents/system-health.ts` | 新建 | 系统健康采集模块 |
| 4 | `studio/apps/api/src/modules/agents/__tests__/system-health.test.ts` | 新建 | 单元测试 |
| 4 | `studio/apps/api/src/modules/agents/monitor-agent.service.ts` | 修改 | 删除 3 处 LLM 调用（L136-141, L1513-1524, L1584-1595） |
| 5 | `studio/apps/api/src/modules/agents/auditor-agent.service.ts` | 修改 | 删除 `diagnoseRootCause()`（L1484-1536）、`aggregateDiagnosticSignals()`（L1541-1562）；Circuit 7（L680-797）替换 LLM 调用 |

---

## 新模块接口定义

### 2.1 `anomaly-detector.ts` — 公共统计层

**路径**: `studio/packages/studio-shared/src/stats/anomaly-detector.ts`
**原则**: 纯函数，零 I/O，零外部依赖（仅标准库）

```typescript
// ============================================================
// 均值和标准差
// ============================================================
function meanAndStddev(values: number[]): { mean: number; stddev: number }
// 计算: mean = sum/n, stddev = sqrt(sum((x-mean)^2)/n)
// 空数组返回 {mean: 0, stddev: 0}
// NaN 值自动过滤
// 单元素返回 {mean: values[0], stddev: 0}

// ============================================================
// z-score 异常检测
// ============================================================
interface ZScoreResult {
  zScore: number
  isAnomaly: boolean        // |zScore| > threshold (default=2)
  severity: 'normal' | 'warning' | 'critical'
}
// severity 规则: |zScore| > 3 → critical, > 2 → warning, else normal
function zScoreTest(
  current: number,
  baseline: { mean: number; stddev: number },
  threshold?: number        // default: 2
): ZScoreResult
// 当 stddev = 0 时返回 {zScore: 0, isAnomaly: false, severity: 'normal'}

// ============================================================
// 滑动窗口基线
// ============================================================
function rollingBaseline(
  values: number[],
  windowSize?: number       // default: values.length
): { mean: number; stddev: number }
// 取最后 windowSize 个元素计算基线
// windowSize > values.length → 取全部

// ============================================================
// 连续趋势检测
// ============================================================
interface TrendResult {
  direction: 'up' | 'down' | 'stable'
  consecutiveDays: number
}
function detectTrend(
  values: number[],
  minConsecutive?: number   // default: 3
): TrendResult
// 第一天不算（需要比较），从第二天开始看每日差值
// 差值 > 0 → up, < 0 → down
// 连续 minConsecutive 天同向 → 对应方向
// 否则 → stable
// 输入长度 < 2 → {direction:'stable', consecutiveDays:0}

// ============================================================
// 单日突变检测
// ============================================================
interface DeltaResult {
  deltaRatio: number
  isAnomaly: boolean
}
function detectDelta(
  current: number,
  previous: number,
  thresholdRatio?: number   // default: 0.5 (50% 变化)
): DeltaResult
// deltaRatio = |current - previous| / max(|previous|, epsilon)
// previous = 0 → 用 epsilon=0.001 防止除以零

// ============================================================
// 百分位
// ============================================================
function percentile(values: number[], p: number): number
// p 范围 0-100
// 空数组返回 0
// 使用线性插值计算（TypeScript 标准百分位算法）
// p < 0 或 p > 100 → return NaN
```

### 2.2 `okr-anomaly-detector.ts` — OKR 异常检测

**路径**: `studio/apps/api/src/modules/pmo/okr-anomaly-detector.ts`
**原则**: 读 KRHistory → 调 stats 函数 → 写 studioEvent。仅依赖 Prisma + studio-shared/stats。

```typescript
// ============================================================
// 类型定义
// ============================================================
interface AnomalyReport {
  anomalies: AnomalyItem[]
  summary: {
    totalMetrics: number
    anomalyCount: number
    timestamp: Date
  }
}

interface AnomalyItem {
  okrId: string
  krId: string
  currentValue: number
  baseline: { mean: number; stddev: number }
  zScore: number | null
  trend: { direction: 'up' | 'down' | 'stable'; consecutiveDays: number } | null
  delta: { deltaRatio: number; isAnomaly: boolean } | null
  anomalyType: 'zscore' | 'trend' | 'delta'
  detectedAt: Date
}

// ============================================================
// 主入口
// ============================================================
async function detectAnomalies(): Promise<AnomalyReport>
// 1. 查询 KRHistory 最近 7 天记录
// 2. 按 (okrId, krId) 分组，按 timestamp 排序
//    → KRHistory 表为空或查询结果为空：
//      返回 { anomalies: [], summary: { totalMetrics: 0, anomalyCount: 0, timestamp: new Date() } }
// 3. 对每个指标:
//    a. rollingBaseline() 算基线（最后 7 天窗口）
//    b. zScoreTest() 检测当前值是否偏离基线
//    c. detectTrend() 检测连续同向变化
//    d. detectDelta() 检测单日突变
// 4. 异常 → studioEvent.emit('metric:anomaly', anomalyItem)
// 5. 返回完整 AnomalyReport
```

### 2.3 `system-health.ts` — 系统健康采集

**路径**: `studio/apps/api/src/modules/agents/system-health.ts`
**原则**: 从 Monitor Agent 提取的纯代码部分。直接调用 OS API，零 LLM。

```typescript
// ============================================================
// 类型定义
// ============================================================
interface SystemHealthSnapshot {
  timestamp: Date
  cpu: {
    loadAvg: number         // 1 分钟负载均值
    cores: number           // CPU 核心数
  }
  memory: {
    heapUsedMB: number      // Node.js heap 使用量
    percentUsed: number     // 系统内存使用百分比
  }
  disk: {
    percentUsed: number     // 磁盘使用百分比
    path: string            // 监听的磁盘路径
  }
  db: {
    connected: boolean      // 数据库连接状态
    zombieProcesses: number // 僵尸进程数
  }
  workunits: {
    activeCount: number     // 活跃 WorkUnit 数
    stalledCount: number    // 停滞 WorkUnit 数
    overtimeCount: number   // 超时 WorkUnit 数
    failureRate: number     // 失败率 (0-1)
  }
}

interface Alert {
  severity: 'warning' | 'critical'
  category: 'cpu' | 'memory' | 'disk' | 'db' | 'workunit'
  message: string
  currentValue: number
  threshold: number
  timestamp: Date
}

interface GCResult {
  cleaned: number           // 清理项数
  details: string[]         // 清理详情
  duration: number          // 耗时 ms
}

// ============================================================
// 函数签名
// ============================================================

// 采集系统健康快照
async function collectSystemHealth(): Promise<SystemHealthSnapshot>
// CPU: os.loadavg()[0], os.cpus().length
// 内存: process.memoryUsage().heapUsed → MB, /proc/meminfo → 系统内存%
//   → 容器环境 /proc 不可读时回退到 os.totalmem()/os.freemem()
// 磁盘: check-disk-space 或 df 命令解析
// DB: 执行 SELECT 1 检查连接
// WorkUnit: 查询 WorkUnit 表统计

// 阈值检查
async function checkThresholds(snapshot: SystemHealthSnapshot): Promise<Alert[]>
// 硬编码阈值:
//   CPU loadAvg > cores → critical
//   heapUsedMB > 512 → warning
//   memory percentUsed > 80 → critical
//   disk percentUsed > 90 → critical
//   db connected = false → critical
//   workunit stalledCount > 5 → warning
//   workunit failureRate > 0.3 → critical

// GC 清理
async function runGC(): Promise<GCResult>
// 清理 stale worktrees（最后访问 > 7 天）
// 清理临时 session 文件（创建 > 24h）
// 清理已完成的 WorkUnit（按配置保留期）
```

---

## 代码依赖图

```
                           ┌──────────────────────────────┐
                           │     studio-shared/stats/     │
                           │    anomaly-detector.ts       │  ← 零依赖纯函数
                           └──────────┬───────────────────┘
                                      │ import
                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│                 apps/api/src/modules/pmo/                       │
│  okr-anomaly-detector.ts  ─── import → anomaly-detector.ts     │
│         │                                                      │
│         ├── import → prisma (KRHistory query)                  │
│         └── import → studioEvent (emit metric:anomaly)         │
└─────────────────────────────────────────────────────────────────┘
                                      │
                                      │ (triggered by)
                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│            apps/api/src/modules/agents/                        │
│  default-triggers.ts ─── registers ──── SCHEDULE trigger       │
│         │                     │                                │
│         │                     ▼                                │
│         │          Executes → okr-metric-sync                  │
│         │                                                      │
│  system-health.ts ─── pure code, OS API only                  │
│         │                                                      │
│  monitor-agent.service.ts                                     │
│         │                                                      │
│         └── 原调用: collectSystemHealth() → 提取为 system-health│
│         └── LLM 3 处删除: check() L138, dailyReflection()     │
│             L1513, evaluateTrajectory() L1584                  │
│                                                               │
│  auditor-agent.service.ts                                     │
│         │                                                      │
│         └── 删除: diagnoseRootCause(), aggregateDiagnostic()   │
│         └── Circuit 7: LLM call → WorkUnitService.create()    │
└─────────────────────────────────────────────────────────────────┘
                                      │
                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│         studio-prisma/prisma/schema.prisma                     │
│  model KRHistory { ... }  ← 修复缺失的 model 定义              │
└─────────────────────────────────────────────────────────────────┘
```

**依赖规则**:
- `anomaly-detector.ts` → 零依赖（叶子节点）
- `okr-anomaly-detector.ts` → 依赖 `anomaly-detector.ts` + Prisma + eventBus
- `system-health.ts` → 依赖 `os` + `fs` + Prisma（WorkUnit 查询）
- `monitor-agent.service.ts` → 依赖 `system-health.ts`（提取后保留引用点）
- `auditor-agent.service.ts` → 依赖 `WorkUnitService`（Circuit 7 纯代码创建）
- `default-triggers.ts` → 独立，无代码交集

---

## LLM 替换详细设计

### 4.1 Auditor Circuit 7 替换

**旧代码（LLM 版）**:
```
L680-797:
  Circuit 7 → 调 diagnoseRootCause()
    → diagnoseRootCause() 拼接 prompt → modelGateway.promptJson()
    → LLM 返回 {rootCause, suggestedFix, confidence}
    → aggregateDiagnosticSignals() 汇总多个信号
    → 写入 diagnosis 字段
```

**新代码（纯代码版）**:
```
Circuit 7（达成率 < 60% && 趋势 ≤ 0）:
  → 直接调用 WorkUnitService.create({
      type: 'okr_proposal',
      metadata: {
        attainment: number,          // 当前达成率
        trend: 'down' | 'stable',    // 趋势方向
        currentValue: number,        // 当前值
        targetValue: number,         // 目标值
        historyCount: number         // 历史记录数
      },
      diagnosis: null                // 待 Agent 领取后自行诊断
    })
  → 不再调 diagnoseRootCause()
  → 不再调 aggregateDiagnosticSignals()
```

**WorkUnit metadata shape**:
```typescript
type OkrProposalMetadata = {
  attainment: number      // 0-100 百分比
  trend: 'up' | 'down' | 'stable'
  currentValue: number
  targetValue: number
  historyCount: number
}
```

### 4.2 Monitor Agent LLM 删除明细

| 位置 | 行范围 | 删除内容 | 保留内容 | 关联删除 |
|------|--------|---------|---------|---------|
| `check()` | L136-141 | 告警≥2 时调 modelGateway 做根因分析 | 告警收集逻辑、阈值检查 | 关联的 prompt 构造代码 |
| `dailyReflection()` | L1513-1524 | 事件日志 → modelGateway 知识提取 | 事件收集、日志聚合 | 关联的 prompt 构造代码 |
| `evaluateTrajectory()` | L1584-1595 | 会话错误 → modelGateway 模式提取 | 错误收集逻辑 | 关联的 prompt 构造代码 |

**删除原则**: 只删除 modelGateway 调用行及其直接关联的 prompt 构造代码。保留调用者函数结构、错误处理、日志记录。不重构相邻代码。

**集成模式**（Monitor → system-health 调用）:
```
Monitor.check() 中：
  原 checkFailureTrend / checkProgressStagnation 等 → 替换为 system-health 调用
  import { collectSystemHealth, checkThresholds, runGC } from './system-health.js';

  async check() {
    const snapshot = await collectSystemHealth();
    const alerts = await checkThresholds(snapshot);
    // ... 保留 review quality / token budget / deploy proxy 等检查
    // ... 保留 alert 聚合和日志
  }

Monitor GC（原 check 中的 gcStaleWorktrees + dataLifecycle）：
  原直接实现 → 替换为 runGC() 调用
```
保留的 Monitor 检查（纯代码，不调 LLM）：审查质量、Token 预算、Deploy/Proxy、知识库健康。

### 4.3 Auditor Agent 删除明细

| 方法 | 行范围 | 说明 |
|------|--------|------|
| `diagnoseRootCause()` | L1484-1536 | 完整方法删除，含 modelGateway.promptJson() 调用 + 响应解析 + 错误处理 |
| `aggregateDiagnosticSignals()` | L1541-1562 | 完整方法删除（仅被 diagnoseRootCause 使用） |
| Circuit 7 LLM 分支 | L680-797 | 替换 modelGateway 调用为 WorkUnitService.create()，保留 Circuit 7 触发条件逻辑 |

---

## schema.prisma — KRHistory Model

```prisma
model KRHistory {
  id        String   @id @default(cuid())
  krId      String
  okrId     String
  value     Float
  status    String
  timestamp DateTime @default(now())

  @@index([okrId, krId])
  @@index([timestamp])
}
```

**说明**: 迁移 SQL 已存在但 model 定义缺失。只需添加 model 定义，不需要新建迁移。`krId` 和 `okrId` 存原始 ID 字符串而非外键（KR 和 OKR 可能在 Prisma 层级外管理）。`value` 为 Float 兼容百分比和原始数值。`status` 为 String 兼容各种状态标识（on_track/at_risk/behind）。

---

## default-triggers.ts — 新增 Trigger

插入位置: `default-triggers.ts` L101 之后（`knowledge-quality-audit` trigger 之后），`getDefaultTriggerConfigs` 函数返回之前。

```typescript
{
  id: 'okr-metric-sync',
  name: 'OKR Metric Sync',
  condition: { type: 'SCHEDULE', cron: '47 3 * * *' },
  action: { type: 'EXECUTE', target: 'okr-metric-sync', payload: {} },
  scope: 'system',
  enabled: true,
}
```

**时机说明**: 每日 3:47 执行，在 `knowledge-quality-audit`（3:17）之后 30 分钟，确保审计完成后执行指标同步。

---

## CAPABILITIES.md 更新

| 文件 | 操作 | 行号 | 内容 |
|------|------|------|------|
| `studio/CAPABILITIES.md` | 删除 | L244 | DataAnalyst Agent 条目 |
| `studio/apps/api/CAPABILITIES.md` | 删除 | L34 | DataAnalyst Agent 条目 |

删除后不需要额外新增条目（新模块是内部重构，不改变对外能力声明）。
