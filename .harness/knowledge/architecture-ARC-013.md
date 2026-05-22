---
id: ARC-013
type: architecture
title: KnowledgeSync Service
maturity: draft
layer: tech
created: '2026-05-22T12:03:43.651Z'
lastReferenced: '2026-05-22T13:49:51.789Z'
contributors:
  - knowledge-sync
  - monitor
projects: []
tags:
  - knowledge-sync
  - design-doc
applicablePhases: []
sourceReferences:
  - workflow: design:analyst:knowledge-sync
    timestamp: '2026-05-22T12:03:43.655Z'
referencedBy: []
---

# KnowledgeSync Service

Self-running knowledge lifecycle: code changes → knowledge auto-updates. Three cycles:

## Cycle 1: Capture
Trigger: Analyst agent completes analysis.
Calls upsertKnowledge() with scope-based dedup (compare content hash → create/update/refresh).

## Cycle 2: Detect
Trigger: MonitorAgent hourly.
Compares git log for each scope's tracked files against knowledge lastReferenced.
Files changed after last update → stale.

## Cycle 3: Heal
For each stale entry: refresh lastReferenced (prevent decay), downgrade maturity to draft (needs re-validation).

## Architecture
- File: apps/api/src/modules/knowledge/knowledge-sync.service.ts
- Export: knowledgeSync (singleton KnowledgeSyncService)
- Scope registry: DEFAULT_SCOPE_REGISTRY maps scope → {files, title, knowledgeType}
- Monitoring: duration, recordPipelineRun, knowledgeBus.recordPattern, token consumption logged

## API
- GET /api/knowledge/sync-status — display staleness + auto-heal
- POST /api/knowledge/upsert — batch upsert knowledge entries
- CLI: harness knowledge sync-status, harness knowledge upsert
