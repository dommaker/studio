---
id: "hmqdkg08uqf8k0h"
slug: "historical-architecture"
title: "Historical Knowledge: architecture"
status: "done"
tier: "fast"
version: 1
requirementVersion: 1
designVersion: 0
taskVersion: 0
tags: ["architecture", "historical", "entries:16"]
createdAt: "2026-06-14T09:12:30.269Z"
updatedAt: "2026-06-14T09:12:30.269Z"
---

# Historical Knowledge: architecture

Auto-generated from 16 knowledge entries.
Source: `~/.studio/knowledge/`

## Summary

This document aggregates historical architecture knowledge entries
extracted from the knowledge store. Each entry is preserved as a subsection
for reference and future SDD evolution.

## Entries

- [AS-019-knowledge-engine-search](#as-019-knowledge-engine-search) (AS-019-knowledge-engine-search)
- [Complete The Pattern](#complete-the-pattern) (complete_the_pattern)
- [deploy-push-resilience](#deploy-push-resilience) (deploy-push-resilience)
- [feedback_memory_frontmatter](#feedback-memory-frontmatter) (memory_frontmatter)
- [jwt-用户认证系统:-token-刷新-+-oauth2.0-第三方登录](#jwt-auth-system-token-refresh-oauth2-0) (ARC-011)
- [p0-3-修复:-beforeagentdispatch-转发-has*-字段](#p0-3-fix-beforeagentdispatch-has) (ARC-013)
- [p5/p6/p6.5-管线自举：self-document-+-workflow](#p5-p6-p6-5-pipeline-self-document-workflow) (ARC-016)
- [Verify Before Move](#verify-before-move) (verify_before_move)
- [修复-session-manager.ts-+-agent-executor.t](#fix-session-manager-ts-agent-executor-t) (ARC-010)
- [创建-knowledge-冒烟测试文件](#create-knowledge-test) (ARC-015)
- [创建-targetrepo-验证标记文件](#create-targetrepo-auth) (ARC-017)
- [异步调度与同步检索的时序依赖未处理](#sync) (ARC-021)
- [知识自动沉淀与问题自动曝光方案分析](#knowledge-auto-auto-analysis) (auto_precipitate_expose)
- [知识进化引擎六层知识模型与RKB架构](#knowledge-evolution-knowledge-model-rkb-architectu) (knowledge_engine_ops_gap)
- [管线阶段职责分工：Integration vs Review](#pipeline-integration-vs-review) (ARC-014)
- [进化服务扩展第一性分析](#evolution-analysis) (evolution_extension)

## AS-019-knowledge-engine-search

- **ID**: `AS-019-knowledge-engine-search`
- **Source**: `architecture-AS-019-knowledge-engine-search.md`

## 内容
# AS-019 知识引擎查询 + 缓存优化设计

> 创建时间: 2026-05-27
> 状态: 设计完成，待实施

---

## 一、第一性分析

### 知识引擎的本质

```
输入 → 存储 → 查询 → 反馈
              ↑
         当前断在这里
```

当前 410 条知识，三个查询层互相不通：

| 查询层 | 方式 | 受众 | 问题 |
|--------|------|------|------|
| KnowledgeBus.getRecentContext(10) | 按 lastReferenced 排序 | Agent | 不相关也塞，总 800 tokens/次 |
| KnowledgeBus.queryByType(type, 10) | 按 type 过滤 | 无直接调用者 | 需精确知道 type 名 |
| Wiki SQL LIKE | SQL 模糊匹配 | 人 (前端) | 只查 Wiki 文档，不查 KnowledgeStore |
| **CST** | **无通道** | **开发者** |

> ... (truncated)

## Complete The Pattern

- **ID**: `complete_the_pattern`
- **Source**: `architecture-complete_the_pattern.md`
- **Tags**: proactive, completeness, pattern-detection, feedback-rule
- **Created**: 2026-05-23T15:48:02.422Z

## 描述
自行发现同类问题后必须主动全面排查+修复，禁止等用户逐个指出。当你分析出一个结论时，你的责任是沿着这个结论追踪到所有受影响的实例。


## 内容
# Complete The Pattern — 主动排查同类问题

## 触发场景

当你：

1. 分析出一个"问题模式"（如"硬编码路径"、"分类错误"、"遗漏的类型更新"）
2. 修复了其中一个实例
3. 但没有检查是否还有其他受影响的实例

## 规则

发现模式 → 回溯到这个模式的第一次出现 → 从那里开始检查所有受影响的实例 → 批量修复。

禁止行为：
```
用户: "这个脚本有硬编码问题"
我: "修好了"（只修了 script A）
用户: "另外两个也有"
我: "修好了"（修了 script B, C）
用户: "还有 settings.json 里的路径"
我: "修好了"
```

正确行为：
```
用户: "这个脚本有硬编码问题"
我: 全局搜索同类问题 → 发现 A, B, C + settings.json 配置
  → 一次性全部修复
```

## 本次案例

1. 分析出"memor

> ... (truncated)

## deploy-push-resilience

- **ID**: `deploy-push-resilience`
- **Source**: `architecture-deploy-push-resilience.md`
- **Created**: 2026-05-27T12:58:34.011Z

## 内容
# Deploy Push Resilience + Proxy Health

Status: spec | Created: 2026-05-27

## 问题

狗粮跑管线发现 DeployAgent 三个缺口：
1. push 前不检查连通性 → push 静默失败
2. Shadowsocks 上游挂了无人知 → 所有外部流量全断
3. push 失败不告警 → 本地通过、远程没更新

## AC

### AC-1: DeployAgent pushBranch() 加 pre-flight 连通性检查
- push 前执行 `git ls-remote --heads origin`
- 成功 → 继续 push
- 失败 → 抛错，写 GoalExecution.error，不尝试 push

### AC-2: OpsAgent proxyHealth() 代理存活检测
- 每 5min 检测 `ss -tnp | grep <proxy_port> | grep SYN-SENT`
- 发现 2+ 个 SYN-SENT → 判定代理死
- 重试 `sys

> ... (truncated)

## feedback_memory_frontmatter

- **ID**: `memory_frontmatter`
- **Source**: `architecture-memory_frontmatter.md`
- **Created**: 2026-05-27T09:35:27.945Z

## 内容
# Memory Frontmatter Required Fields

## 规则

每次写入 `memory/*.md` 文件时，frontmatter 必须包含：

```yaml
---
ingest: true              # 大多数情况；draft 可跳过
maturity: canonical | verified | draft   # draft = 不入飞轮
type: process              # process | analysis | feedback | architecture
name: <short title>
description: <one-line summary>
date: YYYY-MM-DD
tags: [tag1, tag2]
---
```

## 为什么

`memory-knowledge-sync.js` hook 靠 frontmatter 判断是否需要同步到 KnowledgeStore：
- `maturity: draft` → 跳过（未完成的知识）
- 缺少 `matur

> ... (truncated)

## jwt-用户认证系统:-token-刷新-+-oauth2.0-第三方登录

- **ID**: `ARC-011`
- **Source**: `architecture-ARC-011.md`
- **Created**: 2026-05-24T06:18:07.063Z

## JWT 用户认证系统: Token 刷新 + OAuth2.0 第三方登录
完整的 JWT 认证系统：bcrypt 密码加密、JWT 签发/验证、refresh token 轮转、Google/GitHub OAuth2.0、前端自动刷新拦截器、RBAC 中间件

### Modules Analyzed
- **jwt-core**: apps/api/src/modules/auth/service.ts, packages/studio-prisma/prisma/schema.prisma
- **refresh-token**: apps/api/src/modules/auth/service.ts, apps/api/src/modules/auth/routes.ts
- **oauth2**: apps/api/src/modules/auth/oauth.service.ts, apps/api/src/modules/auth/oauth.routes.ts, apps/api/src/modules/auth/service.ts
- **auth-mid

> ... (truncated)

## p0-3-修复:-beforeagentdispatch-转发-has*-字段

- **ID**: `ARC-013`
- **Source**: `architecture-ARC-013.md`
- **Created**: 2026-05-25T03:56:26.941Z

## P0-3 修复: beforeAgentDispatch 转发 has* 字段
beforeAgentDispatch 缺少将调用方传入的 has* 字段转发给 checkBeforeExecution，导致 dispatch 阶段产生冗余 warning。对照 beforeAgentExecute 模式补全。

### Modules Analyzed
- **fix-beforeAgentDispatch-has-fields**: packages/studio-shared/src/harness/hooks/goal.hooks.ts

### Key Patterns
- 参照实现: agent.hooks.ts:L20-L28 — `hasVerificationEvidence: (ctx as any).hasVerificationEvidence,` 等 9 个字段的转发模式

### Gotchas
- ⚠️ 不可删除 hasWorktree/WorktreePath（下游: goal-scheduler.ts dispatches to agentExe

> ... (truncated)

## p5/p6/p6.5-管线自举：self-document-+-workflow

- **ID**: `ARC-016`
- **Source**: `architecture-ARC-016.md`
- **Created**: 2026-06-10T16:33:57.533Z

## P5/P6/P6.5 管线自举：Self-Document + Workflow Skills + Skill 统一
三模块管线自举：P5 代码结构提取+LLM 文档生成，P6 三个 workflow skill 定义，P6.5 统一 loadSkill/buildSkillPrompt 接口 + 硬编码迁移

### Modules Analyzed
- **p5-harness**: harness/src/knowledge/code-analysis.ts, harness/src/knowledge/index.ts
- **p5-studio**: apps/api/src/modules/knowledge/improver-scheduler.service.ts
- **p6-workflow-skills**: ~/.studio/skills/goal-start/req/SKILL.md, ~/.studio/skills/goal-start/impl/SKILL.md, ~/.studio/skills/review/code-review/SKILL

> ... (truncated)

## Verify Before Move

- **ID**: `verify_before_move`
- **Source**: `architecture-verify_before_move.md`
- **Tags**: decision-making, verification, classification, feedback-rule
- **Created**: 2026-05-23T15:48:02.103Z

## 描述
操作决策前先验证现有状态。涉及文件归属、职责判断、分类标签的决策，必须先读目标文件内容再下结论。禁止基于文件名或目录位置做推断。


## 内容
# Verify Before Move — 操作决策前先验证

## 触发场景

以下决策不能基于"文件名/目录位置/经验判断"，必须先读内容再下结论：

- 判断某个文件"属于哪个包/哪个项目"
- 判断某个脚本是"业务逻辑/框架代码/约束实现"
- 给文件打分类标签（"这是 X，不是 Y"）
- 移动/删除文件的操作

## 规则

做上述决策前：`Read` 文件内容 → 分析它实际做什么 → `再下结论`。

禁止路径：
```
看到路径 bin/xxx.sh → "这是业务脚本" → 移动  ← 没读内容就下结论
```

正确路径：
```
看到路径 bin/xxx.sh → Read 内容 → 分析实际职责 → "它是约束实现" → 保持原位
```

## 本次案例

`harness/bin/harness-knowledge-track.sh`：看到文件名在 bin/ 目录 → 判断为"studio 业务逻辑

> ... (truncated)

## 修复-session-manager.ts-+-agent-executor.t

- **ID**: `ARC-010`
- **Source**: `architecture-ARC-010.md`
- **Created**: 2026-05-24T06:03:05.422Z

## 修复 session-manager.ts + agent-executor.ts 的 execSh pipe 处理
将两个文件中 `cat file | claude` 的 shell pipe 模式替换为 `< file` 文件重定向，移除 `--dangerously-skip-permissions`（统一用 settings.json bypassPermissions），移除冗余的 `2>&1 | tee`（execSh 已捕获 stdout/stderr），解决 Node spawn stdio: 'ignore' 配置下的管道路径脆弱性。

### Modules Analyzed
- **ac1-verify-session-manager-fix**: apps/api/src/daemon/session-manager.ts
- **ac2-fix-agent-executor-pipe**: packages/studio-agent/src/services/agent-executor.ts

### Key Patterns
- execSh sp

> ... (truncated)

## 创建-knowledge-冒烟测试文件

- **ID**: `ARC-015`
- **Source**: `architecture-ARC-015.md`
- **Created**: 2026-06-11T12:26:10.837Z

## 创建 knowledge 冒烟测试 v3 文件
在 apps/api/src/modules/knowledge/__tests__/ 下创建 smoke-test-v3.ts，内容为一行注释

### Modules Analyzed
- **smoke-test-v3-file**: apps/api/src/modules/knowledge/__tests__/smoke-test-v3.ts

### Key Patterns
- 参考 smoke-test-v2.test.ts 同目录

### Gotchas

## 创建-targetrepo-验证标记文件

- **ID**: `ARC-017`
- **Source**: `architecture-ARC-017.md`
- **Created**: 2026-06-10T16:14:34.782Z

## 创建 targetRepo 验证标记文件
在 channels 目录下创建 smoke-test-targetrepo.txt 文件，内容为 targetRepo validation works

### Modules Analyzed
- **create-smoke-test-file**: apps/api/src/modules/channels/smoke-test-targetrepo.txt

### Key Patterns

### Gotchas

## 异步调度与同步检索的时序依赖未处理

- **ID**: `ARC-021`
- **Source**: `architecture-ARC-021.md`
- **Created**: 2026-05-31T18:15:44.815Z

根因：scheduleVectorDbSync是异步任务，而CLI ingest和local-rag检索假设数据已同步完成，但未处理同步延迟或失败场景，导致检索结果为空或过期。责任归属：架构设计未考虑异步操作的最终一致性，未引入等待或重试机制。预防措施：在CLI ingest前增加轮询或回调机制确认向量数据库同步完成；为local-rag添加数据版本号或时间戳，支持一致性读取。

## 知识自动沉淀与问题自动曝光方案分析

- **ID**: `auto_precipitate_expose`
- **Source**: `architecture-auto_precipitate_expose.md`

## 描述
第一性分析：开发者文档→Studio知识引擎自动沉淀的内存成熟度门方案，预存TypeScript错误自动曝光的baseline diff方案，推荐实施优先级(pre-commit tsc gate先于曝光)


## 内容
# 自动化沉淀 + 自动化发现问题曝光 — 第一性分析

2026-05-23

## 0. 前置发现

项目当前状态：
- **零 CI** — 无 pre-commit hooks、无 GitHub workflows、无 lint-staged
- **零类型检查** — 没有任何 `tsc --noEmit` 作为质量门
- **tsconfig strict: false** — 所有包的严格检查全部关闭
- **已有 harness hooks** — `settings.json` 里 PostToolUse(Write) + Stop 都有钩子
- **已有 local-rag MCP** — `ingest_file` / `ingest_data` / `query_documents` 可用

## 1. 知识自动沉淀 (memor

> ... (truncated)

## 知识进化引擎六层知识模型与RKB架构

- **ID**: `knowledge_engine_ops_gap`
- **Source**: `architecture-knowledge_engine_ops_gap.md`

## 描述
第一性分析：自举系统应学习的六层知识(L1代码/L2偏好/L3工具行为/L4环境配置/L5错误解法/L6跨会话因果)，Resolution Knowledge Base 设计与 Phase 1 实现


## 内容
# Knowledge Engine — 运维配置类覆盖缺口（第一性分析 + Phase 1 实现）

2026-05-23

**Phase 1 状态：已完成** (B7-006, 2026-05-23)
- Resolution Prisma 模型 + 迁移
- ResolutionService (match/create/verify/seed)
- agent-executor 失败 → 查询 Resolution → 注入 retry prompt
- Auditor 日审 → 新 pattern → 自动创建 pending Resolution
- 预置 seed: root + dangerously-skip-permissions → canonical
- 详见 `docs/roadmap.md` B7-006

**六层覆盖 (Phas

> ... (truncated)

## 管线阶段职责分工：Integration vs Review

- **ID**: `ARC-014`
- **Source**: `architecture-ARC-014.md`
- **Created**: 2026-06-13T03:37:57.605Z

根因：管线各阶段职责重叠导致重复劳动和效率低下。Integration和Review都跑测试，浪费token且职责不清。责任归属：管线设计阶段未明确区分确定性验证与LLM推理。预防措施：Integration只做合并+tsc+影响范围测试（确定性验证），Review只做LLM审查（AC合规、代码质量、安全性），Review发现问题后走回Executor修复→Integration重新验证的闭环。

## 进化服务扩展第一性分析

- **ID**: `evolution_extension`
- **Source**: `architecture-evolution_extension.md`
- **Tags**: evolution, architecture, auditor, session-summary, behavior-patterns, first-principles
- **Created**: 2026-05-23T16:32:04.682Z

## 描述
为什么"开发会话 behavior → 进化服务"行不通 — 代码质量进化 vs 行为模式改进是两个不同维度，需要不同的检测/输出/执行机制。正确方案：Auditor + session:summary 做趋势洞察，不自动进化约束。


## 内容
# 进化服务扩展第一性分析

2026-05-24

## 结论

**"开发会话 behavior pattern → 进化服务 → 约束提案"这个方案有根本性的架构问题。** 不是因为实现复杂，而是因为代码质量进化和行为模式改进是两个不同维度的问题。

## 现有进化服务

```
输入: Agent 执行错误 (结构化文本)
检测: 同 error pattern 跨 3+ goals (正则/关键词匹配)
输出: harness 约束定义 → npx harness check 强制执行
消费者: Agent (下次执行被 check 拦截)
```

## "开发会话 behavior" 的本质差异

### 检测信号不同

- 执行错误: 字符串匹配 → `TypeError: x is not a function

> ... (truncated)
