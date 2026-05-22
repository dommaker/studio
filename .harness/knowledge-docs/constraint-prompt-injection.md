# Constraint Prompt Injection — Agent Role Routing

## Architecture
harness constraint definitions (26 rules) each have a `promptInjection` field that was never consumed by any agent prompt. Now `formatConstraintsForPrompt(role)` maps constraints to agents by trigger type.

## Injection Matrix
| Agent | Role | Injected At | Triggers |
|-------|------|-------------|----------|
| Analyst | analyst | analyst-trigger.service.ts | design_request, api_change |
| Executor | executor | agent.hooks.ts → buildAgentConstraintPrompt() | code_implementation, task_completion_claim, test_creation, file_modification |
| Integration | integration | goal-scheduler.ts → buildIntegrationPrompt() | code_implementation |
| Reviewer | reviewer | review-agent.service.ts | code_implementation |

## Key Files
- harness/src/core/constraints/prompt-injection.ts — NEW: formatConstraintsForPrompt(role)
- harness/src/core/constraints/definitions.ts — 26 constraints with promptInjection field
- studio-shared/src/harness/hooks/agent.hooks.ts — Executor constraint injection
- analyst-trigger.service.ts — Analyst constraint injection
- goal-scheduler.ts — Integration constraint injection
- review-agent.service.ts — Reviewer constraint injection

## Design
Before: Agent produces code → harness check blocks → fix → redo
After: Agent knows constraints at prompt time → produces compliant code → harness check passes
