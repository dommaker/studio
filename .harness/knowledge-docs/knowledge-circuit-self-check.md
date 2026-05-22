# Knowledge Circuit Self-Check & Auto-Repair

## 4 Circuits
| Circuit | Detection |
|---------|-----------|
| Write→Read | Aged entries with lastReferenced > created = CLOSED |
| Read→Promote | Referenced entries past draft maturity = CLOSED |
| Promote→Validate | Multi-contributor verified/proven entries = CLOSED |
| Decay→Archive | Unreferenced >90d entries decayed/archived = CLOSED |
| DocFreshness | Design-doc entries vs git commit history |

## Logic
Causal inference per entry: 1 positive example = CLOSED, zero + aged = OPEN.
Minimum age threshold: 1h (avoids false positives on new entries).
Output: {status: CLOSED|OPEN|UNKNOWN, evidence, likelyCause}

## Auto-Repair
- Read→Promote OPEN: tryPromote() on all draft/verified (idempotent)
- Decay→Archive OPEN: force runDecayCycle()
- DocFreshness OPEN: refresh lastReferenced on stale entries
- Write→Read/Promote→Validate/CrossLayer: no auto-fix

## Trigger
MonitorAgent startup + hourly interval.
Both check + repair run together; results written to KnowledgeStore as meta-knowledge.

## Knowledge Bus
Writes: recordPattern() for agent events, recordIncident() for ops, upsertKnowledge() for design docs.
Reads: getRecentContext() injects into prompts, queryByType() for on-demand.
Singleton store + lifecycle (sharedStore/sharedLifecycle) replaces 3 separate instances.

## File
apps/api/src/modules/knowledge/knowledge-bus.service.ts
