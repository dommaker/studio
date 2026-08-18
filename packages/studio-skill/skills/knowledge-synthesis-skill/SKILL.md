---
name: knowledge-synthesis-skill
description: "从时间窗口的知识集合中产出高阶洞察：语义模式检测与经验教训综合（Loop 自动触发）。"
consumers: [loop]
triggers: [知识综合, 模式检测, knowledge synthesis, 语义聚类, 经验教训, 高阶洞察, 时间窗口, 提议新 skill, pattern detection]
status: published
---

# 知识综合——L2 定时综合扫描

从时间窗口的知识集合中产出高阶洞察。这是知识进化的 L2 层（综合层），区别于 L1 的单次提取。

## 两层架构定位

| 层次 | 触发 | 输入 | 产出 |
|------|------|------|------|
| L1 事件驱动提取 | 单个事件发生时 | feedback/decision/pitfall 事件 | 原子知识条目 |
| **L2 定时综合扫描** | **定时触发（日/周）** | **时间窗口知识集合** | **skill 提议 / 经验总结** |

L1 和 L2 本质不同：L1 是单次捕获，L2 是跨时间窗口的综合。

## 输入源

### 当前实现（已存在的存储）

1. **Knowledge Store**：`~/.studio/knowledge/*.md`
   - 读取时间窗口内创建/修改的知识条目
   - 提取 tags / type / title / body / sourceReferences

2. **Channel 讨论**：FileStore 频道消息（`~/.studio/data/channels/<channelId>/messages.jsonl`）
   - 频道元数据在同目录 `config.json`；先扫描 `~/.studio/data/channels/*/config.json` 定位目标频道
   - 读取时间窗口内的消息（JSONL，按 createdAt 过滤）
   - 提取决策点、争论焦点、共识结论

3. **StudioEvent 事件流**：`~/.studio/logs/studio-events.jsonl`
   - JSONL 事件流（字段：type / source / payload / createdAt；payload 为 JSON 字符串）
   - 读取时间窗口内 type 为 feedback / correction / failure 类的事件
   - 提取失败模式、用户纠正

### 待接入（Agent Network 实现后）

4. **WorkUnit**：（设计中，未实现）
   - 读取近期完成的 WorkUnit（type: task/analysis，status: done）
   - 提取 scope / outcome / metadata
   - **接入备注**：WorkUnit 实现后，新增 `GET /workunits?status=done&updatedAfter=<timestamp>` 查询

### 输入获取流程

```
1. 确定时间窗口（默认 7 天，可配置）
2. 获取 Knowledge Store 条目：
   - find ~/.studio/knowledge/*.md -mtime -7
   - 解析 frontmatter 提取 tags/type/title/created
3. 获取 Channel 讨论：
   - 扫描 ~/.studio/data/channels/*/messages.jsonl，按 createdAt 过滤时间窗口
   - 提取决策相关消息（agentName, content, 关键词匹配）
4. 获取反馈事件：
   - 读 ~/.studio/logs/studio-events.jsonl，过滤 type IN ('feedback','correction','failure') 且 createdAt 在窗口内
   - 提取 payload（JSON 字符串，需二次解析）中的教训
```

---

## 硬门禁

<HARD-GATE>
在阶段 1（预聚类）和阶段 2（LLM 验证）都完成之前，不得输出 skill 提议或经验总结。
没有确定性预聚类的提议 = token 浪费。每个聚类必须有 ≥3 条共享真正的底层模式（不只是表面相似）。
</HARD-GATE>

---

## 子任务 1：语义模式检测 → Skill 提议

### 目标

发现知识条目中的重复模式。当 ≥3 条共享底层模式时，提议创建 skill。

### 执行流程

**阶段 1：确定性预聚类（零 token）**

```
多维度 OR 匹配（任何维度匹配 → 归入同一候选聚类）：

1. Tag 分组：按 tags 字段精确匹配
   - 提取所有条目的 tags
   - 共享 ≥1 个 tag → 候选同组

2. Title 关键词重叠：
   - 提取 title 中的名词/术语（去除停用词）
   - 共享 ≥2 个关键词 → 候选同组

3. SourceReference 重叠：
   - 提取 sourceReferences.workflow 字段
   - 引用相同文件/模块 → 候选同组

4. 时间窗口内创建：
   - 同期条目（7 天内）更可能相关
   - 作为弱信号，不单独成组

合并所有维度匹配 → 候选聚类列表
```

**阶段 2：LLM 语义验证 + 精炼**

```
对每个候选聚类：

1. 读取聚类内所有条目内容
2. LLM 判断：这些条目是否真共享底层模式？
   - 是 → 保留聚类
   - 否 → 拆分（部分条目移出）

3. 检查孤立条目（未进入任何候选聚类）：
   - LLM 判断孤立条目之间是否语义相似
   - 如果 ≥3 条相似 → 形成新聚类

4. 对每个验证后的聚类：
   - 聚类大小 ≥3 → 生成 skill 提议
   - 聚类大小 <3 → 标记为"待观察"（下次再检查）
```

**产出：Skill 提议文档**

```markdown
# Skill 提议 — <date>

## 提议 1：<模式名称>

**证据**（构成聚类的条目）：
1. [pitfall] PIT-004: DATABASE_URL 从 CWD 解析
2. [decision] DEC-012: 所有配置文件用绝对路径
3. [guideline] GUI-038: 验证运行时路径解析 vs 构建时假设

**底层模式**：运行时 vs 构建时配置假设

**提议 Skill**：
- 名称：config-path-validation-skill
- 职责：验证配置文件路径在运行时正确解析
- 触发场景：涉及配置文件加载/路径解析时

**状态**：待用户确认（确认后调用 skill-creator 创建）
```

**存储位置**：`~/.studio/knowledge/skill-proposals/YYYY-MM-DD.md`

### 用户确认流程

1. Skill 提议写入 skill-proposals/
2. 用户在 review 时看到提议（通过 Channel 消息或文件扫描）
3. 用户确认 → 调用 skill-creator 创建 skill
4. 用户拒绝 → 提议标记为 `status: rejected`（避免重复提议）

## 子任务 2：经验教训综合 → 经验总结

### 目标

从时间窗口的知识集合中识别跨主题关联，产出可操作的经验总结。

### 执行流程

```
1. 读取时间窗口内所有输入（Knowledge + Channel + Event）

2. 识别跨主题关联：
   - 多个条目指向同一根本原因
   - 多个失败共享同一模式
   - 多个决策基于同一原则

3. 提取可操作教训：
   - 不是事件摘要（"发生了 X"）
   - 而是可操作洞察（"遇到 Y 场景时，应该 Z"）

4. 生成经验总结文档
```

**产出格式**：

```markdown
# 经验总结 — <date-range>

## 关键教训

### 1. <教训标题>

**场景**：什么时候会遇到这个问题
**洞察**：从多个条目中提炼的根本原因
**行动**：应该怎么做（可操作的建议）
**证据**：相关条目列表

### 2. <教训标题>

...

## 统计

- 扫描条目数：N
- 识别主题数：N
- 关键教训数：N
```

**存储位置**：`~/.studio/knowledge/` 作为知识条目

- type: `process`（如果是流程教训）或 `model`（如果是思维模型）
- tags: 包含 `experience-summary` + 时间窗口标识
- sourceReferences: 列出所有参考的条目 ID

## 触发机制

### 当前实现

使用 CronCreate 实现定时触发：

```
CronCreate:
  cron: "23 10 * * 1"        # 每周一 10:23（避开整点）
  prompt: "执行每周知识综合：运行 knowledge-synthesis-skill，扫描过去 7 天的知识条目/Channel 讨论/事件，产出 skill 提议和经验总结。"
  recurring: true
```

### 未来迁移（Agent Network Trigger Registry）

```
TriggerRegistry:
  id: "knowledge-synthesis-weekly"
  condition: { type: SCHEDULE, config: "23 10 * * 1" }
  action: {
    type: CREATE,
    target: "WorkUnit",
    payload: {
      type: "analysis",
      scope: "Synthesize knowledge from past week: detect patterns → propose skills, extract lessons → experience summary",
      channelId: "knowledge"
    }
  }
```

## 与现有工具的关系

| 场景 | 用什么 |
|------|--------|
| 单次事件 → 知识条目 | knowledge-extraction-skill（L1） |
| **时间窗口 → 高阶洞察** | **knowledge-synthesis-skill（L2，本 skill）** |
| 单条目质量审查 | knowledge-quality-skill |
| 格式合规检查 | harness knowledge audit（CLI） |
| Tag 频次统计 | signal-aggregator（确定性，零 token） |
| 从提议创建 skill | skill-creator |

## 质量门

### 模式检测质量门

1. **聚类有效性**：每个聚类必须有 ≥3 条，且 LLM 确认共享底层模式
2. **Skill 提议价值**：提议的 skill 必须是可操作的（能指导未来行为），不是抽象概念
3. **非重复**：检查现有 skill 列表，避免提议已存在的能力

### 经验总结质量门

1. **可操作性**：每个教训必须有明确的"应该怎么做"，不是"要注意 X"
2. **证据支撑**：每个教训必须引用 ≥2 个条目作为证据
3. **非重复**：检查现有经验总结，避免重复提炼相同教训

### 综合质量门

综合产出的整体质量判定（跨子任务通用）：

1. **语义模式检测**：聚类必须 ≥3 条共享底层模式，不能只看表面相似（相同 tag ≠ 相同模式）
2. **经验教训综合**：必须可操作（"应该怎么做"），不能只是总结（"发生了什么"）
3. **Skill 提议**：必须满足 Step 1-3 的判定标准（可重复 + 单一职责 + 能写出 description）

## 反模式

综合时 Agent 容易犯的错误，执行前必须自检：

| 错误 | 表现 | 正确做法 |
|------|------|----------|
| 表面相似当底层模式 | 都带"测试"tag → 归为同组 | 必须验证底层原因是否一致，tag 只是预聚类信号 |
| 结论太泛 | "要注意质量"、"需要改进" | 必须具体到场景+行动（"遇到 Y 时，应该 Z"） |
| 只看近期数据 | 只综合 7 天内条目，忽略历史模式 | 先查 history 文件，对比历史聚类是否重复出现 |
| Skill 提议太早 | 只有 2 条就提议创建 skill | 必须 ≥3 条共享底层模式才能提议 |
| 经验只是事件列表 | "周一 X 失败，周三 Y 失败" | 必须提炼为可复用方法论（根本原因 + 防范策略） |

## 自检

综合完成后逐项检查，任何一项不通过则修正后再输出：

- [ ] **聚类有效性**：是否有 ≥3 条共享底层模式（不只是表面相似）？
- [ ] **可操作性**：经验总结是否包含"应该怎么做"（不只是"发生了什么"）？
- [ ] **Skill 标准**：skill 提议是否满足 Step 1-3（可重复 + 单一职责 + 能写出 description）？
- [ ] **洞察升级**：产出是否比原始输入有更高阶的洞察（不只是汇总/罗列）？

## 提取数量控制

单次执行：
- Skill 提议：最多 3 个（超过时按聚类大小排序，取 top 3）
- 经验总结：最多 5 个关键教训（超过时按影响范围排序）

理由：
- 知识过载 = 噪音
- 少而精 > 多而粗
- 宁可漏提，不可滥提

## 待办：Agent Network 兼容

当 Agent Network 核心实体实现后，需要：

1. **接入 WorkUnit 输入**：
   - 查询 `GET /workunits?status=done&updatedAfter=<timestamp>`
   - 提取 WorkUnit.scope / outcome / metadata
   - 作为综合输入源之一

2. **使用 Trigger Registry**：
   - 从 CronCreate 迁移到 TriggerRegistry
   - Trigger 创建 analysis 类型 WorkUnit
   - Agent claim 后加载本 skill 执行

3. **Channel 可见性**：
   - Skill 提议写入 Channel 消息（不仅文件）
   - 经验总结写入 Channel 讨论空间
   - 人类/Agent 都能在 Channel 中看到

4. **讨论空间利用**：
   - WorkUnit 讨论空间包含执行过程中的决策/争论
   - 作为经验综合的输入源

这些变更是增量的，不破坏现有实现。Skill 逻辑不变，只是输入源扩展。

--- Self-Review: done ---
