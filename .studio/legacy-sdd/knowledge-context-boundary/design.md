---
slug: knowledge-context-boundary
title: 知识上下文边界 — 注入模型 + 质量控制 + Skill 路径修复
status: draft
createdAt: 2026-07-13
---

## 1. injectContext 两层模型架构

### 模型结构

```
injectContext(taskScope: string): Promise<{ prompt: string; injectedIds: string[] }>

  ┌─ System Constraints ──────────────────────────
  │ rules（全量内容）
  │ 条件：consumptionMode='rule', status='published'
  │ 数量严格受限，理想 <15 条
  │
  └─ Knowledge Index ─────────────────────────────
     name + description 索引（参考 skillLoader.formatForPrompt()）
     Agent 按需 MCP query → 装载全文
```

**第一层 - Rules**：全量内容注入。条件为 `consumptionMode='rule'` 且 `status='published'`。数量严格受限，理想不超过 15 条。

**第二层 - Knowledge Index**：仅注入 name + description 索引。Agent 按需通过 MCP query 装载全文。格式参考 `skillLoader.formatForPrompt()`。

### 核心原则

业务知识非必要不注入。注入最小化 = 缓存稳定 + Agent 选择负担小。

### 不在模型范围内的内容

| 内容 | 原因 | 归属 |
|------|------|------|
| CONTEXT.md | Claude CLI 自动加载，AI 治理 Skill 独立维护 | 独立 Skill |
| Signals | 执行产出的系统事件，给后评估/监控 Agent 消费 | 后评估链路 |
| 上下文语境 | 与具体项目有关，通用模板供参考 | 独立管理 |

## 2. 返回类型变更影响范围

### 变更

```typescript
// 当前
injectContext(taskScope: string): Promise<string>

// 变更后
injectContext(taskScope: string): Promise<{ prompt: string; injectedIds: string[] }>
```

### 影响的三处调用点

| 位置 | 改动 | 风险 |
|------|------|------|
| `review-agent.service.ts` L85 | `.prompt` 属性访问 | 低（同文件两处） |
| `review-agent.service.ts` L501 | `.prompt` 属性访问 | 低 |
| `knowledge-service.routes.ts` L210 | `.prompt` 属性访问 | 低 |

### injectedIds 消费链路

injectedIds 输出给 agent-loop → `recordOutcome` 做消费追踪（GAP-6），当前阶段仅返回不消费。

## 3. 质量门实现位置

### 消费端（injectContext）

当前只按 consumptionMode 分类查询，缺少三个过滤条件。实现位置在 `knowledge-service.ts` 的 `query.queryEntries` 查询和结果过滤：

| 检查项 | 实现方式 | 位置 |
|--------|---------|------|
| status='published' 过滤 | Prisma 查询条件加 `status: 'published'` | `query.queryEntries` 查询 |
| sourceReference 非空 | 结果数组 `.filter(e => e.sourceReference)` | `query.queryEntries` 结果后处理 |
| stale flag 排除 | 结果数组 `.filter(e => e.status !== 'stale')` | `query.queryEntries` 结果后处理 |

注意：`status='stale'` 是独立状态，不在 `status='published'` 查询范围内，因此 `stale` 过滤主要作为防御性检查。

### 生产端（extractFromExecution）

当前只检查 diff 非空，缺少三个前置条件。实现位置在 `knowledge-service.ts` 的 `extractFromExecution`：

| 检查项 | 实现方式 | 位置 |
|--------|---------|------|
| 源执行成功 flag | `if (!result.success)` → `status='need_review'` | extractFromExecution 入口 |
| 来源可追溯 | 写入 `sourceExecutionId` 到 entry metadata | extractFromExecution 写入参数 |
| 去重 | 写入前查询已有同主题 published 条目 → 合并而非新增 | extractFromExecution 写入前 |

### 验证端（后评估，当前阶段不实现）

依赖 GAP-6 消费追踪数据。设计参考：

```
每次执行后：
  1. 注入的知识是否被引用？（output 中是否提及）
  2. 提取的知识是否正确？（后评估 WorkUnit 抽查）

低引用率 → flag 该条目 pending_review
高引用率 + 高成功率 → 质量好，维持
```

## 4. Rules 治理设计

### rule 定义

rule = **删除这条，Agent 会产生错误代码或违反安全约束**。测试方法：假设删掉这条 → Agent 会不会出错？会 → rule。不会 → 不是 rule，降级。

### 新增门槛

每加一条 rule 需回答"违反这条的后果是什么？"。答不出 → 不是 rule，走 context 或其他分类。

### 退出机制

| 退出条件 | 判断方式 |
|---------|---------|
| 架构不对齐 | rule 引用的模块/API/工具已不存在 |
| 重复/被覆盖 | 另一条 rule 已覆盖同样约束 |
| 错误分类 | 本质是建议不是约束 |
| 从未触发 | 消费追踪显示执行中从未引用 |

### 初始审查

实现时对每条现有 rule 执行"删除测试"——删除后 Agent 出错则保留，否则降级或删除。

## 5. GAP-8 路径变更

### 变更对比

| 维度 | 当前 | 修复后 |
|------|------|--------|
| 写入路径 | `~/.studio/knowledge/skills/<name>.md` | `~/.studio/skills/<name>/SKILL.md` |
| 读取路径 | `~/.studio/skills/<name>/SKILL.md` | 不变 |
| 数据迁移 | 无 | `~/.studio/knowledge/skills/` → `~/.studio/skills/` |

### 代码变更

```typescript
// 当前
const SKILLS_DIR = path.join(os.homedir(), '.studio', 'knowledge', 'skills');

// 修复
const SKILLS_DIR = path.join(os.homedir(), '.studio', 'skills');
```

## 6. buildAgentContext 删除

`agent-context.ts` 的 `buildAgentContext()` 零调用方。原职责拆分如下：

| 原职责 | 新去向 |
|--------|--------|
| Harness 约束注入 | injectContext rules 层自动注入（consumptionMode='rule' 条目入知识库） |
| Skill 索引 | agent-runner 直接调用 skillLoader.load({ tier }) + formatForPrompt()（GAP-7 已处理） |

不再需要单独的组装函数。
