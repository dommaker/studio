---
id: ARC-010
type: architecture
title: Pipeline State Machines & Model Tiers
maturity: draft
layer: tech
created: '2026-05-22T10:31:44.099Z'
lastReferenced: '2026-05-22T13:49:51.787Z'
contributors:
  - knowledge-sync
  - monitor
  - auditor
  - triage
projects: []
tags:
  - pipeline-state-machines
  - design-doc
applicablePhases: []
sourceReferences:
  - workflow: design:analyst:pipeline-state-machines
    timestamp: '2026-05-22T10:31:44.103Z'
referencedBy: []
---

# Pipeline State Machines

## Goal States
`draft → planning → executing → succeeded | failed | blocked`

## GoalPlan States
`draft → approved → executing → completed`

## GoalExecution States
`pending → running → succeeded | failed`

## Model Tiers
| Tier | Default Model | Use Case |
|------|-------------|----------|
| fast | deepseek-v4-flash | Small changes, config, docs |
| standard | deepseek-v4-flash | Routine development |
| premium | deepseek-v4-pro[1m] | Architecture, auth, security, migrations |

## Routing Logic
File: `apps/api/src/modules/goals/goal-scheduler.ts` (classifyTaskComplexity)
- High risk keywords (schema, auth, security, payment) → premium
- Low risk keywords (style, typo, doc, refactor) + single AC + ≤2 files → fast
- Default → standard
- Also premium if: ≥4 ACs or ≥5 files
