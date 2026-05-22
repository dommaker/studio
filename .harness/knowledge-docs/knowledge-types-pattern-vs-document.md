# Knowledge Types: Pattern vs Document

## Two knowledge categories
| | Pattern (runtime) | Document (design-time) |
|---|---|---|
| Content | Short alerts, fixes, decisions | Long analysis, architecture docs |
| Source | Agent events at runtime | Design analysis at dev time |
| Storage | KnowledgeStore (.harness/knowledge/) | RAG + KnowledgeStore |
| Usage | Injected into agent prompts | Agent queries on-demand |
| Entry | 200-500 chars, guideline type | Full docs, architecture type |
| Examples | "[Triage Fix] timeout", "[Monitor] stalled goal" | "Pipeline logging audit", "Circuit self-check" |
| Freshness | Maturity lifecycle (draft→verified→proven) | Scope-based + git commit comparison |
| Ingest method | recordPattern() (automatic) | upsertKnowledge() (manual/triggered) |

## Design-time ingestion gap
Current: analysis → manual file write → RAG ingest
Missing: API endpoint to accept knowledge from Claude Code → Studio KnowledgeStore
Missing: Analyst agent auto-call upsertKnowledge() after completion
Missing: CLI command to upsert design documents

## Scope-based dedup
upsertKnowledge() matches by scope tag:
- Same scope + different content → update (reset maturity)
- Same scope + same content → refresh lastReferenced
- No existing scope → create

## Freshness tracking
checkDocumentFreshness(): compares design-doc lastReferenced against git log for scope-related files. Entries >7d old with recent code changes → marked stale.
