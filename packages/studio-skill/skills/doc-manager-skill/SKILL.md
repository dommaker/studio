---
name: doc-manager-skill
description: "文档状态管理：保存进度到 memory、维护文档格式、更新 roadmap Phase、同步 spec status。"
agentTypes: [docs]
triggers: [保存进度, 记录进展, 更新文档, 更新 roadmap, 更新 Phase, 保存到 memory, spec status, 状态同步, update docs]
status: published
---

# 文档管理 Skill

## 适用场景

用户要求保存/更新各类结构化文档。

| 触发词 | 操作类型 | 目标位置 |
|--------|---------|---------|
| "保存进度" / "记录进度" | save-progress | `~/.claude/projects/-root-projects/memory/project_batch_progress_*.md` |
| "更新文档" / "修改文档" | update-doc | 现有文档位置 |
| "更新 roadmap" | update-roadmap | `studio/docs/roadmap.md` |
| "更新 spec status" / "同步 spec 状态" / "spec 状态同步" | update-spec-status | `studio/docs/specs/**/*.md` |
| code-review 审查通过后自动调用 | update-spec-status | spec 路径由 code-review 直接传入 |

## 操作规范

### 1. save-progress（保存进度）

**目标**：记录当前会话的工作进展

**格式**：
```markdown
# Batch Progress YYYY-MM-DD — 主题

## 完成项

### 1. 任务名称
- 具体产出
- 文件位置
- 关键决策/发现

## 新增待办

| # | 任务 | 类型 | 状态 |
|---|------|------|------|
| 新 | 任务描述 | 类型 | 待开始 |

## 关键决策

1. 决策内容及理由
```

**规则**：
- 文件名：`project_batch_progress_YYYY_MM_DD.md`
- 同一天多次保存 → 追加到同一文件
- 记录具体产出（文件路径、commit hash），不记录模糊描述

**自检**：
- [ ] 完成项是否有具体文件位置和关键决策
- [ ] 新增待办是否有明确任务描述（可执行，非模糊意图）
- [ ] 是否与之前的 batch progress 有重复（查 `project_batch_progress_*.md` 最近 3 篇）

### 2. update-doc（更新文档）

**目标**：更新现有文档

**规则**：
- 先 Read 现有文档，理解当前格式
- 保持格式一致（frontmatter、标题层级、表格格式）
- 只改用户要求改的部分，不顺手"优化"
- 如果文档有 CHANGELOG，追加变更记录

**自检**：
- [ ] 改动是否与原始需求一致（不超范围、不遗漏）
- [ ] 是否引入了不一致（其他部分未同步更新，如 frontmatter 状态与正文矛盾）
- [ ] 版本号/更新日期是否更新（如有对应字段）

### 3. update-roadmap（更新 roadmap）

**目标**：更新 roadmap 的 Phase 记录

**格式**：
```markdown
### Phase X.XX: 主题

**分析结论（YYYY-MM-DD）**：简要说明

| 任务 | 类型 | 说明 | 状态 |
|------|------|------|------|
| 任务名 | 类型 | 具体说明 | ✅ 完成 / 待开始 / 进行中 |

**关键设计决策（YYYY-MM-DD 更新）**：
- 决策内容及理由
```

**规则**：
- 找到对应 Phase（没有则创建）
- 按现有 Phase 格式添加
- 更新状态（✅ 完成 / 待开始 / 进行中）
- 如果有新发现，添加到"关键设计决策"或"系统性发现"

**自检**：
- [ ] Phase 条目是否与实际完成内容一致（不夸大、不遗漏）
- [ ] 状态标记是否准确（✅ 只用于真正完成的，"差不多"不算完成）
- [ ] 下一步是否明确（读 roadmap 的人能直接行动）

### 4. update-spec-status（更新 spec 状态）

**目标**：同步 spec frontmatter `status` 与实际实现进度，消除 status 腐烂。

**触发**：
- code-review 审查通过后自动调用（契约源为 `.studio/specs/` spec 时，code-review 直接传入 spec 路径）
- 用户说 "更新 spec status" / "同步 spec 状态" / "spec 状态同步"

**输入**：spec 路径（如 `.studio/specs/<slug>.md`；code-review 只在契约源是 spec 时传入）。

**定位 spec**：
```
1. 输入是 spec 路径 → 直接使用
2. 无 spec 路径 → 跳过（不是所有实现都有对应 spec）
```

**规则**：
- 读取 spec 文档 frontmatter
- 根据实现完成状态更新 `status` 字段：
  - 全部 AC 实现 + 测试通过 → `done`
  - 部分 AC 实现 → `in_progress`，在 body 末尾追加已完成 AC 列表
- 更新 `updated` 字段为当前日期（ISO 格式：`YYYY-MM-DD`）
- 状态转换合理性校验：
  - `draft` → `done`：需全部 AC 完成（code-review 通过即为证据）
  - `draft` → `in_progress`：部分 AC 完成
  - `in_progress` → `done`：剩余 AC 全部完成
  - 禁止 `done` → `draft`（已完成的不回退）

**追加完成记录**（可选，大规模 spec 建议追加）：
```markdown
## 实现记录

### YYYY-MM-DD
- status: draft → done
- 实现分支：feat/<slug>
- 来源工单：#<n>
- code-review 通过
- 完成 AC：<AC 编号列表或 "全部">
```

**自检**：
- [ ] spec frontmatter `status` 是否与实际实现进度一致（不夸大、不滞后）
- [ ] `updated` 日期是否已更新为当前日期
- [ ] spec 路径是否正确（code-review 传入或直接指定）
- [ ] 状态转换是否合理（done 不回退，draft→done 需全部 AC 完成）

| 操作 | 错误模式 | 正确做法 |
|------|---------|---------|
| save-progress | 流水账："做了 A，做了 B" | 记录产出+决策+可复用发现，跳过过程细节 |
| update-doc | 只改局部不检查整体一致性 | 改动后通读全文，检查前后引用是否矛盾 |
| update-roadmap | 标 ✅ 但实际未完成（"差不多了就算完成"） | ✅ = 代码合并+测试通过+文档同步，三者缺一不可 |
| update-spec-status | 实现完成但 spec 还是 draft（"改了代码忘了改文档"） | 实现完成后 spec status 必须同步——code-review 通过 = spec→done |
| update-spec-status | 只改 status 不改 updated 日期 | status + updated 一起改，否则前端/搜索无法判断新鲜度 |

## 执行流程

1. **识别操作类型**：根据用户触发词或调用方上下文判断（save-progress / update-doc / update-roadmap / update-spec-status）
2. **确认需求**：
   - save-progress：确认要记录的完成项和待办
   - update-doc：确认要更新的内容
   - update-roadmap：确认要更新的 Phase 和内容
   - update-spec-status：定位 spec（code-review 传入或直接路径），确认当前实现进度
3. **按规范执行**：使用对应的格式和规则
4. **验证**：检查格式是否一致，状态标记是否准确，交叉引用是否同步

--- Self-Review: done ---
