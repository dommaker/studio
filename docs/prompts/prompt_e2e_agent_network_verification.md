# Agent Network E2E 端到端验证 — 新会话恢复提示词

## 背景

B63 知识库优化 Phase 1-4 全部完成（23 AC，11 commits）。下一步：Agent Network E2E 端到端验证（roadmap Phase 3.28c-6）。

## 验证目标

1 个完整 WorkUnit 生命周期跑通：

```
SCHEDULE Trigger 触发 → 创建 WorkUnit → Agent claim → 选 Skill → 执行 → 结果写入 Channel
```

## 验收标准

| # | 任务 | 验收标准 |
|---|------|---------|
| 1 | 验证场景设计 | 系统健康巡检（analysis 类型），场景文档化 |
| 2 | Trigger 创建 WorkUnit | cron → WorkUnit (type: analysis, channelId: ops) |
| 3 | Agent claim + 执行 | Agent 读 Channel → claim → 选 Skill → 执行 |
| 4 | 结果写入 Channel | 执行结果 → ChannelMessage |

## 核心文件

| 文件 | 角色 |
|------|------|
| `studio/apps/api/src/modules/agents/agent-loop.ts` | Agent 主循环：claim → execute → 结果处理 |
| `studio/apps/api/src/modules/agents/default-triggers.ts` | 9 个系统 trigger（含 2 个 B63 新增） |
| `studio/apps/api/src/modules/triggers/trigger-scheduler.ts` | SCHEDULE trigger 调度 |
| `studio/apps/api/src/modules/triggers/trigger-action.ts` | CREATE/EXECUTE/UPDATE action 执行 |
| `studio/apps/api/src/modules/agents/workunit.service.ts` | WorkUnit CRUD + claim/unclaim |
| `studio/apps/api/src/modules/knowledge/knowledge-service.ts` | 知识服务（recordConsumption 等） |
| `studio/apps/api/src/modules/channels/channel.service.ts` | Channel 消息 |

## 已完成的组件状态

| 组件 | 状态 | 说明 |
|------|------|------|
| WorkUnit 表 + CRUD | ✅ | Prisma schema + service |
| Claim API | ✅ | optimistic locking |
| EventBus | ✅ | 事件发布/订阅 |
| Trigger Registry | ✅ | 9 个系统 trigger 注册 |
| SCHEDULE 调度 | ✅ | cron 触发 → action 执行 |
| AgentLoop | ✅ | claim → execute → 后处理 |
| Skill 发现 | ✅ | manifest-loader + skill-selector |
| 知识库消费 | ✅ | hint prompt + recordConsumption (B63) |
| 全链路 | ⚠️ | 各组件单测通过，未实际跑通 |

## 当前 SCHEDULE trigger 列表

| ID | Cron | Action |
|----|------|--------|
| workunit-timeout | */5 * * * * | UPDATE workunit |
| poll-fallback | */30 * * * * | EXECUTE agent-scan |
| agent-timeout | */2 * * * * | EXECUTE timeout-scan |
| knowledge-quality-audit | 17 3 * * * | CREATE WorkUnit (analysis) |
| session-knowledge-extraction | 17 4 * * * | CREATE WorkUnit (analysis) |
| zero-consumption-audit | 17 5 * * * | CREATE WorkUnit (analysis) |
| knowledge-synthesis | 23 10 * * 1 | CREATE WorkUnit (analysis) |

## 建议验证步骤

1. 启动 API 服务，确认 Trigger Scheduler 运行
2. 手动触发一个 SCHEDULE trigger（或等 cron 命中）
3. 观察 WorkUnit 创建（DB 查询或日志）
4. 观察 AgentLoop claim 行为
5. 观察执行结果
6. 如果链路断裂，诊断断点并修复

## 诊断工具

```bash
# 查看 trigger 状态
curl localhost:13101/api/triggers/states

# 查看 WorkUnit 列表
curl localhost:13101/api/workunits

# 查看 Agent 实例
curl localhost:13101/api/agents/instances

# 查看日志（实时）
journalctl -u studio-api -f | grep -E "trigger|WorkUnit|AgentLoop"
```

## 相关记忆

- B63 进展：~/.claude/projects/-root-projects/memory/project_batch_progress_2026_07_01_kb_optimize_phase1.md
- Agent Network 架构状态：~/.claude/projects/-root-projects/memory/project_na_architecture_status.md
- Trigger Registry 设计：~/.claude/projects/-root-projects/memory/design_trigger_registry.md
- Agent Persistence 分析：~/.claude/projects/-root-projects/memory/analysis_agent_persistence.md
