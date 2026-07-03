---
id: "hmqdkg0958g4bm1"
slug: "historical-model"
title: "Historical Knowledge: model"
status: "done"
tier: "fast"
version: 1
requirementVersion: 1
designVersion: 0
taskVersion: 0
tags: ["model", "historical", "entries:2"]
createdAt: "2026-06-14T09:12:30.281Z"
updatedAt: "2026-06-14T09:12:30.281Z"
---

# Historical Knowledge: model

Auto-generated from 2 knowledge entries.
Source: `~/.studio/knowledge/`

## Summary

This document aggregates historical model knowledge entries
extracted from the knowledge store. Each entry is preserved as a subsection
for reference and future SDD evolution.

## Entries

- [|-](#doc-1781428350281) (MOD-001)
- [|-](#doc-1781428350281) (MOD-002)

## |-

- **ID**: `MOD-001`
- **Source**: `model-MOD-001.md`
- **Created**: 2026-06-10T16:58:07.190Z

任务: # P5/P6/P6.5 管线自举：Self-Document + Workflow Skills + Skill 统一

实现三个模块：P5 代码结构提取 + LLM 文档生成（harness 原语 + studio 编排），P6 三个 Workflow Skill（req/impl/review），P6.5 Skill 统一（SKILL.md 迁移 + loader 切换 + 硬编码删除 + ; AC匹配率: 0%; 预测文件: [harness/src/knowledge/extraction.ts, harness/src/knowledge/__tests__/extraction.test.ts, harness/src/knowledge/index.ts]; 实际文件: [.progress.json, .prompt.md, REQUIREMENTS.md, apps/api/src/modules/agents/CONTEXT.md, apps/api/src/modules/agents/requirement-gate.ts, apps/api/src/

> ... (truncated)

## |-

- **ID**: `MOD-002`
- **Source**: `model-MOD-002.md`
- **Created**: 2026-06-11T12:29:27.346Z

任务: # 创建 knowledge 冒烟测试文件

在 apps/api/src/modules/knowledge/__tests__/ 下创建 smoke-test.ts，包含一个 describe+test 断言 1+1=2

<!-- TASK_TIER {"tier":"fast","reason":"单文件创建，无跨模块依赖，无代码行为改动"} -->

## Schema First Ve; AC匹配率: 0%; 预测文件: [apps/api/src/modules/knowledge/__tests__/smoke-test.ts]; 实际文件: []; 漏预测文件: apps/api/src/modules/knowledge/__tests__/smoke-test.ts; 误判类型: missingFile(1)
