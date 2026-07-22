---
name: knowledge-extraction
description: "从近期工作产物中提取可复用知识，去重后写入知识库（Loop 自动触发，也支持用户请求）。"
consumers: [loop]
triggers: [知识提取, 提取知识, 沉淀知识, knowledge extraction, 工作产物, 知识条目, session memory, batch progress, 可复用知识]
status: published
---

# 知识提取 — Loop-trigger 版本

从近期工作产物中自动提取可复用知识。飞轮转动：执行 → 沉淀 → 消费。

提取的知识必须**可复用**——如果下次遇到同类问题不能帮到 Agent，就不值得记录。

## 触发模式

### Loop-trigger（主要模式）

每日自动执行。触发后：
1. 扫描近期工作产物（batch progress、session memory、分析文档）
2. 识别提取机会（见 Define 阶段）
3. 去重检查（trace 阶段）
4. 提取 + 写入（Diagnose → Fix → Verify）

### User-trigger（辅助模式）

用户说"提取知识"/"沉淀知识"时，从当前任务结果提取。流程相同，但扫描源是当前会话而非文件。

---

## 硬门禁

<HARD-GATE>
在 Step 2.5 质量门和 Step 3 去重检查都通过之前，不得写入任何知识条目。跳过质量门 = 噪音注入。每个候选必须通过"值得提取"标准和去重查询后才能写入文件。
</HARD-GATE>

---

## 执行流程

### Step 1: 扫描源定位

**Loop-trigger**：扫描以下目录的近期文件（最近 7 天修改）：

```
扫描目录：
1. ~/.claude/projects/-root-projects/memory/
   - project_batch_progress_*.md（批次进展）
   - analysis_*.md（分析文档）
   - feedback_*.md（用户纠正）
   - issue_*.md（问题记录）

2. studio/docs/specs/design/*.md（近期完成的设计文档，status 从 draft → completed）
```

**User-trigger**：扫描当前会话的 task result（已完成的任务、调试结果、设计决策）。

### Step 2: 识别提取机会（Define）

从扫描到的文件中，识别以下信号：

| 信号 | 提取类型 | 示例 |
|------|---------|------|
| 任务失败 + 根因已定位 | pitfall | 调试 2 小时发现是环境变量问题 |
| 在多个方案中做了选择 | decision | 选 Prisma vs Drizzle |
| 发现一个可复用的做法 | guideline | "所有 API 响应统一用 Result 类型" |
| 设计了系统结构 | architecture | 知识引擎三层架构 |
| 建立/改进了流程 | process | 代码审查三阶段流程 |
| 用户纠正了 Agent 行为 | feedback→guideline | "不要删除零引用代码" |

**不值得提取的信号**：
- 纯事件日志（"X 报错 Y"，无后续分析）
- 一次性状态（"部署成功"，无新发现）
- 已被现有条目覆盖的内容（grep 验证）
- 进度报告本身（batch progress 是事件记录，不是知识）

### Step 2.5: 提取质量门

Step 2 识别出候选信号后，用以下标准判断是否值得提取。

**值得提取（通过质量门）**：

| 维度 | 标准 | 示例 |
|------|------|------|
| 可复用模式 | 下次遇到同类问题能帮到 Agent | "API 响应统一用 Result 类型" |
| 根因分析 | 不只是现象，有因果链 | "Prisma migrate 失败是因为 file:./ 从 CWD 解析" |
| 决策理由 | 不只是结论，有取舍分析 | "选 X 因为 Y，放弃 Z 因为 W" |
| 领域适用性 | 描述的系统和当前架构一致 | 系统已废弃 → 提取通用模式，不绑定旧系统 |

**不值得提取（拦截）**：

| 维度 | 标准 | 示例 |
|------|------|------|
| 一次性事件 | 不可复用，下次不会遇到 | "今天手动修了第 42 行的 typo" |
| 表面现象 | 没有根因，只知道结果 | "测试偶尔失败"（没有定位原因） |
| 语义重复 | 已有条目表述相同教训 | 与 pitfall-PIT-001 内容重叠 |
| 领域已废弃 | 知识绑定到已不存在的系统 | Pipeline 特有的调度教训（系统已不存在） |

**泛化标准**：从具体事件中提取通用模式。

```
✗ "这次 DATABASE_URL 配错导致迁移失败"（太具体）
✓ "file:./ 路径的 SQLite 从 CWD 解析，非 schema 位置"（通用模式）

✗ "要注意质量"（太泛）
✓ "新文件零测试不可提交，pre-commit 必须响应"（可操作）

✗ "用户喜欢简洁代码"（偏好）
✓ "单次执行最多提取 3 条，宁缺毋滥"（可复用规则）
```

**形态判断**：判断候选属于知识/数据/Skill/规则哪种形态，写入正确的层。

| 形态特征 | 判断结果 | 处理 |
|---------|---------|------|
| 含百分比/统计数字/accuracy 数据 | data | 写 `~/.studio/data/`，不写 knowledge/ |
| 多步骤流程（>500 字） | skill | 提取为 Skill，不写 knowledge/ |
| 短指令式（<100 字，"禁止..."） | rule | 写入 CLAUDE.md rules，不写 knowledge/ |
| 通用模式/教训/架构决策 | knowledge | 正常写入 knowledge/ |

代码层实现：`validateKnowledgeForm()` in `knowledge-service.ts`。safeIngest 自动路由。

### Step 3: 去重检查（Trace）

提取前必须检查现有知识库，避免重复：

```
1. 用 mcp__local-rag__query_documents 查询候选知识的关键词
2. 检查返回结果中是否有语义重复（标题相似、内容重叠）
3. 如果已有类似条目：
   - 内容互补 → 更新现有条目（补充新上下文/sourceReference）
   - 内容重复 → 跳过
   - 视角不同 → 新建条目，但在 description 中说明与现有条目的关系
```

### Step 4: 提取核心知识（Diagnose）

从文件内容中提炼可复用部分：

**pitfall** 必须包含：
- 现象（用户看到了什么）
- 根因（为什么发生，不是表面原因）
- 解法（怎么修复，怎么预防）

**decision** 必须包含：
- 选项（考虑了哪些方案）
- 结论（选了哪个）
- 理由（为什么选这个，放弃了什么）

**guideline** 必须包含：
- 规则（应该怎么做）
- 适用场景（什么时候用）
- 反例（什么时候不用，边界在哪）

**architecture** 必须包含：
- 问题背景（解决什么问题）
- 方案（怎么解决）
- 取舍（tradeoffs，放弃了什么）

**feedback**（从用户纠正提取）必须包含：
- 错误行为（Agent 做了什么不该做的）
- 根因（为什么会犯这个错）
- 正确行为（应该怎么做）
- 适用场景（什么情况下适用这条规则）

### Step 4.5: 常见错误反模式

提取过程中 Agent 容易犯的错误，Step 4 完成后逐项自查：

| # | 反模式 | 错误示例 | 正确做法 |
|---|--------|---------|----------|
| 1 | **事件当知识** | "今天重构了 pipeline 模块" | "pipeline 模块拆分标准：单一职责 + 消费方独立部署" |
| 2 | **只提成功不提失败** | "用 X 方案解决了问题" | "尝试 A/B 失败，最终用 C，因为 D 约束" |
| 3 | **太泛** | "要注意代码质量" | "新文件零测试不可提交" |
| 4 | **太具体** | "第 42 行有 bug" | "file:./ 路径的 SQLite 从 CWD 解析" |
| 5 | **不去重** | 写入与现有条目语义重复的内容 | 先 query_documents，有重复则更新或跳过 |
| 6 | **偏好当知识** | "用户喜欢用 Prisma" | "选 Prisma 因为类型安全 + migration 自动化" |

### Step 5: 写入知识条目（Fix）

使用正确的 frontmatter 格式：

```yaml
---
id: <TYPE>-<NNN>           # pitfall-PIT-004, guideline-GUI-062
type: pitfall|guideline|decision|architecture|process|model
title: 简洁标题（<60 字符）
maturity: draft            # 新建用 draft
layer: tech|project|system  # tech=具体代码, project=工程实践, system=跨项目
created: <ISO timestamp>
tags:
  - 关键标签（2-5 个，遵循 tag 规范）
applicablePhases: []        # 适用阶段
sourceReferences:
  - workflow: <来源文件路径或会话描述>
    timestamp: <ISO timestamp>
---
```

**Tag 规范**（保证聚类可靠性）：

1. **格式**：
   - 小写，连字符分隔（`database-config` 不是 `DatabaseConfig`）
   - 单数形式（`pattern` 不是 `patterns`）
   - 每条目 2-5 个 tag

2. **维度要求**：
   - 至少一个主题 tag（`agent-network` / `knowledge` / `architecture` / `testing` / `skill`）
   - 至少一个技术/领域 tag（`typescript` / `prisma` / `process` / `design`）

3. **一致性检查**（写入前必须执行）：
   - 查询 `~/.studio/knowledge/` 现有 tag 集合：`grep -h "^  - " ~/.studio/knowledge/*.md | sort -u`
   - 如果新概念与现有 tag 语义相似 → 用现有 tag（`db` 已存在就不用 `database`）
   - 只有真正新的概念才创建新 tag
   - 禁止同义词并存（`database` 和 `db` 不能同时存在）

4. **常见 tag 参考**：
   - 主题：`agent-network` / `knowledge` / `architecture` / `testing` / `skill` / `deployment` / `documentation`
   - 技术：`typescript` / `prisma` / `sqlite` / `api` / `cli`
   - 概念：`process` / `pattern` / `decision` / `feedback` / `error-handling`
   - 层级：`tech` / `project` / `system`

这个规范保证 knowledge-synthesis-skill 的 grep 预聚类能可靠工作。

ID 生成规则：
- pitfall: PIT-NNN（查 `~/.studio/knowledge/pitfall-*.md` 最大值 +1）
- guideline: GUI-NNN
- decision: DEC-NNN
- architecture: ARC-NNN
- process: PRS-NNN
- model: MOD-NNN

文件名：`<type>-<id>.md`（如 `pitfall-PIT-004.md`）

### Step 6: 质量门（Verify）

写入前自检：

1. **语义完整性**：body 包含该 type 的所有必需内容（见 Step 4）
2. **内容价值**：满足三条标准中的至少两条
   - 有具体上下文（哪个系统/文件/场景）
   - 有可操作结论（应该怎么做/不应该怎么做）
   - 有因果链（为什么是这样）
3. **非重复**：local-rag 查询确认没有语义重复的条目
4. **标签准确**：标签能准确描述内容，不用泛化标签（如 "bug"、"fix"）

### Step 6.5: 自检

提取完成后，逐项检查每个新条目。任一项不通过则修正后再写入。

| # | 检查项 | 通过标准 | 不通过处理 |
|---|--------|---------|-----------|
| 1 | **可复用性** | 下次遇到同类问题，Agent 能直接消费此条目 | 改写为通用模式，或丢弃 |
| 2 | **有根因/理由** | 包含"为什么"，不只是"是什么" | 补充因果链，或降级为事件记录（不写入） |
| 3 | **泛化程度** | 不太泛（可操作）、不太具体（可复用） | 按泛化标准调整抽象层级 |
| 4 | **去重** | 与已有条目无语义重复 | 更新现有条目，或跳过 |
| 5 | **领域适用** | 描述的系统/模块在当前架构中存在 | 剥离系统绑定，提取通用模式；或丢弃 |

**快速自检口诀**：

```
能复用？→ 有根因？→ 不太泛也不太具体？→ 不重复？→ 领域还活着？→ 通过
```

### Step 7: 输出摘要（Converge）

完成后输出提取报告：

```
## 知识提取报告 — <date>

扫描文件：N 个
提取机会：N 个
实际提取：N 条（跳过 N 条：重复 X / 无价值 Y）

### 新增条目
1. [TYPE] title — 来源文件 — 提取原因
2. ...

### 更新条目
1. [TYPE] title — 补充了什么 — 来源
2. ...

### 跳过项
1. "候选标题" — 跳过原因（已有类似条目 / 纯事件记录）
2. ...
```

## 提取数量控制

单次执行最多提取 3 条。超过 3 条时，只提取最重要的。理由：
- 知识过载 = 噪音（见 flywheel health 的 67% 噪音问题）
- 少而精 > 多而粗
- 宁可漏提，不可滥提

**优先级排序**（从高到低）：
1. feedback（用户纠正 → 行为规则，价值最高）
2. pitfall（根因已定位的失败教训）
3. decision（有明确理由的架构/技术选择）
4. guideline（可复用的做法）
5. architecture（系统设计）

## Loop-trigger 调度配置

当前使用 CronCreate 实现每日触发：

```
CronCreate:
  cron: "17 9 * * *"        # 每天 9:17（避开整点）
  prompt: "执行每日知识提取：扫描 ~/.claude/projects/-root-projects/memory/ 最近 7 天的文件，按 knowledge-extraction skill 流程提取知识。"
  recurring: true
```

未来迁移到 Agent Network Trigger Registry 后：

```
TriggerRegistry:
  id: "knowledge-extraction-daily"
  condition: { type: SCHEDULE, config: "17 9 * * *" }
  action: {
    type: CREATE,
    target: "WorkUnit",
    payload: {
      type: "analysis",
      scope: "Extract reusable knowledge from recent work artifacts",
      channelId: "knowledge"
    }
  }
```

## 与其他 skill/CLI 的关系

| 场景 | 用什么 |
|------|--------|
| 从工作产物中提取知识 | knowledge-extraction（本 skill） |
| 检查已有条目的语义质量 | knowledge-quality-skill |
| 检查格式合规 | harness knowledge audit（CLI） |
| 检查引用/新鲜度 | harness knowledge health（CLI） |
| 从重复模式中抽象 skill | skill-creator |

## 提取质量红线

以下情况**不提取**：

1. **纯事件记录**："完成了 X" / "部署了 Y" — 没有可复用知识
2. **已有覆盖**：grep 发现现有条目已包含相同教训
3. **一次性上下文**：只对一个特定任务有意义，下次不会遇到
4. **因果链不完整**：知道结果但不知道根因（先诊断，再提取）
5. **无法操作化**：提取出的知识不能指导未来行为（"要注意 X" 不算）
6. **领域已废弃**：知识绑定到已不存在的系统/模块（如 Pipeline 特有逻辑），除非能剥离为通用模式

--- Self-Review: done ---
