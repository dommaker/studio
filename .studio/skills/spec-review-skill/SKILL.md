---
name: spec-review-skill
description: "审查 docs/specs/ 中 spec 文档的质量、状态准确性与 SDD 就绪度。"
agentTypes: [design, review]
triggers: [spec 审查, spec 审计, spec review, 就绪度评估, AC 可测试性, 交叉引用, spec audit, readiness check, spec 状态]
status: published
---

# Spec 审查领域 Skill

触发关键词：spec review、spec 审查、spec 质量检查、验收标准质量、交叉引用检查。

本 skill 提供 spec 文档语义层质量检查。
遵循 [quality-loop-pattern](../../knowledge/quality-loop-pattern.md) 的 6 步流程。

## 职责

- 从 `studio/docs/specs/` 读取 spec 文档
- 按 [spec-quality-pattern](../../knowledge/spec-quality-pattern.md) 定义的维度逐项检查
- 对每个 spec 给出 pass/warn/fail/na 判定
- 分类 P0（关键问题）和 P1（改进建议）
- 提出修复方向

## 与其他 skill/CLI 的分工

| 层面 | 覆盖方 | 说明 |
|------|--------|------|
| Spec 格式层 | harness（未来） | frontmatter 必填字段、文件命名 |
| Spec 语义层 | 本 skill | 结构完整性 + AC 质量 + 引用存活 + 就绪度 |
| SDD 三层 | sdd-review-skill | requirement/design/task 一致性 |
| 知识条目 | knowledge-quality-skill | 语义价值 + 矛盾 + 时效 |
| 架构概念 | arch-review-skill | 概念完整性（对照 arch-patterns） |

## Pattern 文件

质量标准来自 `~/.studio/knowledge/spec-quality-pattern.md`：

| 维度 | 级别 | 检查内容 |
|------|------|---------|
| D1 结构完整性 | required | 按 spec 类型检查必要段落 |
| D2 AC/验收标准质量 | required | SMART 原则 + 动词开头 + 无模糊词 |
| D3 交叉引用完整性 | required | spec/文件/决策引用存活 + 依赖概念对齐 |
| D4 状态准确性 | required | status 与实际进度一致 |
| D5 范围边界清晰度 | required | 目标/非目标/依赖/约束明确 |
| D6 实现就绪度 | optional | 数据模型/API/流程/边界已定义 |

**关键**：每次执行前读取 pattern 文件获取最新标准。

---

## 硬门禁

<HARD-GATE>
在所有 spec 都已对照所有适用维度（D1-D6）完成 trace 之前，不得输出 spec 审查报告。跳过维度 = 遗漏 P0 问题。每个 spec × dimension 配对都必须有 trace 结果后才能进入 diagnose。
</HARD-GATE>

---

## 执行流程

### ① Define

```
输入：
- docs: 要检查的 spec 路径（单文件或目录）
- 可选 filter: type/dimension

产出：
- units: 每个 spec 文档为一个 TraceUnit
- dimensions: 从 pattern 读取 D1-D6
- criteria: P0=0, 低就绪度占比<20%
```

### ② Trace

```
对每个 unit × dimension：

D1 结构完整性：
  识别 spec 类型（FL/AS/KE/SP/SM/HZ/arch/GEN）
  查 pattern 的类型必要内容表
  检查 body 是否包含对应段落
  缺失必要段落 → fail

D2 AC/验收标准质量：
  提取所有 AC（checkbox 列表 / 验收标准段落）
  逐条检查：动词开头？可验证？无模糊词？单一验收点？
  模糊/不可验证 → warn
  无 AC（FL/SP 类型） → fail

D3 交叉引用完整性：
  提取 spec 引用（[xxx](path) 引用其他 spec）
  验证目标文件存在且不在 _archive/
  提取源码路径引用
  验证文件存在
  引用失效 → warn

  依赖概念对齐：
  读取 frontmatter 中 dependencies 列出的文档
  提取依赖文档的核心概念/接口/模型
  检查本文档是否正确使用这些概念：
  - 是否重新发明了依赖已定义的概念？→ fail
  - 是否遗漏了依赖中与本文档相关的关键生命周期/接口？→ fail
  - 是否与依赖定义的模型/接口不一致？→ fail
  依赖概念不对齐 → fail（设计基础错误）

  依赖不满足 → fail

D4 状态准确性：
  读取 status（frontmatter 或正文头部）
  交叉验证：有 PR/分支？代码已合并？
  状态与实际不符 → fail

D5 范围边界清晰度：
  检查是否有"目标""非目标""依赖""约束"段落
  缺失 → warn

D6 实现就绪度（如启用）：
  检查是否有数据模型定义
  检查是否有 API 接口定义
  检查是否有关键流程描述
  就绪度低 → warn
```

### ③ Diagnose

```
fail → P0
warn × 同类 > 3 → P1

输出格式：
## 审查报告

### P0 问题（N 个）
- [spec-id] D1/D3/D4: 问题描述 → 修复方向

### P1 建议（N 个）
- [spec-id] D2/D5/D6: 建议描述

### 统计
| 维度 | pass | warn | fail | na |
| 类型 | 已检查 | P0 | P1 |
```

### ④ Fix

```
按 P0 优先级修复：
- D1 缺失内容 → 补充缺失段落模板
- D2 AC 模糊 → 重写为具体可验证 AC
- D3 引用失效 → 更新或删除失效引用
- D4 状态不准 → 核实实际进度，更新 status
```

### ⑤ Verify

重跑 ② 中涉及的 unit/dimension。

### ⑥ Converge

P0=0 + 低就绪度占比<20% → 收敛。否则回到 ②。

## Spec 类型识别

```
文件名前缀 → 类型映射：
FL-xxx → feature（功能需求）
AS-xxx → architecture（架构分析/设计）
KE-xxx → knowledge（知识引擎）
SP-xxx → process（流程/工具）
SM-xxx → migration（CLI 迁移）
HZ-xxx → agent（Agent 管理）
GEN-xxx → general（通用设计）
AD-xxx → architecture detail
SEC-xxx → security

目录 → 类型：
arch/* → architecture concept
unified-config/ → process
AS-020-*/AS-023-*/ → 多文件架构 spec
```

## 多文件 Spec 处理

部分 spec 跨多个文件（如 AS-020/ 有 context.md + spec.md + roadmap.md + daemon-spec.md）：
- 以目录为检查单元
- 检查文件间引用一致性
- 检查整体状态一致性

## 常见遗漏反模式

审查 spec 时 Agent 容易犯的错误，执行时必须主动规避：

| # | 反模式 | 错误表现 | 正确做法 |
|---|--------|---------|----------|
| AP-1 | AC 存在即通过 | 只检查 AC 存在，不检查 AC 是否可测试 | 逐条验证：有明确 pass/fail 条件？可自动化验证？无模糊词？ |
| AP-2 | 引用存在即存活 | 把"有交叉引用"当成"引用存活" | 必须打开目标文件验证内容存在且未归档，存在 ≠ 指向有效目标 |
| AP-3 | 只审 spec 不验实现 | 只检查 spec 文档本身，不验证 spec 与实际实现的一致性 | 对"已实现"spec，抽查关键 AC 对应的代码/测试是否匹配 |
| AP-4 | 跳过状态检查 | 忽略 status 字段准确性 | status 必须与 git log/PR/分支状态交叉验证，过期 status 误导下游 |
| AP-5 | 只看正面 AC | 只检查 AC 的正面描述，不检查边界情况和排除项 | 检查是否有"不包括""异常情况""边界条件"等排除/边界描述 |
| AP-6 | 已实现不再审 | 对 status=done 的 spec 跳过审查 | 已实现 spec 可能有未覆盖的 AC、过期的引用、或实现偏离设计 |

## 自检

自检修复最多 3 轮。超过 3 轮仍未全部通过 → 停下报告，不继续循环。不 invoke 下游。

审查报告输出前，逐项检查审查质量：

- [ ] 每个 spec 的 D1-D6 维度是否都已覆盖（无遗漏维度）
- [ ] 每条 AC 是否都验证了 pass/fail 条件（不是模糊描述直接 pass）
- [ ] 所有交叉引用是否都已打开目标文件验证存活（不是只检查链接语法）
- [ ] status 字段是否与实际进度一致（已交叉验证 git/PR/分支）
- [ ] 每个 P0 问题是否都有具体修复方向（不是只报问题不给方案）
- [ ] 已实现 spec 是否也做了完整审查（未因 status 跳过）
- [ ] AC 边界情况和排除项是否已检查（未只看正面描述）

自检未通过 → 补齐遗漏项后重新输出报告。

## 终端状态

<HARD-GATE>
审查通过后必须路由到下游，不得在此终止。路由由审查类型自动判定，无需等待用户确认。
</HARD-GATE>

审查通过后：

- 新功能 Spec（就绪度评估通过）→ **invoke task-planner**
- 小改动（1-2 文件，方案明确）→ **invoke tdd-implement**
- 状态审计/存量审查 → 审查报告输出后流程结束

路由由审查类型自动判定，直接 invoke（或结束），不等待确认。

--- Self-Review: done ---
