# 管线自举完整分析 — 2026-05-24

## 执行概况

| 维度 | 数据 |
|------|------|
| Goal | `cmpintldp` → `succeeded` |
| 需求 | harness trace 写入 (pipeline-⑨) |
| 阶段完成 | Channel → Analyst → Goal → Executor(3/4) → 自动approved |
| 未完成 | stepIndex 999 integration pending |
| 总耗时 | ~35 min (wall clock) |
| 总 API 耗时 | ~19.7 min |
| 总执行耗时 | ~18.7 min |
| 会话轮次 | 1 + 57 + 67 = 125 turns |
| Token | 188K in / 55K out / 7.9M cache read |
| 总费用 | $6.42 (deepseek-v4-pro) |
| 测试覆盖 | 58 tests (11+20+22+5 复用), 全部通过 |

## 逐阶段分析

### Stage 0: Channel → Analyst (6.6 min, $2.43)

**流程正常：**
1. POST message → @Analyst detection → fire-and-forget import → daemon.submitJob()
2. Daemon session `6aac2a39` 已存在，`--continue` 提交 prompt
3. Claude 分析 399s → output.json (3 AC groups, 14 ACs)
4. RequirementsDoc card 投递到 #研发 channel
5. 手动触发 `start_execution` → Goal 创建

**问题 1: 需要手动点击 start_execution**
- RequirementsDoc 生成后自动变为 `ready` 状态，等待人工确认
- 在白天的开发流程中这是合理的（人在 Discord 上），但在自动化自举场景中这是个阻塞点
- 建议：对于来自 CLI (`studio run`) 的请求，自动触发 start_execution

**问题 2: Analyzer 知识上下文过大**
- knowledge.md 905 行，包含多个历史分析的全部细节
- Analyst 在分析时读取了 101K input tokens（不含 cache）
- 大量历史知识（JWT/OAuth 片段、P0.3 分析）与当前任务无关
- 建议：对历史知识做相关性过滤，按 namespace 隔离历史分析

### Stage 1: Goal Creation

**流程正常：**
- 3 AC groups → 4 step executions (step 0/1/2 + integration 999)
- 所有 3 个 step 在 16ms 内同时创建 (timestamp 1609/1617/1625)

**问题 3: 4 个 step execution 但只有 3 个起作用**
- step 0/1/2 对应对 3 个 AC groups
- step 999 (integration) 从未运行，status=pending
- Goal status 已标记 succeeded，但 integration step 被遗留

### Stage 3: Agent Executor (3 steps, $6.42)

#### Step 0 — AC1: TracePipelineService writeTrace (7.0 min, $2.43)

**执行内容：**
- 修改 `trace-pipeline.service.ts` (新增 writeTrace/TraceRecord)
- 创建 `__tests__/trace-pipeline.test.ts` (11 tests pass)
- AC1.1-AC1.4 全部通过

**严重问题 4: Step 0 产生了重复工作**
- Step 0 创建了 `__tests__/trace-pipeline.test.ts`
- Step 1 又创建了 `tests/services/trace-pipeline.service.test.ts`
- **两个测试文件测试同一服务，路径不同、内容不同**
- Step 1 也在 `trace-pipeline.service.ts` 中重新添加了 `writeTrace()` 方法
- 根因：AC 分解假设 step 之间无共享文件，但 step 0 和 step 1 都修改了同一文件

#### Step 1 — AC2: agent-event-listener.ts hook (7.4 min, $1.77, 57 turns)

**执行内容：**
- agent-event-listener.ts: 添加 tracePipeline import + writeTrace 调用
- 重新修改 trace-pipeline.service.ts (添加 writeTrace 方法)
- 创建 `tests/services/trace-pipeline.service.test.ts` (5 tests)
- agent-event-listener.test.ts: 15/15 pass

**问题 5: tokenUsage 硬编码为 null**
- `tokenUsage: null` 因为事件路径不含 token 数据
- ExecutionResult 类型无 `totalTokens` 字段
- 这是设计性缺口，不是实现缺陷

#### Step 2 — AC3: goal.service.ts hook (11.2 min, $2.23, 67 turns)

**执行内容：**
- goal.service.ts handleGoalSucceeded(): 插入 writeTrace('review', ...)
- trace-pipeline.service.ts: 再次添加 writeTrace (第 3 次)
- 创建 `apps/api/tests/review-trace.test.ts` (22 tests pass)
- AC3.1-AC3.5 全部通过

**问题 6: 第三次修改同一文件**
- Step 0、Step 1、Step 2 都修改了 `trace-pipeline.service.ts`
- 每次都"新增 writeTrace 方法"，产生 git merge 冲突风险
- 每个 step 被迫重新实现已有代码

### Stage 4: Reviewer — 跳过

**Goal 自动 approved，没有经过 Reviewer 审查。**

**问题 7: Reviewer 未触发**
- Goal status = `succeeded` 但没有 Reviewer activity
- GoalScheduler 直接标记 succeeded（所有 execution steps 完成）
- Reviewer 的触发机制需要检查：是否依赖不活跃的事件路径

## 根因分析

### 结构性缺陷

**A. AC 组拆分粒度失误 (核心根因)**

Analyst 将任务拆为 3 个 AC 组 (ac1/ac2/ac3)，假设各组修改不同文件：
- ac1: trace-pipeline.service.ts
- ac2: agent-event-listener.ts
- ac3: goal.service.ts

但实际上 ac2 和 ac3 不能独立工作——它们都依赖 ac1 创建的 `writeTrace()` 方法。每个 executor 在新的 worktree 中从 HEAD 出发，发现 `writeTrace()` 不存在，于是自己实现。这导致：
- 同一文件被修改 3 次
- 3 套不同的测试文件测试同一服务
- 每个 step 多花了 30-50% 时间在"补充缺失依赖"

**正确做法：** 单 AC 组 "创建 TracePipeline + hook 两个调用点"，或 3 个 AC 组共享同一个 worktree（但有 merge 冲突风险）。

**B. 执行路径分裂**

代码中存在两条 Agent 执行路径：
- **事件路径** (休眠): AgentCompleter.complete() → eventBus → AgentEventListener
  - `AgentCompleter.complete()` 在代码库中 **0 次调用**
- **直接路径** (活跃): GoalScheduler → AgentExecutor.execute() → ExecutionResult

实际数据流走直接路径，但 hook/trace 设计假设走事件路径：
- `afterAgentComplete` hook 在 agent-event-listener.ts:481，但只在 AgentCompleter 发事件时触发
- GoalScheduler 直接处理 `ExecutionResult`，不经过 eventBus
- tokenUsage 在两个路径中均不可用

**C. 数据库分裂**

API 重启时 `DATABASE_URL=file:./data.db` 创建了新的空库 (`packages/studio-prisma/prisma/data.db`)，而历史数据在 `~/.studio/data/data.db`。管线自举的 Goal/Executions/PipelineRun 写入了新库，但旧数据（老的 analyzing Goal）仍在旧库中。API 的 pipeline/status 端点查询新库，看到的是不完整状态。

**D. PipelineRun 指标空洞**

最新 PipelineRun 记录的 inputTokens/outputTokens 均为 0：
```
cmpiojqa5001twr3giuehkg45 | executor | success=1 | durationMs=681656 | inputTokens=0 | outputTokens=0
```
尽管 step 1 和 step 2 分别消费了 61093 和 58386 input tokens。

## 根因分析（逐层递进）

### 第一层：表层现象

观察到的差异：管线 35min / $6.42 vs 直接开发 3min / $0。

表层原因：3 个 step 各做了重复工作 → 3 倍冗余。但这只是第一层。

### 第二层：为什么会有重复工作?

**核心根因 R1：worktree 隔离模型与 AC 依赖方向的冲突**

```
Scheduler 的行为：
  AC1 → worktree-A (从 HEAD 创建) → 实现 writeTrace() → succeeded
  AC2 → worktree-B (从 HEAD 创建) → writeTrace() 不存在 → 重新实现
  AC3 → worktree-C (从 HEAD 创建) → writeTrace() 不存在 → 重新实现
```

Scheduler 假设 AC 组之间完全独立，但 AC2/AC3 依赖 AC1 的输出（writeTrace 方法）。git worktree 隔离保证了并行安全，但也切断了依赖链。这不是"AC 拆分错了"，这是一个**架构层面的冲突**：并行隔离 vs 增量依赖。

**正确行为应该是：**
```
  AC1 → worktree-A → 实现 writeTrace() → commit → push
  AC2 → worktree-A（同一个！）→ git pull → 实现 agent-event-listener hook → commit
  AC3 → worktree-A（同一个！）→ git pull → 实现 goal.service hook → commit → push
```

或者更激进的：
```
  AC1+AC2+AC3 → worktree-A → 一次性实现全部
```

### 第三层：即使没有重复工作，为什么一个 step 也要 7-11 分钟？

拆解 Step 1（最典型的正常执行）的 7.4 分钟：

| 阶段 | 耗时 | 占比 | 行为 |
|------|------|------|------|
| Session 启动 | ~15s | 3% | git worktree add, claude 启动 |
| 上下文加载 | ~120s | 27% | 读 CLAUDE.md, package.json, 浏览代码 |
| 理解任务 | ~80s | 18% | 读 progress.json, 读 AC, 理解需求 |
| 测试先行 | ~60s | 14% | 写测试, npm test（确认RED） |
| 实现代码 | ~90s | 20% | 写 import, writeTrace 调用 |
| 测试验证 | ~50s | 11% | npm test（确认GREEN）, type check |
| 写进度 | ~30s | 7% | 更新 .progress.json, 写 notes |

**57 轮对话中的分布：**
- 代码库探索（read/grep）：~18 轮 (32%)
- 测试编写/运行：~12 轮 (21%)
- 代码编写：~8 轮 (14%)
- 验证/修复：~10 轮 (18%)
- 进度/文档：~4 轮 (7%)
- 纯思考等待（API latency）：~5 轮 (9%)

**核心根因 R2：上下文重建是最大的单项成本**

每个 step 都从零开始探索代码库。Step 1 的 input tokens = 60,993（不含 cache），cache read = 2,104,320。后面的 2.1M cache read tokens 代表了"已经在之前加载过的代码"，但**加载这些 cache tokens 仍然消耗了 API 往返时间**。

对比人类开发者：
- 人类：上下文在脑中，3 个文件改完就完
- Pipeline：3 个 step × 各自从零加载 = 3 × 上下文重建成本

**上下文重建 = (session 启动 + 代码探索 + 任务理解) ≈ 215s / step ≈ 49% 的总执行时间**

### 第四层：为什么上下文重建这么贵？

**核心根因 R3：模型 tier 一刀切，全量上下文不分任务大小**

所有 3 个 step 使用 `deepseek-v4-pro[1m]`（百万上下文模型）：
- 每个 step 的 cache read = 2.1M - 3.0M tokens
- 这些 cache token 的传输/处理时间 = API 延迟的主要来源
- 模型收到 request → 解压 3M cache tokens → 推理 60K new tokens → 输出 16K tokens

**但 Step 0 只需要验证（1 turn, 68 output tokens），为什么要 1M 上下文的模型？**

核心问题：**Scheduler/Goal 没有根据 AC 组的复杂度选择合适的模型 tier。**

| Step | 实际复杂度 | 用了什么 | 应该用什么 |
|------|-----------|---------|-----------|
| 0 | 验证已有代码 (1 turn) | deepseek-v4-pro[1m] | deepseek-v4-pro |
| 1 | 中等实现 (57 turns) | deepseek-v4-pro[1m] | 可以接受 |
| 2 | 中等实现 (67 turns) | deepseek-v4-pro[1m] | 可以接受 |

如果 Step 0 用标准模型（无 1M 上下文），API 往返延迟可以降到 ~30s（节省 6+ 分钟）。

### 第五层：会话策略的选择错误

**核心根因 R4：daemon 为每个 step 创建全新 session**

```
Step 0: --session-id de23ee37... (新 session)
Step 1: --session-id 2fd74c28... (另一个新 session)
Step 2: --session-id 8980d660... (又一个新 session)
```

3 个全新 session = 3 次上下文重建。而 daemon 对 Analyst 使用的正是 `--continue`（复用 session）——这是对的技术，但用错了地方。

Analyst 需要 `--continue` 因为后续分析依赖前面积累的知识。

Executor steps 其实更需要 `--continue`：3 个 step 都在同一个代码库上工作，step 2 应该继承 step 1 的代码库理解。但目前 Scheduler 为每个 step 分配独立的 `--session-id`。

**为什么不复用 session？**
- 架构担忧：session 缓存跨 step 共享可能导致幻觉（把 step 1 的修改"记"成 step 2 的上下文）
- 但实际上：3 个 step 在**同一个代码库的同一个任务**上工作，共享上下文是正确的
- 正确的做法：同一个 Goal 的所有 step 共享一个 session，通过 `--session-id` 复用

### 第六层：固定成本 vs 可变成本的经济学

把所有成本摊开：

```
                    Step 0    Step 1    Step 2    总计      占比
固定成本（每step）:
  上下文重建        ~180s     ~200s     ~220s     600s      51%
  session启动       ~15s      ~15s      ~15s       45s       4%
  API往返延迟       ~100s     ~80s      ~120s     300s      25%

可变成本（实际工作）:
  代码实现          ~3s       ~90s      ~80s      173s      15%
  测试运行          ~0s       ~60s      ~50s      110s       9%
  进度更新          ~2s       ~30s      ~30s       62s       5%

额外浪费:
  重复实现writeTrace ~0s      ~30s      ~40s       70s       6%
  Step 0 空转       ~418s     --         --       418s       -- （不算入%）
```

**固定成本占总执行时间的 ~76%（不含 Step 0 空转）。** 这是 LLM 管线与人类开发的本质差异：

- 人类开发者：固定成本 ≈ 0（上下文在脑中）
- LLM 管线：固定成本 = session启动 + 上下文重建 + API 往返 = 成本的 75-80%

这意味着：**管线在小任务上永远不可能比人类快。** 管线的优势在：
1. 人类不愿意做的任务（批量重复、跨夜守护）
2. 任务规模大到固定成本被摊薄（> 2h 工作量）
3. 知识自动化沉淀（人类不会做）

### 第七层：那为什么还要管线自举？

这是被问"差距明显"时要回答的核心问题。管线不是为了**替代**直接开发，而是为了提供直接开发**不会产生**的产物：

| 管线独有的产物 | 直接开发 |
|--------------|---------|
| RequirementsDoc 结构化需求 | 无 — 依赖人工理解 |
| AC 逐条验证 + 58 automated tests | 无 — P0.A 只有 14 个已有测试 |
| Agent log（每一步决策可追溯） | 无 — 只有 git commit |
| knowledge.md 自动更新（新章节写入） | 无 — 需要手动写 memory |
| PipelineRun metrics（全链路可量化） | 无 |
| 跨 session 知识传递（KK反馈） | 无 |

管线自举不是为了提高**速度**，而是为了建立**质量门槛和可追溯性**。问题在于当前管线的固定成本太高，导致"速度代价 > 质量收益"。需要降低固定成本，让管线的质量优势变得"值得等"。

---

## 根因汇总

| # | 根因 | 层级 | 浪费 | 本质 |
|---|------|------|------|------|
| **R1** | worktree 隔离 vs AC 依赖冲突 | 架构 | writeTrace 实现 3 次 (+70s, +$2) | git worktree 假设并行独立 |
| **R2** | 上下文重建 | 经济学 | 600s (51% total) | LLM 无持久上下文 |
| **R3** | 模型 tier 一刀切 | 调度 | Step 0 用 1M 模型做验证 (418s) | Scheduler 无复杂度评估 |
| **R4** | session 不复用 | daemon | 3 个新 session = 3 次重建 | 同一 Goal 的 step 无需隔离 |
| **R5** | 固定成本主导小任务 | 经济学 | 76% 是固定成本 | LLM 管线本质属性 |

## 优化建议（按 ROI 排序）

### P0 — 高 ROI，低改动成本

| # | 修复 | 原理 | 预期收益 |
|---|------|------|---------|
| P0-1 | **同 Goal 内共享 session** | R4: 3 个 step 继承同一个 `--session-id`，step 2 不再探索代码库 | -120s (-10%) |
| P0-2 | **按 AC 复杂度选模型** | R3: Scheduler 检测 AC 组复杂度（文件数 × 修改范围），简单任务用 fast model | Step 0: -390s (-33%) |
| P0-3 | **合并有依赖的 AC 组** | R1: 当 AC2 的 `dependsOn=[AC1]` 时，共享 worktree | writeTrace 只实现 1 次，-70s (-6%) |
| P0-4 | **start_execution 自动触发** | CLI `studio run --auto-start` | 消除人工等待 |

### P1 — 中 ROI，中改动成本

| # | 修复 | 原理 |
|---|------|------|
| P1-1 | knowledge.md 分段注入 | 按 namespace 隔离历史分析，Analyst 只加载相关章节 |
| P1-2 | Analyst 缓存 RequirementsDoc | 相似需求复用已有分析结构 |
| P1-3 | 并行执行真正独立的 AC | 当 AC 组 `dependsOn=[]` 互不依赖时，真正并行启动 Claude |

### P2 — 长期结构优化

| # | 修复 |
|---|------|
| P2-1 | 事件路径清理：删除 AgentCompleter 或激活 |
| P2-2 | PipelineRun metrics 修复 |
| P2-3 | 统一数据库路径 |

---

## 管线自举 vs 直接开发（修正版对比）

| 维度 | 管线自举 | 直接开发 | 修正后（P0修复后预估） |
|------|---------|---------|---------------------|
| 耗时 | 35 min | 3 min | **~15 min** |
| 费用 | $6.42 | $0 | **~$3.50** |
| 测试 | 58 tests, AC 逐条 | 14 tests | 58 tests |
| 可追溯 | PipelineRun + logs | git only | PipelineRun + logs |
| 知识沉淀 | knowledge.md 更新 | 无 | knowledge.md 更新 |
| 重复工作 | writeTrace × 3 | 无 | writeTrace × 1 |
| 上下文重建 | 3 次 | 0 | 1 次 |
| 模型选择 | 全 1M context | — | 自适应 tier |

**结论修正：**

1. 管线自举的慢**不是 bug，是 LLM 管线的固定成本经济学**。76% 的时间花在上下文重建和 API 往返上，这不是"改个 AC 拆分"能修好的。

2. 但固定成本**可以大幅降低**：共享 session (R4) + 自适应 tier (R3) + 合并依赖 AC (R1) 可以把耗时从 35min 降到 ~15min，费用从 $6.42 降到 ~$3.50。

3. 管线的核心价值**不是速度替代**，而是产生了直接开发不会产生的资产（结构化需求、自动验证、知识沉淀、可追溯决策）。当前需要在"速度代价 vs 质量收益"之间找到平衡点。

4. 对于小任务（< 1h 直接开发），管线**永远不应该被用于替代直接开发**。管线应该用于：人类不在线时的自动化任务、需要多轮审查的复杂任务、需要知识积累的重复性工作。这是定位问题，不是性能问题。

---

## 管线自举暴露的全量问题 (Q1-Q8)

### Q1: Reviewer 未触发 — Goal 直接 succeeded 跳过审查

**表现**: 3 个 execution step 全部 succeeded → Goal 直接 succeeded，无 Reviewer 活动

**根因链**:
```
handleGoalSucceeded()                                    [goal.service.ts:612]
  → findReviewWorktree()
    → 查 integration step (stepIndex=999) — 不存在     (Q2导致)
    → 回退查任一 succeeded step — worktree 目录已被删除
  → 返回 null
  → 静默跳过 review                                     [goal.service.ts:631-635]
  → finalizeGoalSucceeded()
  → deployAgent.deploy()
  → cleanupTaskBranches() — rm -rf 所有 worktree        [deploy-agent.service.ts:322-335]
```

**关键代码** `goal.service.ts:631-635`:
```ts
if (!worktree) {
  logger.warn('[Goal] No review worktree found, proceeding to PR', { goalId });
  await this.finalizeGoalSucceeded(goalId);  // ← 跳过审查，直接部署
  return;
}
```

**修复**: worktree 为 null 时不静默跳过，改为 `goalStatus='blocked'` + 上报 TriageAgent

---

### Q2: Integration step 遗孤 — stepIndex 999 永远 pending

**表现**: `cmpiojqap001vwr3g1wozdiol` status=pending，从未执行

**根因**: `goal-scheduler.ts:processGoal()` 的竞态:
```ts
// 173-180
const results = await Promise.allSettled(
  toDispatch.map(exec => this.dispatchStep(exec, goal).catch(...)),
);
await this.checkAllStepsCompleted(goalId);  // ← 在 goal 已 succeeded 后才创建
```

**时序**:
1. `dispatchStep(C)` → `updateStepExecution(succeeded)` → `checkGoalCompletion()` → 标记 goal='succeeded'
2. `checkAllStepsCompleted()` → 创建 integration step (stepIndex=999)
3. 下一轮 poll 只查 `status='executing'` 的 goal → `'succeeded'` 的 goal 不再出现

**修复**: `checkAllStepsCompleted()` 移到 `dispatchStep` 完成之前，或在 `checkGoalCompletion` 中等待 integration step

---

### Q3: worktree 依赖继承 — AC 组之间不共享代码

**表现**: writeTrace 被 3 个 step 各自实现 3 次，3 套不同签名、3 套测试文件

**根因**: `createWorktree()` 永远从 `main` 分支，Scheduler 不传 `baseBranch`:
```ts
// agent-executor.ts:137
const baseBranch = (task.parameters?.baseBranch as string) || 'main';
// Scheduler 传参中无 baseBranch → 回退到 'main'
```

**PMO 设计关系**: workspace-daemon-design §五 — 公司项目 worktree 从 PMO 分支 (`DUJIA-xxxx`) 出发，服务器项目从 `main` 出发。Q3 的依赖继承是**第二层**：有依赖 → 用依赖 step 的 task branch（覆盖 PMO branch）；无依赖 → 用 PMO branch（fallback main）。两者正交不冲突。

**修复** `goal-scheduler.ts:525-535`: 对 `dependsOn` 非空的 step，从 DB 查依赖 step 的 executionId → 构造 `baseBranch = task/<dep-execution-id>`

---

### Q4: 模型 tier 一刀切 — 简单任务用 1M 上下文模型

**表现**: Step 0（1 turn 验证）用 `deepseek-v4-pro[1m]`，418s API 耗时，$2.43

**根因**: Scheduler 无复杂度评估，所有 AC 组用同一 `model` 参数

**修复**: 按 AC 组文件数/修改范围分级:
- 简单 (≤2 files, 无新建) → `fast`
- 中等 (3-5 files) → `standard`
- 复杂 (>5 files 或新建包) → `premium`

---

### Q5: PipelineRun metrics 全 0

**表现**: 最新 PipelineRun 记录 `inputTokens=0, outputTokens=0, durationMs=681656`

**根因**: `recordPipelineRun()` 写入时未从 agent log JSON 的 `modelUsage` 提取 token 数据

**修复**: Executor 完成后从 `.agent.log` JSON 提取 `modelUsage.inputTokens/outputTokens`，传入 `recordPipelineRun()`

---

### Q6: 数据库路径分裂

**表现**: 管线自举数据写入 `packages/studio-prisma/prisma/data.db`，历史数据在 `~/.studio/data/data.db`

**根因**: API 重启时 `DATABASE_URL=file:./data.db` 相对路径 → Prisma 解析到 packages/studio-prisma/prisma/

**修复**: API 启动时用绝对路径 `~/.studio/data/data.db`，从 `studio up --config` 或环境变量统一读取

---

### Q7: knowledge.md 上下文过大

**表现**: 905 行全量注入 Analyst，含多个无关历史分析（JWT/OAuth 片段、P0.3 分析等）

**根因**: 知识按时间追加，无分段/剪枝机制

**修复**: knowledge.md 按 namespace 分段（用 `---` 分隔符），Analyst 构建 prompt 时只注入相关章节

---

### Q8: start_execution 需手动触发

**表现**: RequirementsDoc card 投递后状态 `ready`，等待人工点击

**根因**: CLI `studio run` 无 `--auto-start` flag

**修复**: CLI 加 `--auto-start`，自动调 `POST /messages/:id/actions { action: "start_execution" }`

---

## 修复状态

| # | 标题 | 状态 | 修复日期 |
|---|------|:--:|------|
| R4/Q- | 同 Goal 共享 session | ✅ | 2026-05-24 |
| Q1 | Reviewer 触发修复 | ⏳ | — |
| Q2 | Integration step 竞态 | ⏳ | — |
| Q6 | 数据库路径统一 | ⏳ | — |
| Q3 | worktree 依赖继承 | 📋 | — |
| Q5 | PipelineRun metrics | 📋 | — |
| Q4 | 自适应模型 tier | 📋 | — |
| Q7 | knowledge.md 剪枝 | 📋 | — |
| Q8 | auto start_execution | 📋 | — |
