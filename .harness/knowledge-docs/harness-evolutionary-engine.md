# Harness as Evolutionary Engine — define→detect→learn

## Core Abstraction
harness is NOT three separate systems (code checker, knowledge engine, user model). It's ONE pipeline projected onto multiple domains:

```
define → detect → learn

  define              detect                    learn                    domain
  ─────────────────────────────────────────────────────────────────────────
  iron_laws          harness check              constraint evolution     代码质量
  scope              KnowledgeSync              auto-heal                知识新鲜度
  lenses/meta-prin   analyze-sessions           update-user-model        用户模型
  alerts             Monitor                    Triage upgrade           系统健康
  patterns           analyze-sessions           memory 规则自动写         行为进化
```

Each domain runs the same cycle: define what "good" looks like → detect deviations → learn from deviations → update the definition.

## Domains Implemented
1. **Code quality** — constraints injected pre-execution + checked post-commit
2. **Knowledge freshness** — KnowledgeSync detect+heal cycle with scope tracking
3. **User model** — lenses + meta-principles + derived rules from daily transcripts

## Extensible Domains
Any domain modelable as "expected_state vs actual_state":
- Cost budget per phase
- Team review latency SLA
- Security vulnerability patterns

## Key Files
- harness/src/core/constraints/ → define (iron laws, guidelines)
- harness/src/core/constraints/checker.ts → detect
- harness/src/core/constraints/definitions.ts → learn (promptInjection field)
- harness/src/knowledge/ → KnowledgeStore, lifecycle, ingest
- harness/src/cli/commands/analyze-sessions.ts → user model detection
- harness/src/cli/commands/update-user-model.ts → user model learning
- studio/apps/api/src/modules/knowledge/knowledge-sync.service.ts → knowledge freshness
