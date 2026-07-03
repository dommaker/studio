---
status: implemented
version: "1.0"
created: 2026-06-30
updated: 2026-06-30
source: docs/specs/phase-2-pipeline-value-extraction.md
phase: phase-2-pipeline-value-extraction
ac_groups:
  - AC-1: concurrency-control 提取
  - AC-2: extractAffectedFiles 提取
  - AC-3: forceCommit 提取
  - AC-4: 知识条目 DAG 波次调度
  - AC-5: 知识条目 任务复杂度分类
  - AC-6: 知识条目 级联回滚
  - AC-7: 完整性验证
---

# Phase 2: Pipeline 价值提取 — 需求

## 目标

Pipeline 废弃前，提取 3 个纯函数工具到 `@dommaker/studio-shared`，沉淀 3 篇知识条目。确保经验/算法不随代码消亡。

## AC Groups

### AC-1: concurrency-control 提取

**Files**: `packages/studio-shared/src/utils/concurrency-control.ts`

**触发**: 文件创建并 export 三个函数

**预期**:
- `getDispatchStrategy(recentFailures: number, recentTotal: number): 'normal' | 'conservative'` — 滑动窗口失败率 >50% 且 total >= 5 → conservative
- `getAvailableSlots(maxCap?: number): number` — 资源感知槽位（freeMem < 15% → 1, < 30% → 2, load > 0.9 → 2, default → 5），maxCap 约束上限
- `updateDispatchOutcome(state: { failures: number; total: number }, success: boolean): { failures: number; total: number }` — 滑动窗口计数器，上限 20
- `packages/studio-shared/src/utils/index.ts` 有 re-export
- 纯 Node.js 依赖（os 模块），无 prisma/express/logger

**边界**:
- 无业务逻辑依赖
- 不包含 `logger.info` 调用（原代码有，提取时移除）
- 不包含 `classifyTaskComplexity`（knowledge entry 覆盖）

**不做**: 不集成到 AN（仅提供工具函数）

**测试**: `packages/studio-shared/src/utils/__tests__/concurrency-control.test.ts`
- 失败率 > 50% 且 total >= 5 → conservative
- 失败率 <= 50% 或 total < 5 → normal
- freeMem < 15% → 1 slot
- freeMem < 30% → 2 slots
- load > 0.9 → 2 slots
- default → 5 slots
- maxCap 约束生效
- updateDispatchOutcome 成功/失败/窗口满

---

### AC-2: extractAffectedFiles 提取

**Files**: `packages/studio-shared/src/utils/error-file-extractor.ts`

**触发**: 文件创建并 export

**预期**:
- `extractAffectedFiles(error: string): string[]` — 从错误消息提取去重文件路径
- 3 层 pattern:
  1. tsc: `/(\S+\.ts)\(\d+,\d+\)/g`
  2. test FAIL: `/(?:FAIL|Error:)\s+(\S+\.test\.\S+)/g`
  3. generic fallback: `/(\S+\.ts)(?:\s|$|:)/g`，排除 node_modules/dist
- generic fallback 仅在 layer 1+2 无匹配时启用
- `packages/studio-shared/src/utils/index.ts` 有 re-export

**边界**: 只提取文件路径，不做 file→step 映射

**不做**: 不做 Pipeline step 定位

**测试**: `packages/studio-shared/src/utils/__tests__/error-file-extractor.test.ts`
- tsc 错误格式匹配
- test FAIL 格式匹配
- generic fallback 匹配
- 混合输入去重
- 无匹配返回空数组
- node_modules/dist 排除

---

### AC-3: forceCommit 提取

**Files**: `packages/studio-shared/src/utils/git-utils.ts`

**触发**: 文件创建并 export

**预期**:
- `forceCommit(cwd: string, message: string): { success: boolean; commitHash?: string }`
- 执行 `git status --porcelain` 检查变更
- 无变更 → `{ success: true, commitHash: undefined }`
- 有变更 → `git add -A && git commit -m` → 返回 commitHash
- git identity 用环境变量 `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`，默认 `'Studio'`/`'studio@local'`（不硬编码 Pipeline 身份）
- `packages/studio-shared/src/utils/index.ts` 有 re-export

**边界**: 仅依赖 child_process。不依赖 Pipeline 数据模型

**不做**: 不改变现有调用方（executor-subagent-spawner 仍用内部版本）

**测试**: `packages/studio-shared/src/utils/__tests__/git-utils.test.ts`
- 成功 commit 返回 commitHash
- 无变更返回 undefined commitHash
- message 含引号正确转义

---

### AC-4: 知识条目 — DAG 波次调度

**Files**: `~/.studio/knowledge/pattern-dag-wave-scheduling.md`

**触发**: 文件写入

**预期**:
- 类型: pattern
- 必含段落:
  - 问题：DAG 任务分波次（同波内无依赖可并行）
  - 算法：Kahn 拓扑排序 → 每层一个 wave。DFS 三色检测循环依赖
  - 子波次：同 wave 内按文件重叠拆子波次（避免 merge 冲突）
  - 来源：`scheduler-prompt.ts:analyzeWaves()`
  - 边界说明

**不做**: 不提取为代码

---

### AC-5: 知识条目 — 任务复杂度分类规则

**Files**: `~/.studio/knowledge/pattern-task-tier-routing.md`

**触发**: 文件写入

**预期**:
- 类型: pattern
- 必含段落:
  - 问题：为任务选择模型 tier（fast/standard/premium）
  - 规则：多维分类（tier + category 8 类正则 + AC 数量 + 文件数量 + skill 复杂度）
  - 探索：ε-greedy 10% 降级（auth/schema 豁免）
  - 反馈：历史最佳 tier（≥5 样本）+ 路由质量分析
  - 来源：`scheduler-queue.ts:classifyTaskComplexity()`

**不做**: 不集成到 AN routing

---

### AC-6: 知识条目 — 级联回滚模式

**Files**: `~/.studio/knowledge/pattern-cascade-rollback.md`

**触发**: 文件写入

**预期**:
- 类型: pattern
- 必含段落:
  - 问题：Integration 失败后定位根因 step 并级联重置下游
  - 分类：5 种 failureType（merge_conflict/tsc_error/test_failure/missing_branch/empty_merge）
  - 级联：BFS 从问题 step 沿依赖图反向传播，reset 所有下游为 unassigned
  - 诊断：结构化诊断信息注入下次 execution input
  - 来源：`integration-rollback.ts:rollbackToIntegrationStep()`

**不做**: 不提取 rollback 代码

---

### AC-7: 完整性验证

**触发**: AC-1 到 AC-6 全部完成

**预期**:
- 3 个代码文件存在于 `packages/studio-shared/src/utils/`
- 3 个知识条目存在于 `~/.studio/knowledge/`
- 每个代码文件有对应测试全部通过
- `grep "prisma" packages/studio-shared/src/utils/concurrency-control.ts` → 0 matches
- `grep "prisma" packages/studio-shared/src/utils/error-file-extractor.ts` → 0 matches
- `grep "prisma" packages/studio-shared/src/utils/git-utils.ts` → 0 matches
- `utils/index.ts` 有 3 个新文件的 re-export

**不做**: 不删除 Pipeline 文件（Phase 4）
