---
id: ARC-008
type: architecture
title: Pipeline Stages (9 + 2 Background)
maturity: draft
layer: tech
created: '2026-05-22T10:31:42.900Z'
lastReferenced: '2026-05-22T13:49:51.793Z'
contributors:
  - knowledge-sync
  - auditor
  - triage
  - monitor
projects: []
tags:
  - pipeline-stages
  - design-doc
applicablePhases: []
sourceReferences:
  - workflow: design:analyst:pipeline-stages
    timestamp: '2026-05-22T10:31:42.904Z'
referencedBy: []
---

# Pipeline Stages (9 + 2 Background)

## Stage 0: Analyst
- Trigger: `@analyst` in Discord channel
- File: `apps/api/src/modules/channels/analyst-trigger.service.ts`
- What: Explore codebase → generate RequirementsDoc
- Workspace: `.analyst/` directory (no git worktree)
- Mechanism: `daemon.submitJob()` → Claude session

## Stage 1: Goal Creation
- File: `apps/api/src/modules/goals/goal.service.ts`
- What: RequirementGate validates → splits into AC groups
- Each AC group = one GoalExecution
- Model tier assignment: fast/standard/premium based on task complexity

## Stage 2: Scheduler
- File: `apps/api/src/modules/goals/goal-scheduler.ts`
- Poll interval: every 10 seconds
- What: Resource-aware concurrency (1-5 slots), dependency resolution
- Conflict detection: file overlap → sequential batches
- Status: pending → running

## Stage 3: Agent Executor
- File: `packages/studio-agent/src/services/agent-executor.ts`
- What: `git worktree add -b task/<id>`, session loop
- Session model: --session-id → --continue, max 5 sessions × 30min
- Completion detection: read `.progress.json` (not trust exit code)
- Stuck detection: no progress → strategy hints → escalate

## Stage 4: Integration
- File: `apps/api/src/modules/goals/goal-scheduler.ts` (buildIntegrationPrompt, checkAllStepsCompleted)
- Trigger: ≥2 regular steps completed (stepIndex=999)
- What: Claude merges task branches → tsc → test
- Prompt-based, Claude performs merge manually

## Stage 5: Goal Completion Check
- File: `apps/api/src/modules/goals/goal.service.ts` (checkGoalCompletion, handleGoalSucceeded/Failed)
- All succeeded → Goal: succeeded
- Any failed → Goal: failed
- Writes lifecycle event

## Stage 6: Review Gate
- File: `apps/api/src/modules/agents/review-agent.service.ts`
- What: Multi-stance review in integration worktree
- Output: `.review-report.json`
- Retry: max 3 cycles; 3 failures → Goal: blocked

## Stage 7: Finalization
- File: `apps/api/src/modules/goals/goal.service.ts` (finalizeGoalSucceeded)
- Test gate: checkBeforeTaskComplete
- OKR progress update
- Triggers DeployAgent.deploy()

## Stage 8: Deploy
- File: `apps/api/src/modules/agents/deploy-agent.service.ts`
- Steps: merge integration→master → git push → docker build/push/up -d → cleanup
- Cleanup: delete task/* branches + worktree directories

## Stage 9: Post-Completion
- File: `apps/api/src/modules/agents/post-eval-agent.service.ts`
- What: AC vs git diff comparison
- recordGoalCompletion(): aggregate metrics
- Push completion card to Channel

## Background: Monitor
- File: `apps/api/src/modules/agents/monitor-agent.service.ts`
- Interval: every 5 minutes
- Checks: failure trends, stuck goals, progress stagnation, session escalation, heartbeat loss, pipeline latency
- GC: git worktree prune, cleanup stale worktrees >24h
- Auto-abandon: blocked goals after 24h

## Background: Triage
- File: `apps/api/src/modules/agents/triage-agent.service.ts`
- 4-level response: diagnose → classify → act → escalate
- Triggered by Monitor critical alerts
