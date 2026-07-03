---
status: implemented
version: "1.0"
specId: AS-026
created: 2026-06-24
---

# Agent Persistence MVP — Requirement

AS-026: Agent 常驻 MVP。Agent 自主发现 WorkUnit → claim → 执行 → 完成。

## AC Groups

### AC-1: RuntimeInstance 表 + CRUD API

RuntimeInstance 表记录 Agent 运行实例，关联 AgentProfile（作为 Role）。

#### 验收标准

- [ ] `prisma migrate` 成功创建 RuntimeInstance 表，包含字段：id, roleId, sessionId, status, currentWorkUnitId, startedAt, terminatedAt, metadata
- [ ] roleId 索引存在，status 索引存在
- [ ] POST /agents/instances 创建实例，返回 201 + instance 对象
- [ ] GET /agents/instances 列出所有实例，支持 ?status=idle 过滤
- [ ] GET /agents/instances/:id 获取单个实例
- [ ] PATCH /agents/instances/:id 更新实例状态（status/currentWorkUnitId/terminatedAt/metadata）
- [ ] AgentProfile.metadata 扩展字段 acceptedTypes/autoClaim/defaultSkills 可读写

#### 边界情况

- roleId 引用不存在的 AgentProfile → 400
- status 值不在 idle/active/terminated 范围 → 400
- 并发更新同一实例 → 乐观锁或 last-write-wins（MVP 可接受）

#### 不做项

- 不做实例心跳（P2-A1）
- 不做实例自动重启
- 不做 AgentProfile 表结构变更（只扩展 metadata JSON）

#### 涉及文件

- `packages/studio-prisma/prisma/schema.prisma` — 新增 RuntimeInstance 模型
- `apps/api/src/modules/agents/agent-instance.service.ts` — 新建，CRUD 逻辑
- `apps/api/src/modules/agents/agent-instance.routes.ts` — 新建，REST API
- `apps/api/src/modules/agents/routes.ts` — 注册新路由
- `apps/api/src/modules/agents/agent-profile.service.ts` — 扩展 metadata 类型

---

### AC-2: Trigger 系统扩展（EVENT + EXECUTE + UPDATE）

扩展现有 Trigger 模块（apps/api/src/modules/triggers/），新增条件类型和动作类型。

现有模块已支持：SCHEDULE 条件 + CREATE 动作 + YAML 存储 + 60s tick 调度器。

#### 验收标准

- [ ] TriggerCondition.type 支持 `'EVENT'`，config 含 `event: string`（EventBus 事件名）和可选 `filter`
- [ ] TriggerAction.type 支持 `'EXECUTE'`，target 为 handler 名称（如 `'agent-loop'`），config 传参
- [ ] TriggerAction.type 支持 `'UPDATE'`，target 为实体类型（如 `'workunit'`），config 含 query + update
- [ ] EVENT 类型 Trigger 在 EventBus publish 对应事件时被触发
- [ ] EXECUTE 动作调用注册的 handler 函数（通过 handler registry，不硬编码）
- [ ] UPDATE 动作执行 prisma 实体更新（支持模板变量 `$event.xxx`）
- [ ] Trigger 可 enable/disable（已有，验证 EVENT 类型同样支持）
- [ ] 单元测试覆盖：EVENT 条件注册/触发、EXECUTE 动作 handler 调用、UPDATE 动作执行、enable/disable

#### 边界情况

- EventBus 事件名不匹配 → 不触发，无报错
- EXECUTE handler 未注册 → warn log，不抛异常
- UPDATE 模板变量在 event payload 中不存在 → 跳过该字段
- Trigger 重复注册同 id → 覆盖旧 Trigger

#### 不做项

- 不做 PATTERN/THRESHOLD/STATE_CHANGE 条件（P2-B）
- 不做 NOTIFY 动作（P2-B）
- 不做 YAML 持久化 EVENT Trigger（内存即可，重启需重新注册）

#### 涉及文件

- `apps/api/src/modules/triggers/trigger.types.ts` — 扩展 TriggerCondition 和 TriggerAction 类型
- `apps/api/src/modules/triggers/trigger-action.ts` — 新增 registerExecuteHandler + executeExecuteAction + executeUpdateAction
- `apps/api/src/modules/triggers/trigger-scheduler.ts` — 扩展支持 EVENT 条件（EventBus 订阅）
- `apps/api/src/modules/triggers/__tests__/trigger-event.test.ts` — 新建，EVENT+EXECUTE+UPDATE 测试

---

### AC-3: AgentLoop 核心（claim + Skill 加载 + 执行）

AgentLoop 是 Trigger EXECUTE 动作的消费方。发现 WorkUnit → canClaim → tryClaim → loadSkills → execute → submitForReview。

#### 验收标准

- [ ] AgentLoop.start() 创建 RuntimeInstance(status=idle) 并注册 Agent 自有的 Trigger
- [ ] workunit.created 事件到达 → AgentLoop.onNewWorkUnit() 被调用
- [ ] canClaim() 检查：processing=false + WorkUnit.type in role.metadata.acceptedTypes + WorkUnit.status=unassigned
- [ ] tryClaim() 调用 workUnitService.claim() 乐观锁成功 → WorkUnit.assigneeId 更新为 instance.id
- [ ] tryClaim() 返回 409 → 跳过，不报错
- [ ] loadSkills() 读 SkillLoader.listAll() → 按 WorkUnit.scope + Role.description 选相关 Skill → loadSingle() 加载完整 prompt
- [ ] executeWithSkills() 构建 prompt（Skill content + WorkUnit scope + knowledge context）→ agentExecutor.execute()
- [ ] 执行完成 → submitForReview(workUnit.id)（WorkUnit 状态 → in_review）
- [ ] 执行失败 → recordFailure() + unclaim()（WorkUnit 回 unassigned）
- [ ] Agent 同一时间只处理一个 WorkUnit（processing guard）
- [ ] 单元测试覆盖：start/onNewWorkUnit/canClaim/tryClaim/executeWithSkills/失败处理

#### 边界情况

- Agent 启动时有匹配的 unassigned WorkUnit → 初始 scanForWork claim
- 执行超时 → 由 Scheduler 超时 GC 处理（不在 AgentLoop 内部）
- Skill 加载失败 → 降级为无 Skill 执行（默认 prompt）
- agentExecutor.execute() 抛异常 → catch + unclaim
- WorkUnit 在 claim 前被其他人 claim → 409 → skip

#### 不做项

- 不做 Agent Loop（Execute→Sense→Think 循环）（P2-C1）
- 不做 Agent 自主创建 WorkUnit（P2-C5）
- 不做 Agent-to-Agent DM（P2-C3）
- 不做 Reminder 机制（P2-C2）

#### 涉及文件

- `apps/api/src/modules/agents/agent-loop.ts` — 新建，核心 AgentLoop 类
- `apps/api/src/modules/agents/agent-instance.service.ts` — 复用 AC-1
- `apps/api/src/modules/workunit/workunit.service.ts` — 复用 claim/unclaim
- `packages/studio-skill/src/loader.ts` — 复用 listAll/loadSingle
- `packages/studio-agent/src/services/session-manager.ts` — 复用 execute()
- `packages/studio-shared/src/event-bus.ts` — 复用 subscribe

---

### AC-4: 默认 Trigger 注册

系统启动时注册 4 个默认 Trigger，驱动 Agent 自主工作。

#### 验收标准

- [ ] agent-discover Trigger：workunit.created EVENT → AgentLoop.onNewWorkUnit
- [ ] workunit-timeout Trigger：每 5 分钟 SCHEDULE → 释放超时 claim（status=active + timeoutAt < now）
- [ ] dependency-unlock Trigger：workunit.done EVENT → 解锁依赖 WorkUnit（dependsOn contains doneId + status=blocked → unassigned）
- [ ] poll-fallback Trigger：每 30 秒 SCHEDULE → AgentLoop.scanForWork
- [ ] 4 个 Trigger 在 API server 启动时自动注册

#### 边界情况

- EventBus 未初始化 → Trigger 注册延迟到 EventBus ready
- 多个 AgentLoop 实例注册同名 Trigger → id 加 roleId 前缀区分
- 超时释放 Trigger 发现无超 WorkUnit → 无操作

#### 不做项

- 不做 Trigger YAML 持久化（代码注册即可）
- 不做 Trigger 动态增删 API（已有 CRUD，但默认 Trigger 是代码级）

#### 涉及文件

- `apps/api/src/modules/agents/agent-loop.ts` — 复用 AC-3，注册 Trigger 逻辑
- `apps/api/src/modules/triggers/trigger-scheduler.ts` — 复用 AC-2
- `apps/api/src/modules/agents/default-triggers.ts` — 新建，4 个默认 Trigger 定义 + 注册函数

---

### AC-5: Scheduler 退化

GoalScheduler 标 @deprecated，提取超时 GC 逻辑为独立函数。Scheduler 和 AgentLoop 并行不冲突。

#### 验收标准

- [ ] GoalScheduler.tick() 标 @deprecated 注释
- [ ] 超时 GC 逻辑（checkTimedOutExecutions）提取为独立函数 `recoverStaleWorkUnits()`
- [ ] 孤儿恢复逻辑（recoverStaleExecutions）提取为独立函数 `recoverOrphanedExecutions()`
- [ ] 两个函数可独立调用，不依赖 Scheduler 实例状态
- [ ] workunit-timeout Trigger 调用 recoverStaleWorkUnits()
- [ ] Scheduler 和 AgentLoop 并行运行不冲突（WorkUnit.assigneeId 防重复，AC-6 E2E 验证）

#### 边界情况

- Scheduler 已 claim 的 WorkUnit → AgentLoop 不重复 claim（assigneeId 检查）
- AgentLoop 已 claim 的 WorkUnit → Scheduler 超时 GC 可能释放（超时场景正确）

#### 不做项

- 不删除 Scheduler 代码（标 deprecated，确认无价值后 P2-E 删除）
- 不迁移 Scheduler 的保守模式和失败率追踪（低价值）

#### 涉及文件

- `apps/api/src/modules/goals/scheduler-integration.ts` — 标 @deprecated + 提取函数
- `apps/api/src/modules/goals/stale-recovery.ts` — 新建，提取的 GC + 孤儿恢复

---

### AC-6: 端到端验证

完整流程验证：WorkUnit 创建 → AgentLoop 自动 claim → 执行 → 完成。

#### 验收标准

- [ ] 创建 WorkUnit（type=task, status=unassigned）→ AgentLoop 自动 claim（assigneeId 更新）
- [ ] Agent 执行完成 → WorkUnit 状态变为 in_review
- [ ] 审查通过 → WorkUnit 状态变为 done
- [ ] 多 WorkUnit 并发 → 不同 Agent 分别 claim（无重复 assigneeId）
- [ ] Agent 执行失败 → WorkUnit 回 unassigned → 其他 Agent 可 claim

#### 涉及文件

- `apps/api/src/modules/agents/__tests__/agent-loop-e2e.test.ts` — 新建，端到端测试

## AC → 文件映射总表

| 文件 | AC | 改动类型 |
|------|-----|---------|
| `packages/studio-prisma/prisma/schema.prisma` | AC-1 | 新增 RuntimeInstance 模型 |
| `apps/api/src/modules/agents/agent-instance.service.ts` | AC-1 | 新建 |
| `apps/api/src/modules/agents/agent-instance.routes.ts` | AC-1 | 新建 |
| `apps/api/src/modules/agents/routes.ts` | AC-1 | 修改（注册路由） |
| `apps/api/src/modules/agents/agent-profile.service.ts` | AC-1 | 修改（metadata 类型） |
| `apps/api/src/modules/triggers/trigger.types.ts` | AC-2 | 修改（扩展类型） |
| `apps/api/src/modules/triggers/trigger-action.ts` | AC-2 | 修改（新增动作） |
| `apps/api/src/modules/triggers/trigger-scheduler.ts` | AC-2 | 修改（EVENT 支持） |
| `apps/api/src/modules/triggers/__tests__/trigger-event.test.ts` | AC-2 | 新建 |
| `apps/api/src/modules/agents/agent-loop.ts` | AC-3, AC-4 | 新建 |
| `apps/api/src/modules/agents/default-triggers.ts` | AC-4 | 新建 |
| `apps/api/src/modules/goals/scheduler-integration.ts` | AC-5 | 修改（@deprecated） |
| `apps/api/src/modules/goals/stale-recovery.ts` | AC-5 | 新建 |
| `apps/api/src/modules/agents/__tests__/agent-loop-e2e.test.ts` | AC-6 | 新建 |
