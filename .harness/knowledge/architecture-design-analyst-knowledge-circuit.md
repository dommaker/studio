---
id: design-knowledge-circuit
type: architecture
title: Knowledge Circuit Self-Check & Auto-Repair
maturity: verified
layer: tech
created: '2026-05-22T10:09:00.000Z'
lastReferenced: '2026-05-22T10:09:00.000Z'
contributors:
  - analyst
projects: []
tags:
  - knowledge-circuit
  - design-doc
applicablePhases: []
sourceReferences:
  - workflow: design:analyst:knowledge-circuit
    timestamp: '2026-05-22T10:09:00.000Z'
referencedBy: []
---
4 circuits: Write→Read, Read→Promote, Promote→Validate, Decay→Archive + DocFreshness.
Causal inference per entry: 1 positive example = CLOSED, zero + aged = OPEN. Min age threshold: 1h.

Auto-repair: Read→Promote → tryPromote(); Decay→Archive → runDecayCycle(); DocFreshness → refresh lastReferenced.
Trigger: MonitorAgent startup + hourly. Results written as meta-knowledge to store.

Knowledge bus: recordPattern() for agent events, upsertKnowledge() for design docs (compare by scope, create/update/refresh).
Singleton store + lifecycle (sharedStore/sharedLifecycle) in knowledge-bus.service.ts.

Refer to .harness/knowledge-docs/knowledge-circuit-self-check.md for full detail.
