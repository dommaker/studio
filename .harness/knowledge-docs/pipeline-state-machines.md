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
