---
name: sdd-review-skill
description: "对 requirement.md、design.md、task.md 执行 SDD 质量审查与 AC Group 验证。"
agentTypes: [plan, review]
triggers: [SDD 审查, SDD review, 设计审查, AC Group 验证, 三层一致性, 契约测试覆盖, 漂移审查, SDD audit]
status: published
---

# SDD 审查领域 Skill

触发关键词：SDD review、三层一致性、AC Group 检查、契约测试覆盖。

---

本 skill 提供 SDD 三层一致性检查的领域知识。
遵循 [quality-loop-pattern](../../knowledge/quality-loop-pattern.md) 的 6 步流程（Define→Trace→Diagnose→Fix→Verify→Converge）。

## 三层文档结构

```
requirement.md → 需求层（AC 定义、验收标准）
design.md      → 设计层（实现指南、文件映射）
task.md        → 任务层（契约测试、开发进度）
```

每层有 frontmatter（status/version 等元数据）和 body（具体内容）。

---

## 并行审查

当 SDD 包含多个 AC Group 时，按 Group 并行审查：

```
读 SDD → 提取所有 AC Group
每个 AC Group 独立审查（5 维度：req↔design、契约测试、状态一致性、代码漂移、就绪度）
独立 Group → parallel-execution 并行审查
有依赖的 Group（如共享模块）→ 按依赖顺序串行
汇总 → 统一审查报告
```

---

## 硬门禁

<HARD-GATE>
在所有 AC Group 都已对照全部 5 个维度（req↔design、契约测试、状态一致性、代码漂移、就绪度）完成 trace 之前，不得输出审查报告。部分审查 = 虚假信心。每个 AC Group × dimension 配对都必须有 trace 结果后才能进入 diagnose。
</HARD-GATE>

---

## 执行流程（DomainSkill Contract）

### ① define(input)

输入：docs（requirement.md + design.md + task.md 路径）

**快速退出检查**：

```
if 输入不是三层文档结构（如轻量 PLAN、单文件 AC 列表）:
    输出："输入非完整 SDD，跳过三层一致性审查"
    → 终止本 Skill。不 invoke 下游。上游路由有误：轻量 PLAN 不应发给 sdd-review
```

执行：
1. 从 requirement.md 提取所有 AC Groups（按 `## AC Group: xxx` 或类似标题识别）
2. 定义检查维度：
   - **req↔design 一致性**：AC 定义是否在设计层有对应实现指南
   - **契约测试覆盖**：每个 AC Group 是否有对应契约测试文件
   - **状态一致性**：三层 frontmatter status 是否对齐
   - **代码漂移**：Code Changes Detected 是否已审查标注
   - **就绪度**：task.md 是否有 implementationReady 判定 + 5 条件检查清单
3. 产出 DefineResult

### ② trace(unit, dimension)

输入：一个 AC Group + 一个检查维度

按维度执行不同检查：

**req↔design 一致性**：
- 在 requirement.md 中找到该 AC Group 的 AC 定义
- 在 design.md 中搜索对应的实现指南
- pass = AC 在两层都有且语义对齐
- warn = design 有提及但不完整
- fail = design 完全缺失

**req↔design 分类一致性**（req↔design 一致性的子维度）：
- 提取 requirement.md 中该 AC 涉及对象（端点/函数/类型/表）的"删除/保留/修改"分类
- 提取 design.md 中同一对象的分类
- 对比同一对象在两层的分类是否矛盾
- pass = 同一对象分类一致（都删除或都保留）
- fail = 同一对象分类矛盾（requirement 说删除，design 说保留，或反之）
- 例子：requirement.md 说"删除 4 个端点含 GET /changes/:changeId"，design.md 说"保留 GET /changes/:changeId" -> fail

**契约测试覆盖**：
- 在 task.md 中搜索该 AC Group 的契约测试引用
- 验证测试文件是否真实存在（ls/glob 检查）
- pass = 测试文件存在且覆盖正向/边界/异常
- warn = 测试文件存在但覆盖不完整
- fail = 测试文件不存在

**契约测试覆盖（扩展）— 执行顺序覆盖**：
- 检查 task.md 的 Execution Order 是否覆盖所有 AC Group
- 对比 requirement.md 中的 AC Group 列表与 task.md Execution Order 中的 Phase 列表
- 如果某 AC Group 在 requirement.md 定义了但 Execution Order 没排进任何 Phase → fail
- 修复建议：在 Execution Order 中补充缺失 AC Group 的 Phase，或标注为 P2 不在本次范围（需在 requirement.md 的"不做项"中说明）

**状态一致性**：
- 读取三层 frontmatter 的 status 字段
- pass = 三层 status 一致
- warn = 有差异但可解释（如 task=implemented 但 req=confirmed 是正常进度差）
- fail = 有矛盾（如 req=stale 但 task=implemented）

**代码漂移**：
- 在 design.md 中搜索 "Code Changes Detected" 标记
- 检查是否有审查标注（R{n} 审查: ...）
- pass = 所有漂移已审查标注
- warn = 有未审查的漂移
- fail = 有大量未审查漂移且涉及核心逻辑

**就绪度**：
- 在 task.md 中搜索 `implementationReady` 字段
- 验证 5 条件检查清单是否存在且每条有证据
- pass = 就绪度判定存在 + 5 条件有证据 + 判定与条件一致（全满足=true，有缺口=false）
- warn = 有判定但部分条件缺证据
- fail = 无就绪度判定（task-planner 未产出）

### ③ diagnose(results)

分类规则：
- 契约测试文件不存在 → P0（核心交付物缺失）
- 三层 status 矛盾 → P0（一致性破坏）
- Code Changes 未审查 → P0（漂移风险）
- 无就绪度判定 → P0（task-planner 产出缺失）
- 就绪度条件缺证据 → P1（判定不可靠）
- req↔design 不完整对齐 → P1（可能有理解偏差）
- 同类 warn > 3 个 → 升级为 P0

### ④ fix(gap)

按 gap 类型选修复模板：
- **缺契约测试**：生成契约测试模板（AC Group 标注 + 正向/边界/异常 it 块）
- **状态不一致**：分析实际进度，统一三层 status
- **未审查漂移**：添加 R{n} 审查标注模板

### ⑤ verify(fixes)

对修改涉及的 AC Group × dimension 重跑 trace。

### ⑥ converge(before, after)

同 quality-loop 标准：P0=0 + 无新增 fail = 收敛。修复-验证循环最多 3 轮，超过 3 轮仍未收敛 → 停下报告，不继续循环。

## 常见遗漏反模式

审查 SDD 时 Agent 容易犯的错误，每个反模式对应一个自检项。

| # | 反模式 | 后果 | 自检方法 |
|---|--------|------|----------|
| AP-1 | **只检查 req→design，不检查 design→task** | 设计写了但 task 没落地，实现与设计脱节 | 对每个 AC Group 三层穿透检查：req 定义 → design 指南 → task 契约测试 |
| AP-2 | **把"AC Group 存在"当成"已被测试覆盖"** | 存在 ≠ 覆盖。AC Group 标题有但测试文件缺失或不覆盖该 AC | 对每个 AC Group 执行 `ls/glob` 验证测试文件存在，再 Read 测试内容确认覆盖范围 |
| AP-3 | **只看 status 字段，不验证实际内容** | status=done 但代码实际未实现或测试未通过 | status 字段仅作参考，必须验证：测试文件存在 + 测试可运行 + 代码实际匹配设计 |
| AP-4 | **跳过代码漂移检查** | Code Changes Detected 未审查，文档与代码已脱节但无人知道 | 搜索 design.md 中所有 "Code Changes Detected" 标记，逐一确认是否有 R{n} 审查标注 |
| AP-5 | **只检查有变更的文件，忽略被依赖但未变更的文件** | A 文件改了接口，B 文件依赖 A 但未变更，B 的行为可能已失效 | 对变更文件做 callers/importers 反向检查，识别可能受影响的依赖方 |
| AP-6 | **对"已 accepted"的 SDD 不再审查** | accepted 不代表无 gap。后续实现可能偏离，或代码漂移未同步 | accepted SDD 仍需执行完整 6 步流程，重点检查 AP-3 和 AP-4 |
| AP-7 | **只检查测试文件存在，不检查 Execution Order 覆盖** | 测试写了但实现没排进执行计划，AC 在 tdd-implement 阶段被遗漏 | 对比 requirement.md AC Group 列表与 task.md Execution Order Phase 列表，确保每个 AC 都有对应 Phase |
| AP-8 | **只检查 AC 对齐，不检查对象分类一致性** | requirement 说"删除端点 X"，design 说"保留端点 X"，三层对齐检查通过但语义矛盾 | 对比 requirement.md 和 design.md 中同一对象（端点/函数/类型/表）的"删除/保留/修改"分类，确保无矛盾 |

## 自检检查清单

自检修复最多 3 轮。超过 3 轮仍未全部通过 → 停下报告，不继续循环。不 invoke 下游。

审查完成后，逐项自检。任何一项未通过 → 补查后再输出结论。

| # | 检查项 | 判定标准 |
|---|--------|----------|
| SR-1 | 每个 AC Group 是否都有 req↔design↔task 三层对齐 | 三层中每层都有该 AC Group 的对应内容，且语义一致 |
| SR-2 | 每个 AC Group 是否都有对应契约测试 | 测试文件存在 + 测试内容覆盖该 AC Group 的正向/边界/异常场景 |
| SR-3 | 三层 status 是否一致 | 无矛盾（如 req=stale 但 task=done）；正常进度差可接受 |
| SR-4 | 代码漂移是否已审查标注 | 所有 "Code Changes Detected" 均有 R{n} 审查结论 |
| SR-5 | 每个发现的问题是否都有具体定位 | 每个 gap 都标注了文件:行号或 AC Group 名称，不接受模糊描述 |
| SR-6 | task.md Execution Order 是否覆盖所有 AC Group | 无遗漏：每个 AC Group 都被排进了某个 Phase，或在"不做项"中明确标注 |
| SR-7 | Implementation Readiness 是否已评估 | task.md 有 implementationReady 判定 + 5 条件检查清单，每条有证据 |
| SR-8 | 同一对象在 requirement.md 和 design.md 中分类是否一致 | 端点/函数/类型/表的"删除/保留/修改"分类无矛盾（见 AP-8） |

## 契约测试模板

```typescript
// __tests__/{feature}.test.ts
// AC Group: {group-id}

describe('{AC Group name}', () => {
  describe('{AC-1: 正向验证}', () => {
    it('should {预期行为}', async () => {
      // 正向场景
    });
  });

  describe('{AC-1: 边界验证}', () => {
    it('should {边界行为}', async () => {
      // 边界场景：空值/极值/并发
    });
  });

  describe('{AC-1: 异常验证}', () => {
    it('should {异常处理}', async () => {
      // 异常场景：错误输入/系统故障
    });
  });
});
```

## 状态同步规则

```
status 语义：
- draft: 文档已创建但未确认
- confirmed: 需求/设计已确认，待实现
- implemented: 代码已实现且测试通过
- stale: 代码已变更但文档未更新

同步规则：
- 当 task=implemented 且测试存在 → req/design 应推进到 implemented
- 当 design 有 Code Changes → req 应审查是否影响需求
- 任何层 stale → 需标注审查结论
```

## Code Changes 审查模板

```markdown
> Auto-detected by SddFreshnessService. Layer: {layer}.
> **R{n} 审查**: {变更来源}。
> - 是否在本 SDD scope 内：{是/否}
> - 处理建议：{需更新文档/无需并入/需新增 AC}
> - 审查结论：{已更新/确认无需更新/待处理}
```

## 终端状态

<HARD-GATE>
审查通过后，必须以 PASS 的 SDD 调用 tdd-implement 开始实现。跳过实现直接提交 = SDD 产出未被验证。

审查未通过（P0 > 0）→ 自动进入 Fix 步骤修复 P0，修复后重跑 Verify → Converge。修复-验证循环最多 3 轮，超过 3 轮仍未收敛 → 停下报告，不继续循环。不得在 P0 > 0 时终止审查流程。
</HARD-GATE>

审查通过后：

**invoke tdd-implement**

将 PASS 的 SDD 三层文档作为输入传递给 tdd-implement，开始 RED + GREEN 实现。

审查未通过时：

**进入 Fix 步骤**。修复 P0 → 重跑涉及 Unit × Dimension 的 trace → 更新报告。收敛后 invoke tdd-implement。

--- Self-Review: done ---
