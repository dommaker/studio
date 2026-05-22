# KnowledgeStore Breakpoint Fixes (2026-05-22)

## Root Cause
Components built feature-by-feature in isolation. Ingest, store, bus, query, lifecycle, monitor — all verified locally but end-to-end circuits never tested. Same "fake completion" pattern as plan coverage.

## 17 Breakpoints Found, 5 Fixed

### BP-17 (P0): Three separate KnowledgeStore instances
KnowledgeBus, knowledgeQuery.kkStore, and MonitorAgent each created `new KnowledgeStore()`. Same filesystem dir but separate in-memory indexes. Write in one, read in another → stale data.
Fix: Singleton `sharedStore` + `sharedLifecycle` exported from knowledge-bus.service.ts.

### BP-4 (P0): Reference tracking never called on read
getRecentContext() read entries but never called recordReference(). lastReferenced never updated → new entries sorted to bottom → never surfaced.
Fix: getRecentContext() now calls sharedLifecycle.recordReference() on each returned entry.

### BP-2 (P1): lastReferenced initialized to empty string
New entries born with lastReferenced="" → sort to bottom → never injected into prompts. Also: checkPromotion checks if(lastReferenced) — empty string is falsy → draft→verified promotion blocked.
Fix: ingest.ts buildEntry() now sets lastReferenced = now (current timestamp).

### BP-1 (P2): All entries hardcoded to draft
recordPattern() always passed maturity:'draft'. Triage fixes (battle-tested) started same as Monitor alerts (untested).
Fix: recordPattern() now sets maturity:'verified' for source='triage'/'auditor'/'evolution', others stay 'draft'.

### BP-7 (NOT a breakpoint): Promotion cycle exists
checkKnowledgeHealth() already calls tryPromote() every 5 min. Previous non-promotion was caused by BP-4 (empty lastReferenced blocked draft→verified).

## Files Modified
- knowledge-bus.service.ts: sharedStore/sharedLifecycle, recordReference on read, source-based maturity
- knowledge-query.service.ts: removed kkStore, uses sharedStore
- monitor-agent.service.ts: uses sharedStore/sharedLifecycle, circuit check+repair, heartbeat persistence
- harness/src/knowledge/ingest.ts: lastReferenced = now default
