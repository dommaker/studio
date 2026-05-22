# Pipeline Agents (8 Total)

## Agent Responsibility Table

| Agent | Input | Action | Output | Consumes | Cleanup |
|-------|-------|--------|--------|----------|---------|
| Analyst | Discord message | Explore codebase | RequirementsDoc | — | — |
| Executor × N | AC group + files | Implement in worktree | Code + .progress.json | — | — |
| Integration | N task branches | merge + tsc + test | Integrated code | task/* branches | — |
| Reviewer | Integrated code | Multi-stance review | .review-report.json | — | — |
| DeployAgent | Reviewed code | merge → push → deploy → cleanup | Deployed release | integration worktree + task branches | task/* + worktrees |
| PostEval | Deployed release | AC vs diff comparison | Quality report | — | — |
| Monitor | Pipeline metrics | Health check + alerts | Alerts | 24h+ stale artifacts | Garbage collection |
| Triage | Critical alerts | Diagnose→Classify→Act→Escalate | Incident response | — | — |

## Agent Boundaries
- Analyst: owns exploration + RequirementsDoc generation. Does NOT own execution.
- Executor: owns code implementation. Does NOT own integration or deployment.
- Integration: owns merging task branches + compilation. Does NOT own review.
- Reviewer: owns code quality assessment. Does NOT own deployment decisions.
- DeployAgent: owns merge-to-master + push + deploy + cleanup. Last consumer of integration worktree.
- PostEval: owns post-completion audit. Does NOT own blocking deployment (gap report is informational).
- Monitor: owns health observation. Does NOT own fixing (escalates to Triage).
- Triage: owns incident response. Does NOT own prevention (feeds back to Auditor).

## Design Principles
1. Agent = Input (requirements+constraints) → Action → Output (artifacts+report) — does not manage artifact lifecycle
2. Artifact lifecycle = Create → Consume → Last consumer cleans up
3. Quality gates on consumer side — Review after Integration, Deploy after Review
4. Monitor as safety net — periodic GC for missed cleanup

## Key Files
| File | Role |
|------|------|
| `apps/api/src/modules/channels/analyst-trigger.service.ts` | Analyst agent |
| `apps/api/src/modules/goals/goal.service.ts` | Goal CRUD, plan, review, finalization |
| `apps/api/src/modules/goals/goal-scheduler.ts` | 10s poll, dispatch, integration |
| `packages/studio-agent/src/services/agent-executor.ts` | Worktree, session loop, stuck detection |
| `apps/api/src/modules/agents/review-agent.service.ts` | Multi-stance code review |
| `apps/api/src/modules/agents/deploy-agent.service.ts` | Merge, push, deploy, cleanup |
| `apps/api/src/modules/agents/monitor-agent.service.ts` | Health check, GC |
| `apps/api/src/modules/agents/triage-agent.service.ts` | Incident response |
| `apps/api/src/modules/agents/post-eval-agent.service.ts` | Post-completion audit |
