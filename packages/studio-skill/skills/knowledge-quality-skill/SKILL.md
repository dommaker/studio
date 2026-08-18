---
name: knowledge-quality-skill
description: "审查知识库条目的语义质量：内容完整性、价值、跨条目矛盾、引用存活、语义重复。"
consumers: [loop]
triggers: [知识质量, 健康度审查, knowledge quality, 语义质量, 跨条目矛盾, 引用存活, 语义重复, 知识库审计, quality audit]
status: published
---

# 知识质量领域 Skill

触发关键词：知识质量审查、knowledge quality、知识条目审计、语义重复、知识价值评估。

本 skill 提供知识条目**语义层**质量检查。格式层由 `harness knowledge audit` CLI 覆盖（零 token），本 skill 覆盖 CLI 无法做的语义判断。

遵循 [quality-loop-pattern](../../knowledge/quality-loop-pattern.md) 的 6 步流程。

## 职责

- 从 `~/.studio/knowledge/` 读取知识条目
- 按 [knowledge-quality-pattern](../../knowledge/knowledge-quality-pattern.md) 定义的维度逐项检查
- 对每个条目给出 pass/warn/fail/na 判定
- 分类 P0（关键问题）和 P1（改进建议）
- 提出修复方向

## 与 CLI audit 的分工

| 层面 | CLI (harness knowledge audit) | Skill (本 skill) |
|------|------|------|
| 检查方式 | 纯代码规则，零 token | 语义理解，需 agent |
| 结构完整性 | frontmatter 必填字段 | 跨 schema 一致性（memory-sync vs 标准） |
| 内容质量 | 字数阈值 + 标题模式 | 语义价值判断 + body 结构完整性 |
| 去重 | 精确标题匹配 | 语义重复 + 跨 type 等价 |
| 矛盾 | 同 tag 成熟度差异 | 跨 tag 结论冲突 |
| 时效性 | 时间阈值（>90 天） | 代码引用存活验证 |

## Pattern 文件

质量标准来自 `~/.studio/knowledge/knowledge-quality-pattern.md`：

| 维度 | 级别 | 检查内容 |
|------|------|---------|
| D1 语义完整性 | required | 按 type 检查 body 必要内容 |
| D2 内容价值 | required | 可操作知识 vs 事件噪音 |
| D3 一致性 | required | 语义矛盾 + 格式分裂 + 事实冲突 |
| D4 时效性 | required | 代码/架构引用存活 + 结论有效性 |
| D5 去重 | optional | 语义重复 + 跨 type 等价 |
| D6 Tag 质量 | optional | 宽泛 tag + tag-content 相关性 |
| D7 领域相关性 | required | 所属领域是否仍适用于当前架构 |

**关键**：每次执行前读取 pattern 文件获取最新标准。不硬编码维度列表。

---

## 硬门禁

<HARD-GATE>
在所有条目都经过所有适用维度（D1-D6）追踪之前，不得输出审查报告。跳过维度 = 遗漏 P0 问题。
每个条目 × 维度组合必须有追踪结果后才能进入诊断阶段。
</HARD-GATE>

---

## 执行流程

### ① Define

```
输入：
- docs: 要检查的知识条目路径（或整个 ~/.studio/knowledge/）
- 可选 filter: type/dimension/tag

产出：
- units: 每条知识条目为一个 TraceUnit
- dimensions: 从 pattern 读取 D1-D6
- criteria: P0=0, 低价值占比 <10%
```

### ② Trace

```
对每个 unit × dimension：

D1 语义完整性：
  读取 entry.type → 查 pattern 的 type 必要内容表
  检查 body 是否包含对应段落
  缺失必要段落 → fail

D2 内容价值：
  判断 body 是否包含：
  1. 具体上下文（系统/文件/场景）
  2. 可操作结论（应该/不应该）
  3. 因果链（为什么）
  三条都不满足 → fail（低价值）
  满足 1 条 → warn

D3 一致性：
  - 与其他条目做语义对比（同 tag 或同主题）
  - 检查 frontmatter schema 是否标准（memory-sync 用 createdAt/name 而非 created/title）
  - 检查描述的代码行为是否与当前代码一致
  矛盾 → fail

D4 时效性：
  - 提取 sourceReferences 中的文件路径
  验证文件是否存在
  - 提取引用的 spec/decision 编号
  验证是否存在且未 deprecate
  引用失效 → warn
  结论被推翻 → fail

D5 去重（如启用）：
  - 与其他条目做语义相似度判断
  - 两条说同一件事 → warn（建议合并）

D6 Tag 质量（如启用）：
  - 检查 tag 是否过于宽泛
  - 检查 tag 与 body 内容的相关性
  宽泛/不匹配 → warn

D7 领域相关性：
  - 提取条目引用的系统/模块/架构概念
  - 对照 knowledge-quality-pattern.md 的废弃领域清单
  - 匹配废弃领域 → fail
  - 部分匹配（通用模式绑定旧系统） → warn（建议剥离系统绑定）
```

### ③ Diagnose

```
fail → P0
warn × 同类 > 3 → P1

输出格式：
## 审查报告

### P0 问题（N 个）
- [entry-id] D1/D2/D3/D4: 问题描述 → 修复方向

### P1 建议（N 个）
- [entry-id] D5/D6: 建议描述

### 统计
| 维度 | pass | warn | fail | na |
```

### ④ Fix

```
按 P0 优先级修复：
- D1 缺失内容 → 补充缺失段落（需理解原条目上下文）
- D2 低价值 → 移入 `~/.studio/knowledge/.archive/` 目录（mv 命令）。不创建 `archived/` 等非标准目录
- D3 矛盾 → 分析冲突，保留正确版本，标记/修正另一条
- D3 格式分裂 → 标准化 frontmatter 字段名
- D4 引用失效 → 更新或删除失效引用
```

### ⑤ Verify

重跑 ② 中涉及的 unit/dimension。

### ⑥ Converge

P0=0 + 低价值占比<10% → 收敛。否则回到 ②。

### ⑦ Rebuild Index

收敛后执行 `harness knowledge index` 重建 `_index.md`。
索引供 Agent grep 使用（80-96% 输出减少）。

```bash
# harness 在 pnpm 全局目录，如不在 PATH 中用绝对路径
/root/.local/share/pnpm/harness knowledge index
# 或
npx --prefix /root/projects/harness harness knowledge index
```

验证：
- `_index.md` 文件存在且非空
- 条目数 > 100

## 输出

遵循 quality-loop-pattern 的 LoopReport 结构。额外包含：
- 按 type 分组统计（architecture/decision/pitfall/guideline/process/model）
- 按维度分组统计（D1-D6）
- 修复前后对比
