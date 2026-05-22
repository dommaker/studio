# Pipeline Logging & Observability (2026-05-22)

## Architecture
Full pipeline has 9 stages + 2 background agents. Every stage now records:
- duration: total + per-substage timing
- token consumption: promptTokens, completionTokens, totalTokens, cacheHitTokens
- recordPipelineRun(): persisted to PipelineRun DB table
- knowledgeBus.recordPattern(): pushes to KnowledgeStore for agent cross-referencing

## Key Files Modified
| Phase | File | Changes |
|-------|------|---------|
| 0. Analyst | channels/analyst-trigger.service.ts | recordPipelineRun(phase:'analyst'), capture daemon usage, log duration + knowledge sizes |
| 2. Scheduler | goals/goal-scheduler.ts | classifyTaskComplexity logs decision reason, getAvailableSlots logs resources, silent catches to logger.warn |
| 3. Executor | studio-agent/src/services/agent-executor.ts | cumulativeSessionMs tracking, buildPrompt context size, harness init failure logged, SIGKILL logged |
| 6. Review | agents/review-agent.service.ts | recordPipelineRun(phase:'review'), parse Claude Code JSON for token usage, duration |
| 7. Deploy | agents/deploy-agent.service.ts | recordPipelineRun(phase:'deploy'), per-stage timing, cleanup summary |
| 8. PostEval | agents/post-eval-agent.service.ts | Duration, tokens (cacheHit breakdown), executionMode, knowledgeBus. GapReport.tokensUsed |
| BG. Monitor | agents/monitor-agent.service.ts | gcStaleWorktrees logged, heartbeat persisted to file |
| Shared | studio-shared/llm/model-gateway.ts | cacheHitTokens in GatewayResponse, UsageRecord, Anthropic adapter |
| Metrics | daemon/metrics.ts | phase: analyst/executor/review/deploy/full |

## Token Breakdown
model-gateway.ts: promptTokens, completionTokens, totalTokens, cacheHitTokens.
Anthropic adapter: passes through cache_read_input_tokens and cache_hit_tokens.
