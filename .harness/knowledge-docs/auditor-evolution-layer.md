# Auditor Evolution Layer (2026-05-22)

## Architecture
AuditorAgent dailyAudit now analyzes user model quality and knowledge circuit health, not just execution statistics. Evolution is risk-graded autonomy within Auditor, not a separate agent.

## Analysis Dimensions
| Dimension | Method | Data Source |
|-----------|--------|-------------|
| Semantic cluster stability | patterns.trend rising/stable/falling | ~/.claude/user-model-state.json |
| Lens weight drift | lensWeights >= 3 → upgrade suggestion | user-model-state.json |
| Circuit health | checkKnowledgeCircuit() → OPEN circuits | KnowledgeStore |
| Maturity stagnation | draft/total > 90% | KnowledgeStore |

## Apply Layer (risk-graded)
| Risk | Action | Execution |
|------|--------|-----------|
| Low | model_weight_tune → stabilize trend | Auto: write state.json |
| Low | circuit_fix suggestion record | Auto: log |
| Low | skill_weight/status adjust | Auto: Prisma update |
| High | derived_rule_promote | Channel card + bell notification |
| High | param_tuning | Channel card + bell notification |
| High | prompt_optimization | Channel card + bell notification |
| High | circuit_fix (OPEN circuits) | Channel card + bell notification |

## Notification
- Channel: #系统 → auditor_suggestion cards
- Bell: NotificationService.create(type=auditor_suggestion) → all users
- Frontend: SSE real-time + unread count

## Cycle
24h alongside decay + user model update. MonitorAgent(5min) + KnowledgeSync(hourly) + Auditor(24h).
