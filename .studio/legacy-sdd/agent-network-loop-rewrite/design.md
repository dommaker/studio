---
id: "cwyr2787t59mr372fyz"
slug: "agent-network-loop-rewrite"
title: "Agent Network Agent Loop 重写"
status: "done"
version: 1
---

## 文件映射总表

| AC Group | 文件路径 | 改动类型 |
|----------|---------|---------|
| ac-agent-runner-home | `packages/studio-agent/src/services/agent-runner.ts` | 修改 |
| ac-metadata-types | `apps/api/src/modules/workunit/workunit.service.ts` | 修改 |
| ac-agent-loop-rewrite | `apps/api/src/modules/agents/agent-loop.ts` | 重写 |
| ac-eventbus-cleanup | `apps/api/src/modules/workunit/workunit-events.ts` | 删除 |
| ac-eventbus-cleanup | `apps/api/src/modules/workunit/cycle-detection.ts` | 删除 |
| ac-eventbus-cleanup | `apps/api/src/modules/workunit/workunit.service.ts` | 修改 |
| ac-eventbus-cleanup | `apps/api/src/modules/workunit/__tests__/workunit-events.test.ts` | 删除 |
| ac-eventbus-cleanup | `apps/api/src/modules/workunit/__tests__/cycle-detection.test.ts` | 删除 |
| ac-channel-cleanup | `apps/api/src/modules/channels/channel-message.events.ts` | 删除 |
| ac-channel-cleanup | `apps/api/src/modules/channels/channel-message.service.ts` | 修改 |
| ac-channel-cleanup | `apps/api/src/modules/channels/__tests__/channel-message.events.test.ts` | 删除 |
| ac-dependson-cleanup | `packages/studio-prisma/prisma/schema.prisma` | 修改 |
| ac-dependson-cleanup | `apps/api/src/modules/workunit/workunit.service.ts` | 修改 |
| ac-dependson-cleanup | `apps/api/src/modules/workunit/workunit.routes.ts` | 修改 |
| ac-trigger-cleanup | `apps/api/src/modules/agents/default-triggers.ts` | 修改 |
| ac-trigger-cleanup | `apps/api/src/modules/triggers/trigger.types.ts` | 修改 |
| ac-trigger-cleanup | `apps/api/src/modules/triggers/trigger-scheduler.ts` | 修改 |
| ac-trigger-cleanup | `apps/api/src/modules/triggers/trigger-action.ts` | 修改 |
| ac-trigger-cleanup | `apps/api/src/modules/triggers/trigger-store.ts` | 修改 |
| ac-tests | `apps/api/src/modules/agents/__tests__/agent-loop-v2.test.ts` | 新建 |
| ac-tests | `apps/api/src/modules/agents/__tests__/agent-loop.test.ts` | 修改 |
| ac-tests | `apps/api/src/modules/agents/__tests__/agent-loop-e2e.test.ts` | 修改 |

## 文件依赖图

```
ac-agent-runner-home (独立) ──────────────────────────────────┐
ac-metadata-types (独立) ────────────────────────────────────┐│
                                                              ││
ac-agent-loop-rewrite ── consumes ──→ agent-runner HOME ─────┘│
                       ── consumes ──→ WorkUnitMetadata ──────┘
                       ── replaces ──→ 旧 agent-loop
                       ── produces ──→ 新 agent-loop (observe/resolveTarget/agentStep/recordResult)
                       │
                       ▼
ac-eventbus-cleanup ── removes imports from ──→ 旧 agent-loop（已重写，不再 import）
                    ── deletes ──→ workunit-events.ts, cycle-detection.ts
                    ── modifies ──→ workunit.service.ts
                       │
ac-channel-cleanup ── removes imports from ──→ 旧 agent-loop（已重写，不再 publish）
                  ── deletes ──→ channel-message.events.ts
                  ── modifies ──→ channel-message.service.ts
                       │
ac-dependson-cleanup ── depends on ──→ ac-eventbus-cleanup（unlockDependents 已删）
                   ── modifies ──→ schema.prisma, workunit.service.ts, workunit.routes.ts
                       │
ac-trigger-cleanup ── depends on ──→ ac-agent-loop-rewrite（不再注册 EVENT handler）
                 ── modifies ──→ trigger.types.ts, trigger-scheduler.ts, trigger-action.ts, trigger-store.ts, default-triggers.ts
                       │
ac-tests ── depends on ──→ 所有上述 AC（测试新代码 + 确认删除干净）
```

**并行可能性**：
- ac-agent-runner-home ∥ ac-metadata-types（无依赖）
- ac-eventbus-cleanup ∥ ac-channel-cleanup ∥ ac-trigger-cleanup（均依赖 ac-agent-loop-rewrite，但三者之间无依赖，可并行）
- ac-dependson-cleanup 依赖 ac-eventbus-cleanup（需先删 unlockDependents）
- ac-tests 最后执行

---

## ac-agent-runner-home

**Implementation Notes**

修改 `packages/studio-agent/src/services/agent-runner.ts` 中 `buildSpawnEnv()` 方法（L835-839 附近）：

1. 从 `task.parameters.workUnitId` 提取 workUnitId
2. HOME 路径改为 `/tmp/agent-loop/${workUnitId || task.executionId}`（fallback 保持向后兼容）
3. 在 env extra 对象中增加 `STUDIO_WORKUNIT_ID`（当 workUnitId 存在时）

**Architecture Context**
- Functions: `buildSpawnEnv(task: AgentTask): Record<string, string>` @ agent-runner.ts
- Call Chain: `executeLightweight()` → `buildSpawnEnv()` → spawn `claude` 进程
- Imports: 无需新增 import
- Danger Zones: `executeLightweight()` 签名不变（workUnitId 走 parameters），不影响 daemon/session-manager 调用方
- Verified At: agent-runner 相关测试文件

**Gotchas**
- `task.parameters` 类型是 `Record<string, unknown>`，workUnitId 需 type assertion：`task.parameters?.workUnitId as string | undefined`
- 现有调用方（daemon/session-manager L202）已传 `parameters: { sessionFlags, agentRole, worktree, extraEnv }`，不传 workUnitId → fallback 到 executionId 行为不变

---

## ac-metadata-types

**Implementation Notes**

修改 `apps/api/src/modules/workunit/workunit.service.ts` 中 `WorkUnitMetadata` interface（L17-36）：

```typescript
export interface WorkUnitMetadata {
  // 现有字段保留
  // ...

  // 新增：Agent Loop session 追踪
  sessionId?: string
  stepCount?: number
  startedAt?: string
  consecutiveStuck?: number
  sessionResumes?: number
}
```

**Architecture Context**
- Functions: `WorkUnitMetadata` interface @ workunit.service.ts:17-36
- Danger Zones: metadata 字段全部 optional，不影响现有消费方
- Verified At: workunit-schema.test.ts

---

## ac-agent-loop-rewrite

**Implementation Notes**

完全重写 `apps/api/src/modules/agents/agent-loop.ts`。从 class-based 改为函数集合（或保留 class 壳，内部方法替换）。

**新架构（函数级别）：**

1. **observe()**: `apps/api/src/modules/agents/agent-loop.ts`
   - 3 个 DB 查询：myActive（status in [active, blocked]）、unassigned（channelId + type 过滤）、newReplies（human + createdAt > updatedAt）
   - 返回 `Observations { myActive, unassigned, newReplies }`

2. **resolveTarget()**: `apps/api/src/modules/agents/agent-loop.ts`
   - 纯函数，输入 `Observations`，输出 `Target | null`
   - 4 优先级：人类回复 > active 继续 > unassigned 取最早 > null
   - 零 LLM 调用

3. **agentStep()**: `apps/api/src/modules/agents/agent-loop.ts`
   - 查 WorkUnit.metadata.sessionId → resume 或新建
   - 调用 `agentRunner.executeLightweight()`（不是 agentExecutor）
   - 参数：prompt, sessionFlags, agentRole, extraEnv(STUDIO_WORKUNIT_ID, STUDIO_CHANNEL_ID), model, timeoutMs=120_000
   - 返回 `StepResult { action, summary }`

4. **recordResult()**: `apps/api/src/modules/agents/agent-loop.ts`
   - 监控检查点：stepCount++, consecutiveStuck 更新
   - stepCount > 15 → in_review
   - consecutiveStuck >= 3 → blocked
   - 按 action: progress → post + blocked→active, complete → post + in_review, need_input → post + blocked

5. **postToDiscussionSpace()**: `apps/api/src/modules/agents/agent-loop.ts`
   - 直接 `prisma.channelMessage.create()`
   - 查 WorkUnit 获取 channelId
   - 不使用 EventBus

6. **parseAgentOutput()**: `apps/api/src/modules/agents/agent-loop.ts`
   - 解析 `ACTION: PROGRESS:<summary>` / `ACTION: COMPLETE:<summary>` / `ACTION: NEED_INPUT:<summary>`
   - 容错：正则匹配，找不到则返回 `{ action: 'progress', summary: rawText }`

7. **dynamicInterval()**: `apps/api/src/modules/agents/agent-loop.ts`
   - progress → 3s, complete → 10s, need_input → 30s, default → 15s

8. **主循环 start()**: 保留 class 壳和 start()/stop() 签名
   - start(): 创建 RuntimeInstance → 启动 while 循环（不再注册 trigger/handler）
   - stop(): 清循环标志 → 更新 instance 为 terminated

**删除的旧代码：**
- `scanForWork()` → 被 observe() 替代
- `tryClaim()` → 被 resolveTarget() + agentStep() 替代
- `execute()` → 被 agentStep() 替代
- `canClaim()` → 被 resolveTarget() 内部逻辑替代
- `registerAgentTriggers()` → 不再需要 EVENT trigger
- `onNewWorkUnit()` → EventBus 入口不再需要
- `analyzeKnowledgeSearchFromLog()` → 知识消费记录不在 Loop 职责
- 旧 `postToDiscussionSpace()` → EventBus 版本被直接 DB 写入替代

**保留的代码：**
- `stop()` 方法（简化：只设 alive=false + 更新 instance）
- `parseAcceptedTypes()` 方法（channel/type 过滤用）
- `constructor(role, registry)`（registry 参数保留但不再用于 EVENT）
- 模块级函数：`analyzeKnowledgeSearch()`, `getKnowledgeSearchDetail()`, `extractKnowledgeEntryIds()` — 被其他模块使用

**Architecture Context**
- Functions: 见上述 7 个新函数
- Call Chain: `start()` → `while(alive)` → `observe()` → `resolveTarget()` → `agentStep()` → `recordResult()` → `sleep()`
- Imports:
  - 新增: `@dommaker/studio-agent` → `agentRunner`（替代 `agentExecutor`）
  - 删除: `eventBus`, `registerExecuteHandler`, `unregisterExecuteHandler`, `TriggerScheduler`
  - 保留: `prisma`, `logger`, `WorkUnitService`, `parseStreamEvents`, `extractToolCalls`
- Danger Zones:
  - `agentRunner.executeLightweight()` 签名不变，workUnitId 走 parameters
  - `WorkUnitService.claim()` 仍需使用（agentStep 内 claim unassigned WorkUnit）
  - `WorkUnitService.transitionStatus()` 仍需使用（recordResult 内状态转换）
- Verified At: agent-loop.test.ts（需重写）

**Code Patterns**
- session 管理：查 metadata.sessionId → 有则 `--resume`，无则 `--session-id <uuid>` + 写入 metadata
- 输出解析：正则 `/ACTION:\s*(PROGRESS|COMPLETE|NEED_INPUT):(.*)/` 匹配 Agent 输出最后一行

**Gotchas**
- `agentRunner` 是单例，不是 `agentExecutor`。`agentExecutor` 不设 outputText（这是旧 bug 根因）
- observe 查 myActive 必须含 `blocked` 状态，否则 blocked WorkUnit 的人类回复会丢失
- resolveTarget 不做多候选 LLM 选择（符合 `no_model_for_deterministic`）
- claim 操作在 agentStep 内（resolveTarget 返回 unassigned WorkUnit 后，agentStep 先 claim 再执行）

---

## ac-eventbus-cleanup

**Implementation Notes**

1. **删除文件**：
   - `apps/api/src/modules/workunit/workunit-events.ts`
   - `apps/api/src/modules/workunit/cycle-detection.ts`

2. **修改 `workunit.service.ts`**：
   - 删除 import: `workunit-events.ts`（6 个 emit 函数）、`cycle-detection.ts`（validateNoCycle）
   - 删除 `unlockDependents()` 方法（L551-584）
   - 删除 `getExistingEdges()` 私有方法（L232-242）
   - 从 `create()` 中删除 `validateNoCycle()` 调用
   - 从 `transitionStatus()` 中删除所有 `emit*()` 调用
   - 从 `transitionStatus()` 中删除 `unlockDependents()` 调用（在 `done` 和 `closed` 分支）
   - 从 `claim()` 中删除 `emitWorkUnitClaimed()` 调用
   - 从 `reviewPassed()` 中删除 emit + unlockDependents 调用
   - 从 `reviewRejected()` 中删除 emit 调用

3. **删除测试**：
   - `__tests__/workunit-events.test.ts`
   - `__tests__/cycle-detection.test.ts`

**Architecture Context**
- Call Chain: `workunit.service.ts` → emit → `eventBus.publish()` → `channel-message.events.ts` subscriber（全链路删除）
- Danger Zones:
  - `transitionStatus()` 的 VALID_TRANSITIONS 状态机不改
  - `aggregateParentStatus()` 不改（父子聚合仍有价值）
  - `claim()` 的乐观锁逻辑不改
- Verified At: workunit.service.test.ts（需更新 mock）

---

## ac-channel-cleanup

**Implementation Notes**

1. **删除文件**：`apps/api/src/modules/channels/channel-message.events.ts`
2. **修改 `channel-message.service.ts`**：删除 `eventBus.publish('channel.message.created', ...)` 调用（如果有）。注意：该文件发布的事件是 `channel.message_sent` 和 `channel.message_updated`（不是 `channel.message.created`），需确认哪些 publish 要删除
3. **删除测试**：`__tests__/channel-message.events.test.ts`
4. **删除 app startup 注册**：如果 `registerChannelMessageEvents()` 在 `index.ts` 被调用，删除该调用

**Architecture Context**
- Call Chain: `agent-loop.ts:postToDiscussionSpace()` → `eventBus.publish('channel.message.created')` → `channel-message.events.ts` subscriber → `prisma.channelMessage.create()` — 改为 agent-loop 直接 `prisma.channelMessage.create()`
- Danger Zones: `channel-message.service.ts` 的 `createHumanMessage()`、`createAgentMessage()`、`listByWorkUnitId()` 不改
- Verified At: channel-message.events.test.ts（删除）

---

## ac-dependson-cleanup

**Implementation Notes**

1. **修改 schema.prisma**：
   - 从 WorkUnit model 删除 `dependsOn String @default("[]")` 字段
   - 删除相关 index（如果有）

2. **修改 workunit.service.ts**：
   - 从 `CreateWorkUnitInput` interface 删除 dependsOn 字段
   - 从 `UpdateWorkUnitInput` interface 删除 dependsOn 字段
   - 从 `create()` 方法删除 dependsOn 参数处理
   - 从 `update()` 方法删除 dependsOn 参数处理
   - 删除 `getExistingEdges()` 私有方法（ac-eventbus-cleanup 可能已删）

3. **修改 workunit.routes.ts**：
   - 从 POST `/` handler 删除 dependsOn 参数传递
   - 从 PUT `/:id` handler 删除 dependsOn 参数传递

4. **生成 Prisma migration**：
   - `npx prisma migrate dev --name remove-depends-on`
   - migration SQL: `ALTER TABLE work_unit DROP COLUMN depends_on`

**Architecture Context**
- Danger Zones:
  - WorkUnit 的其他字段（parentId, children, parent relation）不改
  - `aggregateParentStatus()` 不改（父子关系独立于 dependsOn）
- Verified At: workunit-schema.test.ts（需更新）

---

## ac-trigger-cleanup

**Implementation Notes**

1. **修改 `default-triggers.ts`**：
   - 从 `getDefaultTriggerConfigs()` 数组删除 agent-discover（L~50-80）、dependency-unlock（L~80-120）、poll-fallback（L~120-140）对象
   - 从 `registerDefaultTriggers()` 同步删除（如果是独立定义的）
   - 保留 6 个 trigger 定义不变

2. **修改 `trigger.types.ts`**：
   - 从 `TriggerCondition` union type 删除 EVENT 分支（L7）
   - 保留 SCHEDULE 分支

3. **修改 `trigger-scheduler.ts`**：
   - 删除 `subscribeEvent()` 方法（L162-189）
   - 删除 `unsubscribeEvent()` 方法（L192-198）
   - 删除 `eventSubscriptions: Map` 字段（L17）
   - 从 `registerTrigger()` 中删除 EVENT 分支逻辑（L48-67 中 EVENT 部分）

4. **修改 `trigger-action.ts`**：
   - 删除 `resolveTemplate()` 函数（L114-134）
   - 删除 `getNestedValue()` 函数（L137-148）
   - 从 `executeUpdateAction()` 中删除 `$event` 模板解析逻辑（L98-100）
   - 简化 UPDATE action 为直接 query/update（无模板）

5. **修改 `trigger-store.ts`**：
   - 从 `validateTrigger()` 删除 EVENT 条件验证分支（L27-29）

6. **清理 YAML 文件**：
   - 删除 `~/.studio/triggers/agent-discover.yaml`
   - 删除 `~/.studio/triggers/dependency-unlock.yaml`
   - 删除 `~/.studio/triggers/poll-fallback.yaml`

**Architecture Context**
- Danger Zones:
  - SCHEDULE trigger 的 cron 匹配逻辑不改
  - CREATE action 不改（4 个知识审计 trigger 使用）
  - EXECUTE action 不改（agent-timeout 使用）
  - UPDATE action 的 query/update 基本功能不改（workunit-timeout 使用，但不含 $event 模板）
- Verified At: default-triggers.test.ts, trigger 相关测试

---

## ac-tests

**Implementation Notes**

1. **新建 `agent-loop-v2.test.ts`**：
   - `describe('observe()')`: 3 个测试（myActive 含 blocked、unassigned 过滤、newReplies 时间游标）
   - `describe('resolveTarget()')`: 4 个测试（reply 优先级、active 继续、unassigned 取最早、null 无目标）
   - `describe('parseAgentOutput()')`: 5 个测试（PROGRESS/COMPLETE/NEED_INPUT 解析、格式容错、空输入）
   - `describe('dynamicInterval()')`: 4 个测试（3s/10s/30s/15s 返回值）

2. **更新 `agent-loop.test.ts`**：
   - 删除旧 describe 块（start/stop/scanForWork/tryClaim/execute 旧逻辑）
   - 更新 mock 依赖（删除 eventBus、registerExecuteHandler、TriggerScheduler mock）
   - 新增 mock: agentRunner.executeLightweight

3. **更新 `agent-loop-e2e.test.ts`**：
   - 适配新循环结构（observe→resolveTarget→agentStep→recordResult）
   - 更新 mock Agent 输出为 ACTION 协议格式

**Architecture Context**
- Test Mock Pattern:
  - `prisma.workUnit.findMany` → mock 返回 fixture WorkUnit
  - `prisma.channelMessage.findMany` → mock 返回 fixture messages
  - `agentRunner.executeLightweight` → mock 返回 `ExecutionResult { outputText: 'ACTION: ...' }`
  - `WorkUnitService.claim` → mock 返回成功
  - `WorkUnitService.transitionStatus` → mock spy 验证调用
