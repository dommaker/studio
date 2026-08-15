---
status: "done"
version: "1.0"
created: 2026-06-30
updated: 2026-06-30
source: docs/specs/phase-2-pipeline-value-extraction.md
phase: phase-2-pipeline-value-extraction
---

# Phase 2: Pipeline 价值提取 — 设计

## 文件映射

| AC | 文件路径 | 操作 | 依赖 |
|----|---------|------|------|
| AC-1 | `packages/studio-shared/src/utils/concurrency-control.ts` | 新建 | os |
| AC-1 | `packages/studio-shared/src/utils/index.ts` | 修改 (添加 re-export) | — |
| AC-1 | `packages/studio-shared/src/utils/__tests__/concurrency-control.test.ts` | 新建 | vitest |
| AC-2 | `packages/studio-shared/src/utils/error-file-extractor.ts` | 新建 | 无 |
| AC-2 | `packages/studio-shared/src/utils/index.ts` | 修改 (添加 re-export) | — |
| AC-2 | `packages/studio-shared/src/utils/__tests__/error-file-extractor.test.ts` | 新建 | vitest |
| AC-3 | `packages/studio-shared/src/utils/git-utils.ts` | 新建 | child_process |
| AC-3 | `packages/studio-shared/src/utils/index.ts` | 修改 (添加 re-export) | — |
| AC-3 | `packages/studio-shared/src/utils/__tests__/git-utils.test.ts` | 新建 | vitest |
| AC-4 | `~/.studio/knowledge/pattern-dag-wave-scheduling.md` | 新建 | — |
| AC-5 | `~/.studio/knowledge/pattern-task-tier-routing.md` | 新建 | — |
| AC-6 | `~/.studio/knowledge/pattern-cascade-rollback.md` | 新建 | — |

## 接口定义

### AC-1: concurrency-control.ts

```typescript
import * as os from 'os';

/**
 * 滑动窗口失败率检测：近 N 次 dispatch 中失败率超阈值 → conservative
 * @param recentFailures 窗口内失败次数
 * @param recentTotal 窗口内总次数
 * @returns 'conservative' 当 total >= 5 且 failRate > 0.5
 */
export function getDispatchStrategy(
  recentFailures: number,
  recentTotal: number
): 'normal' | 'conservative';

/**
 * 资源感知并发槽位计算
 * @param maxCap 可选上限（conservative 模式传 2）
 * @returns 可用槽位数：1/2/5，受 maxCap 约束
 */
export function getAvailableSlots(maxCap?: number): number;
// 规则：freeMemPct < 0.15 → 1, < 0.30 → 2, load > 0.90 → 2, default → 5
// maxCap 存在时取 Math.min(slots, maxCap)

/**
 * 更新 dispatch 结果的滑动窗口计数
 * @param state 当前 { failures, total }
 * @param success 本次是否成功
 * @returns 更新后的 { failures, total }，total 上限 20
 */
export function updateDispatchOutcome(
  state: { failures: number; total: number },
  success: boolean
): { failures: number; total: number };
```

**与现有 scheduler.ts 的关系**：
- `scheduler.ts:getResourceAwareConcurrency(base)` — 接收 base 并发数，按资源状态比例缩减
- `concurrency-control.ts:getAvailableSlots(maxCap?)` — 返回绝对槽位数（1/2/5），按资源阈值离散跳变
- 两者互补不冲突。AN 未来可选择使用哪个

### AC-2: error-file-extractor.ts

```typescript
/**
 * 从编译器/测试错误消息中提取受影响的文件路径
 * 3 层 pattern 按优先级匹配：
 * 1. tsc: "src/foo.ts(10,5): error TS2345"
 * 2. test FAIL: "FAIL src/foo.test.ts"
 * 3. generic: 任意 .ts/.tsx 路径（仅在前两层无匹配时启用）
 * @returns 去重文件路径列表
 */
export function extractAffectedFiles(errorOutput: string): string[];
```

**源码差异**：
- 原代码在 `integration-rollback.ts:80-106`
- 提取时移除 `mapAffectedFilesToSteps`（强绑 Pipeline Goal 模型）
- generic fallback 增加 `.tsx` 支持

### AC-3: git-utils.ts

```typescript
/**
 * 在指定目录强制执行 git add + commit
 * @param cwd 工作目录
 * @param message commit message
 * @returns { success: true, commitHash } 或 { success: true, commitHash: undefined }（无变更）
 * @throws 非 git 目录或 git 命令失败时抛出异常
 */
export function forceCommit(
  cwd: string,
  message: string
): { success: boolean; commitHash?: string };
```

**与源码差异**：
- 原代码返回 `string | null`，新接口返回 `{ success: boolean; commitHash?: string }`（结构化）
- git identity 默认 `'Studio'`/`'studio@local'`，不再硬编码 `'Pipeline'`/`'pipeline@studio.local'`
- message 引号转义保留

## 代码依赖图

```
S1 (concurrency-control) ──→ S7 (验证)
S2 (error-file-extractor) ──→ S7
S3 (git-utils) ──→ S7
S4 (knowledge: DAG) ──→ S7
S5 (knowledge: tier) ──→ S7
S6 (knowledge: rollback) ──→ S7
```

S1-S6 全部独立，可并行。S7 依赖 S1-S6 全部完成。

`index.ts` 修改被 S1/S2/S3 共享，合并时注意不冲突。实际实现时依次追加 re-export 行。

## 模块边界

| 约束 | 理由 |
|------|------|
| 三个工具文件零 prisma 依赖 | 纯函数，可在任何 Node.js 环境使用 |
| 不修改 Pipeline 现有调用方 | Phase 3 标记 deprecated，Phase 4 删除 |
| 知识条目纯文档 | 不改 AN 代码 |
| 不创建新抽象层 | YAGNI：只为当前提取，不为未来集成设计 |
