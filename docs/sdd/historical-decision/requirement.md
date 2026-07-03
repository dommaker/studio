---
id: "hmqdkg08x8bljcb"
slug: "historical-decision"
title: "Historical Knowledge: decision"
status: "done"
tier: "fast"
version: 1
requirementVersion: 1
designVersion: 0
taskVersion: 0
tags: ["decision", "historical", "entries:4"]
createdAt: "2026-06-14T09:12:30.273Z"
updatedAt: "2026-06-14T09:12:30.273Z"
---

# Historical Knowledge: decision

Auto-generated from 4 knowledge entries.
Source: `~/.studio/knowledge/`

## Summary

This document aggregates historical decision knowledge entries
extracted from the knowledge store. Each entry is preserved as a subsection
for reference and future SDD evolution.

## Entries

- [API Key 按用途命名而非按厂商命名](#api-key) (DEC-001)
- [Skill加载机制双路径：CLAUDE.md驱动 vs MCP按需加载](#skill-load-claude-md-vs-mcp-load) (DEC-004)
- [Spec 变更系统（SP-002/SP-003）无消费方应标记废弃](#spec-change-system-sp-002-sp-003-consume) (DEC-003)
- [选择local-rag作为检索端但未验证性能基线](#local-rag-auth) (DEC-002)

## API Key 按用途命名而非按厂商命名

- **ID**: `DEC-001`
- **Source**: `decision-DEC-001.md`
- **Created**: 2026-05-31T16:39:20.300Z

根因：原命名 `ANTHROPIC_AUTH_TOKEN`、`DEEPSEEK_API_KEY` 与厂商耦合，无法灵活切换不同 LLM 供应商。
责任归属：初始设计时未考虑多供应商场景。
预防措施：改为按用途命名——`STUDIO_API_KEY`（开发会话）、`PIPELINE_API_KEY`（管线执行，隔离缓存）、`KNOWLEDGE_API_KEY`（知识提取）。配置文件中不限制厂商，用户可自由填入任意 LLM 的 key。

## Skill加载机制双路径：CLAUDE.md驱动 vs MCP按需加载

- **ID**: `DEC-004`
- **Source**: `decision-DEC-004.md`
- **Created**: 2026-06-13T03:37:57.789Z

根因：直接对话场景下Agent无法感知~/.studio/skills/下的Skill，MCP按需加载需要配置且Agent不会主动调用。责任归属：Skill设计未考虑Agent消费场景。预防措施：直接对话通过CLAUDE.md嵌入场景→Skill映射表（≤10个直接写，>10个用MANIFEST.md索引），Agent读表后直接读SKILL.md文件；管线Executor通过SkillLoader索引注入+MCP loadSkill。零MCP开销，零延迟。

## Spec 变更系统（SP-002/SP-003）无消费方应标记废弃

- **ID**: `DEC-003`
- **Source**: `decision-DEC-003.md`
- **Created**: 2026-06-02T12:49:10.576Z

根因：SP-002（submit-change）和 SP-003（GateChecker）的 API 端点已实现，但管线、Agent、前端均无调用方。系统实际流程是直接编辑 git 文件 commit，无需审批门禁。
责任归属：设计时未验证实际使用场景。
预防措施：实现前先确认消费方是否存在。对无消费方的系统，标记废弃而非继续优化（如 N10 GateChecker 全量接入）。

## 选择local-rag作为检索端但未验证性能基线

- **ID**: `DEC-002`
- **Source**: `decision-DEC-002.md`
- **Created**: 2026-05-31T18:15:46.221Z

根因：采用local-rag（本地RAG）作为检索终端，但未定义性能基线（如响应时间、召回率），导致验证时无法判断检索质量是否达标。责任归属：技术选型时未设定验收标准，开发团队未编写性能测试。预防措施：在验证流程中嵌入性能测试，设定响应时间<500ms、召回率>90%等基线；使用基准数据集定期回归测试，并记录历史趋势。
