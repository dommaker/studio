---
slug: knowledge-context-boundary
title: 知识上下文边界 — 注入模型 + 质量控制 + Skill 路径修复
status: draft
createdAt: 2026-07-13
---

## AC-1: injectContext 返回类型变更

injectContext 从 `Promise<string>` 改为 `Promise<{ prompt: string; injectedIds: string[] }>`。prompt 为格式化 markdown 注入内容，injectedIds 为被注入的知识条目 ID 列表（供 GAP-6 消费追踪）。

| # | 验收标准 | 涉及文件 |
|---|---------|---------|
| AC-1.1 | injectContext 签名改为 `(taskScope: string) => Promise<{ prompt: string; injectedIds: string[] }>` | `knowledge-service.ts` |
| AC-1.2 | review-agent.service.ts L85 调用改成 `result.prompt` | `review-agent.service.ts` |
| AC-1.3 | review-agent.service.ts L501 调用改成 `result.prompt` | `review-agent.service.ts` |
| AC-1.4 | knowledge-service.routes.ts L210 调用改成 `result.prompt` | `knowledge-service.routes.ts` |

## AC-2: 消费端质量门

injectContext 注入条目时增加过滤条件。

| # | 验收标准 | 涉及文件 |
|---|---------|---------|
| AC-2.1 | 查询加 `status: 'published'` 过滤，未发布知识不可见 | `knowledge-service.ts`（query.queryEntries） |
| AC-2.2 | 条目 `sourceReference` 非空才注入，无来源追溯的知识跳过 | `knowledge-service.ts`（结果过滤） |
| AC-2.3 | 条目 `status !== 'stale'` 才注入，过时标记的知识跳过 | `knowledge-service.ts`（结果过滤） |

## AC-3: 生产端质量门

extractFromExecution 写入 KnowledgeStore 时增加前置条件。

| # | 验收标准 | 涉及文件 |
|---|---------|---------|
| AC-3.1 | 源执行失败时（`!result.success`）设置 `status='need_review'` 而非直接写入 | `knowledge-service.ts`（extractFromExecution） |
| AC-3.2 | 知识条目记录 `sourceExecutionId` 实现来源可追溯 | `knowledge-service.ts`（extractFromExecution entry metadata） |
| AC-3.3 | 写入前查询已有同主题 published 条目，存在则合并而非新增 | `knowledge-service.ts`（extractFromExecution 写入前） |

## AC-4: Rules 治理

rule 的定义、新增门槛与退出机制。

| # | 验收标准 | 涉及文件 |
|---|---------|---------|
| AC-4.1 | 新增 rule 前回答"违反这条的后果是什么？"，答不出则不是 rule | 治理文档 |
| AC-4.2 | 退出机制支持四种条件：架构不对齐、重复/被覆盖、错误分类、从未触发 | 治理文档 |
| AC-4.3 | 初始审计对每条现有 rule 执行"删除测试"——删除后 Agent 出错则保留，否则降级或删除 | 实现时执行 |

## AC-5: GAP-8 Skill 路径修复

extractUserBehavior 写入路径与 skillLoader 读取路径不一致。

| # | 验收标准 | 涉及文件 |
|---|---------|---------|
| AC-5.1 | extractUserBehavior 写入路径改为 `~/.studio/skills/<name>/SKILL.md` | extractUserBehavior |
| AC-5.2 | skillLoader 能发现新写入的 SKILL.md | skillLoader |
| AC-5.3 | `~/.studio/knowledge/skills/` 下已有 skills 迁移到正确路径 | 迁移脚本 |

## AC-6: buildAgentContext 删除

| # | 验收标准 | 涉及文件 |
|---|---------|---------|
| AC-6.1 | `agent-context.ts` 中 `buildAgentContext()` 函数删除 | `agent-context.ts` |
| AC-6.2 | 零调用方确认（grep 验证无引用） | 全局搜索 |
