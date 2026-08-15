---
status: "done"
version: "1.0"
created: 2026-06-30
updated: 2026-06-30
source: docs/specs/phase-2-pipeline-value-extraction.md
phase: phase-2-pipeline-value-extraction
---

# Phase 2: Pipeline 价值提取 — 任务

## 契约测试规划

### AC-1 → concurrency-control.test.ts

| 测试用例 | 类型 | 验证点 |
|---------|------|--------|
| getDispatchStrategy: total < 5 → normal | 边界 | 样本不足不触发 conservative |
| getDispatchStrategy: failRate > 0.5 → conservative | 正常 | 核心逻辑 |
| getDispatchStrategy: failRate = 0.5 → normal | 边界 | 等于阈值不触发 |
| getDispatchStrategy: total = 0 → normal | 边界 | 零除保护 |
| getAvailableSlots: freeMem < 15% → 1 | 正常 | 低内存降级 |
| getAvailableSlots: freeMem < 30% → 2 | 正常 | 中内存降级 |
| getAvailableSlots: load > 0.9 → 2 | 正常 | 高 CPU 降级 |
| getAvailableSlots: default → 5 | 正常 | 资源充足 |
| getAvailableSlots: maxCap = 2 约束 | 正常 | 上限生效 |
| updateDispatchOutcome: success 不增加 failures | 正常 | 滑动窗口 |
| updateDispatchOutcome: failure 增加 failures | 正常 | 计数正确 |
| updateDispatchOutcome: total > 20 窗口截断 | 边界 | 窗口上限 |

### AC-2 → error-file-extractor.test.ts

| 测试用例 | 类型 | 验证点 |
|---------|------|--------|
| tsc 错误格式提取 | 正常 | `src/foo.ts(10,5): error TS2322` → `src/foo.ts` |
| test FAIL 格式提取 | 正常 | `FAIL src/__tests__/foo.test.ts` → 路径 |
| generic fallback 提取 | 正常 | 非结构化错误中的 .ts 路径 |
| generic fallback 排除 node_modules/dist | 边界 | 噪音过滤 |
| 混合输入去重 | 正常 | 多层 pattern 匹配同一文件不重复 |
| 无匹配返回空数组 | 边界 | 无 .ts 引用的错误 |
| layer 1+2 有匹配时不启用 generic | 边界 | fallback 条件 |

### AC-3 → git-utils.test.ts

| 测试用例 | 类型 | 验证点 |
|---------|------|--------|
| 有变更时 commit 成功 | 正常 | 返回 commitHash |
| 无变更时返回 undefined | 边界 | commitHash 为 undefined |
| message 含双引号正确转义 | 边界 | 不破坏 git commit 命令 |
| 非 git 目录抛出异常 | 错误 | 异常不被吞掉 |

### AC-4/5/6 → 知识条目

| 测试用例 | 验证点 |
|---------|--------|
| 文件存在于 `~/.studio/knowledge/` | ls 确认 |
| 必含段落齐全 | 逐段对照 spec |
| 来源引用正确 | 源码文件路径有效 |

### AC-7 → 完整性验证

| 测试用例 | 验证方式 |
|---------|---------|
| 3 个代码文件存在 | ls 确认 |
| 3 个知识条目存在 | ls 确认 |
| 测试全部通过 | `pnpm test` 输出 |
| grep prisma → 0 | grep 确认 |
| index.ts re-export 完整 | grep 确认 |

## 执行顺序

### 并行组

```
S1: concurrency-control.ts + test        ← 独立
S2: error-file-extractor.ts + test       ← 独立
S3: git-utils.ts + test                  ← 独立
S4: pattern-dag-wave-scheduling.md       ← 独立
S5: pattern-task-tier-routing.md         ← 独立
S6: pattern-cascade-rollback.md          ← 独立
```

S1-S6 无依赖，全部并行。

### 串行

```
S7: AC-7 验证  ← 依赖 S1-S6 全部完成
```

### 实现细节

每个 S 步骤的内部顺序：
1. 创建目标文件（实现代码 / 知识条目）
2. 创建/编写测试文件（代码提取）
3. 运行测试确认通过
4. 更新 `index.ts` re-export（S1-S3）

## 里程碑

| 里程碑 | 内容 | 完成标准 |
|--------|------|---------|
| M1 | 3 个代码文件 + 测试通过 | pnpm test 绿 |
| M2 | 3 个知识条目写入 | ls 确认 |
| M3 | AC-7 验证全部通过 | grep + ls + test 全绿 |
