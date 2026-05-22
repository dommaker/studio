---
id: ARC-005
type: architecture
title: Plan Coverage via PostEval
maturity: draft
layer: tech
created: '2026-05-22T10:28:34.983Z'
lastReferenced: '2026-05-22T13:34:51.798Z'
contributors:
  - knowledge-sync
  - monitor
  - auditor
  - triage
projects: []
tags:
  - plan-coverage
  - design-doc
applicablePhases: []
sourceReferences:
  - workflow: design:analyst:plan-coverage
    timestamp: '2026-05-22T10:28:34.986Z'
referencedBy: []
---

# Plan Coverage Verification via PostEval

## Problem
"假装完成"：Plan 写了 N 项，实施时跳了 M 项，commit 前无人发现。

## Solution
复用 PostEval 现有架构（AC 提取 → LLM 语义匹配 → GapReport），换数据源：
- 原：RequirementsDoc.content → extractAcs() → 对比 Goal git diff
- 新：plan.md 文件 → extractPlanItems() → 对比 staged diff

## Architecture Decision
不修改 harness 约束引擎，不新增 CLI 命令，不创建新 Agent。
同一个匹配引擎 matchAcsToChanges()，两个入口。

## Implementation
| File | Change |
|------|--------|
| post-eval-agent.service.ts | evaluatePlanCoverage() method, GapReport export, tokensUsed with cacheHit |
| agents/types.ts | Re-export GapReport |
| agents/routes.ts | POST /post-eval/plan-coverage endpoint |
| harness/src/cli/commands/posteval-plan.ts | NEW CLI command |
| harness/bin/harness.js | Register posteval-plan subcommand |
| studio/.git/hooks/pre-commit | Plan coverage check step |

## Flow
1. git commit → pre-commit hook detects staged plan.md files
2. Hook calls `npx harness posteval-plan plan.md`
3. CLI → Studio API POST /api/v1/agents/post-eval/plan-coverage
4. PostEval extracts checklist items, gets staged diff, LLM semantic match
5. Returns coverage% + missed items → blocks commit if <100%
