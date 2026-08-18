---
name: arch-review-skill
description: "对照 arch-patterns 知识库检查架构文档的概念完整性和覆盖度，识别 P0/P1 缺口。"
agentTypes: [review, analysis]
triggers: [架构审查, arch review, 概念完整性, 覆盖度检查, 维度覆盖, 缺口识别, architecture review]
status: published
---

# 架构审查领域 Skill

触发关键词：架构 review、架构文档检查、概念完整性、arch review。

本 skill 提供架构文档审查的领域知识：检查什么、什么是好的、怎么修。
遵循 quality-loop-pattern 的 6 步流程（Define→Trace→Diagnose→Fix→Verify→Converge；原文归档于 `~/.studio/knowledge/archive/guideline-quality-loop-pattern.md`）。

## 职责

- 从架构文档中提取概念声明（units）
- 从 arch-patterns 读取质量标准（dimensions）
- 对每个概念×维度执行 trace，判定 pass/warn/fail
- 对 fail/warn 分类为 P0/P1 并提出修复方向

## Pattern 文件

质量标准来自 `~/.studio/knowledge/arch-patterns/`：

| 文件 | 对应检查 |
|------|---------|
| concept.md | 概念完整性（定义/生命周期/交互方/事件/验证） |
| event.md | 事件完整性（命名/触发/payload/消费方） |
| lifecycle.md | 生命周期完整性（阶段/转换/终止） |
| verification.md | 验证完整性（正向/边界/异常） |

**关键**：每次执行前读取 pattern 文件获取最新标准。不硬编码维度列表。

## 常见遗漏反模式

审查架构文档时，Agent 容易犯以下错误。每个 trace 判定前必须过一遍此清单。

| # | 反模式 | 表现 | 正确做法 |
|---|--------|------|----------|
| AP-1 | **只查有定义的维度** | 文档某概念没有"事件"章节 → 直接标 na | 先判断该概念是否应该有事件（如涉及状态变化），应该有但没有 = fail |
| AP-2 | **只看写了什么** | 文档写了 lifecycle 5 个阶段 → pass | 反向验证：该概念的 lifecycle 是否应该包含异常终止/降级路径，没写 = gap |
| AP-3 | **提到 ≠ 完整定义** | 文档提到"Agent 间通过事件通信" → pass | 检查必要维度是否都有具体定义（事件名/payload/消费方），只有笼统描述 = warn |
| AP-4 | **只查主流程** | 正常路径有描述 → pass | 必须检查异常/边界/降级路径是否有覆盖，特别是涉及外部依赖的概念 |
| AP-5 | **P0/P1 分级偏松** | "这个不太重要" → P1 | 必要维度 fail = P0，不因主观判断降级。只有可选维度 fail 才可能是 P1 |
| AP-6 | **熟悉领域过度宽容** | "这个我了解，肯定没问题" → pass | 严格按 pattern 文件的必要维度逐项检查，不因熟悉而跳过。每个 pass 必须有 evidence |

**使用方式**：diagnose 阶段回顾每个 fail/warn，逐条对照 AP-1~AP-6，确认判定没有落入反模式。

---

## 硬门禁

<HARD-GATE>
在所有 unit 都已对照所有必要维度完成 trace 之前，不得输出最终报告。部分 trace = 不完整审计。每个 unit × dimension 配对都必须有 trace 结果（pass/warn/fail/na）后才能进入 diagnose。
</HARD-GATE>

---

## 执行流程（DomainSkill Contract）

### ① define(input)

输入：docs（架构文档路径列表）

执行：
1. 读取所有 pattern 文件（~/.studio/knowledge/arch-patterns/*.md）
2. 解析每个 pattern 的完整性标准（### 标题 + [required/optional] 标签）
3. 从架构文档中提取所有概念声明（识别概念的方式：章节标题中的实体名、定义表、type/interface 声明）
4. 产出 DefineResult：
   - units = 提取到的概念列表
   - dimensions = pattern 文件中 [required] 的标准（每个 pattern 的每个 required 标准 = 一个 dimension）
   - criteria = { maxP0: 0, noNewErrors: true }

### ② trace(unit, dimension)

输入：一个概念（unit）+ 一个检查维度（dimension）

执行：
1. **先判断适用性**：读取该 dimension 所属 pattern 文件的 `## 适用性` 节，判断此概念是否适用该 pattern
   - 如果 concept 没有该 pattern 的信号特征（如无状态变化 → 不适用 lifecycle pattern）→ 返回 na
   - 如果适用 → 继续检查
2. 在文档中搜索该概念相关的章节
3. 按 dimension 的"检查方向"提示搜索证据
4. 判定：
   - pass：找到完整覆盖（有定义/有事件表/有验证场景）
   - warn：有部分覆盖但不完整（有事件但缺消费方）
   - fail：完全没有覆盖（无任何事件定义）
   - na：pattern 不适用于此概念（依据适用性条件判断）
5. 产出 TraceResult：{ unitId, dimensionId, status, evidence }

**关键**：na 判定必须有依据（引用 pattern 适用性条件 + 概念特征）。不能仅因为"文档里没找到"就标 na。

### ③ diagnose(results)

输入：所有 TraceResult

分类规则：
- fail + dimension 为 [required] → P0（关键缺失）
- warn + dimension 为 [required] → P1（系统性缺口）
- fail + dimension 为 [optional] → P1（非关键但建议修复）
- 同类 warn > 3 个 → 升级为 P0（模式性问题）

产出 Diagnosis：{ p0: Gap[], p1: Gap[], summary }

### ④ fix(gap)

输入：一个 Gap

修复方向：
- 缺定义 → 补充数据结构/字段定义模板
- 缺事件 → 补充事件表模板（事件名+触发条件+payload+消费方）
- 缺验证 → 补充验证场景模板（正向+边界+异常）
- 缺生命周期 → 补充阶段列表+转换条件
- 状态不一致 → 同步 frontmatter status

产出 FixResult：{ gapId, actions, filesChanged }

### ⑤ verify(fixes)

对修改涉及的 unit×dimension 重跑 ② trace。
确认：无新增 fail、已修复项变为 pass。

产出 VerifyResult：{ retraceResults, newGaps, resolvedGaps }

### ⑥ converge(before, after)

收敛条件：
- after.p0.length === 0（P0 清零）
- 无新增 fail（noNewErrors）

产出 ConvergenceResult：{ converged, reason, p0Delta, warnDelta, newFindings }

## 自动化边界

| 检查类型 | 方法 | 自动化 |
|---------|------|--------|
| 章节存在性 | grep 概念名+章节标题 | 高 |
| 事件表存在性 | grep 事件表/event 关键词 | 高 |
| 验证场景存在性 | grep 正向/边界/异常 | 高 |
| 事件完整性（有触发+payload+消费方） | 检查表结构 | 中 |
| 语义完整性（定义是否充分） | 语义判断 | 低 |

## 自检检查清单

⑥ converge 输出后、报告最终结果前，逐项检查：

- [ ] **概念无遗漏**：所有从文档提取的概念声明（units）都已逐一 trace，无跳过
- [ ] **定位精确**：每个 fail/warn 都有具体文件:行号或章节锚点，不存在模糊描述（如"某处提到"）
- [ ] **P0 有方向**：每个 P0 gap 都附带具体修复方向（补什么、在哪补、模板是什么）
- [ ] **反向检查完成**：已检查"文档没写但应该有"的 gap（AP-1/AP-2），不只是"写了但不完整"的情况
- [ ] **反模式复核**：diagnose 阶段已对照 AP-1~AP-6，无落入反模式的判定
- [ ] **na 判定有据**：所有标 na 的 unit×dimension 都引用了 pattern 适用性条件 + 概念特征，不是因为"没找到"

任一项未通过 → 回到对应步骤补全，不输出最终报告。

--- Self-Review: done ---
