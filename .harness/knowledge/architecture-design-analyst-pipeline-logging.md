---
id: design-pipeline-logging
type: architecture
title: Pipeline Logging & Observability (2026-05-22)
maturity: verified
layer: tech
created: '2026-05-22T10:09:00.000Z'
lastReferenced: '2026-05-22T10:09:00.000Z'
contributors:
  - analyst
projects: []
tags:
  - pipeline-logging
  - design-doc
applicablePhases: []
sourceReferences:
  - workflow: design:analyst:pipeline-logging
    timestamp: '2026-05-22T10:09:00.000Z'
referencedBy: []
---
Full pipeline has 9 stages + 2 background agents. Every stage records duration, token consumption (promptTokens/completionTokens/totalTokens/cacheHitTokens), recordPipelineRun(), knowledgeBus.recordPattern().

Key files: analyst-trigger.service.ts, goal-scheduler.ts, agent-executor.ts, review-agent.service.ts, deploy-agent.service.ts, post-eval-agent.service.ts, monitor-agent.service.ts, model-gateway.ts, metrics.ts.

Token breakdown: cacheHitTokens field added to GatewayResponse, UsageRecord, RawResponse. Anthropic adapter passes through cache_read_input_tokens.

Metrics: MetricEntry.phase now accepts analyst/executor/review/deploy/full.
Refer to .harness/knowledge-docs/pipeline-logging-audit.md for full detail.
