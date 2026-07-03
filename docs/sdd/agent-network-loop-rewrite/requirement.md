---
id: "cwyr2787t59mr372fyz"
slug: "agent-network-loop-rewrite"
title: "Agent Network Agent Loop 重写"
status: "implemented"
tier: "premium"
version: 1
requirementVersion: 1
designVersion: 1
taskVersion: 1
tags: ["agent-network", "agent-loop", "eventbus-cleanup", "dependsOn-removal", "architecture"]
createdAt: "2026-07-02T18:00:00.000Z"
updatedAt: "2026-07-02T18:00:00.000Z"
---

## Agent Network Agent Loop 重写

将 agent-loop.ts 从一次性管道（scan→claim→execute→done）重写为 observe→resolveTarget→agentStep→recordResult 决策循环，同步清除 EventBus 残留、dependsOn 机制、废弃 trigger。

## 背景

E2E 验证发现 Agent Network EventBus 架构存在 9 个断点、5 个设计问题。第一性分析结论：EventBus 三层（级联/通知/可见性）都不是，不需要存在。Agent = 外部算力进程，编排层零 LLM 调用。

设计文档：`studio/docs/agent-network-loop-design.md`

## AC Groups

### ac-agent-runner-home

covers: [源项目 #6]

#### 验收标准
- [ ] 修改 `packages/studio-agent/src/services/agent-runner.ts` 中 HOME 路径从 `/tmp/execution-${task.executionId}` 改为 `/tmp/agent-loop/${workUnitId}`，workUnitId 从 `task.parameters.workUnitId` 获取，fallback 用 executionId（向后兼容）
- [ ] 当 `task.parameters.workUnitId` 存在时，env 注入 `STUDIO_WORKUNIT_ID` 环境变量
- [ ] 运行 `npx tsc --noEmit` 类型检查通过
- [ ] 运行 `pnpm test -- agent-runner` 现有测试通过

#### 涉及文件
- `packages/studio-agent/src/services/agent-runner.ts`（修改 HOME 路径 + env 注入）

#### 依赖: 无

---

### ac-metadata-types

covers: [源项目 #8]

#### 验收标准
- [ ] 在 `workunit.service.ts` 中扩展 `WorkUnitMetadata` interface，增加字段：`sessionId?: string`、`stepCount?: number`、`startedAt?: string`、`consecutiveStuck?: number`、`sessionResumes?: number`
- [ ] 运行 `npx tsc --noEmit` 类型检查通过

#### 涉及文件
- `apps/api/src/modules/workunit/workunit.service.ts`（修改 WorkUnitMetadata interface）

#### 依赖: 无

---

### ac-agent-loop-rewrite

covers: [源项目 #1]

#### 验收标准
- [ ] 实现 `observe()` 函数：查询 `myActive`（status in ['active', 'blocked'] + assigneeId = me）、`unassigned`（status='unassigned' + channelId 过滤 + type 过滤，按 createdAt asc，take 5）、`newReplies`（authorType='human' + createdAt > WorkUnit.updatedAt）
- [ ] 实现 `resolveTarget()` 函数：优先级 1=人类回复（含 blocked WorkUnit）→ 优先级 2=active WorkUnit 继续 → 优先级 3=取 unassigned[0]（最早 createdAt）→ 优先级 4=null
- [ ] 实现 `agentStep()` 函数：session 管理（查 WorkUnit.metadata.sessionId → resume 或新建）→ 调用 `agentRunner.executeLightweight()` → 返回 `StepResult { action: 'progress'|'complete'|'need_input', summary: string }`
- [ ] 实现 `recordResult()` 函数：监控检查点（stepCount > 15 → in_review，consecutiveStuck >= 3 → blocked）+ 按 action 处理状态转换（progress→post+blocked→active，complete→post+in_review，need_input→post+blocked）
- [ ] 实现 `postToDiscussionSpace()` 函数：直接 `prisma.channelMessage.create()`，不使用 EventBus
- [ ] 实现 `parseAgentOutput()` 函数：解析 `ACTION: PROGRESS|COMPLETE|NEED_INPUT` 格式
- [ ] 实现主循环 `while(alive) { observe → resolveTarget → agentStep → recordResult → sleep(dynamicInterval) }`，替代 setInterval + scanForWork
- [ ] 删除旧代码：`subscribeEvent()` 注册、`registerExecuteHandler` 调用、`execute()` 方法、旧的 `postToDiscussionSpace()`（EventBus 版本）、`canClaim()`、`registerAgentTriggers()`、`analyzeKnowledgeSearchFromLog()`
- [ ] 保留：`stop()` 方法（清理逻辑）、`parseAcceptedTypes()`、模块级导出函数（`analyzeKnowledgeSearch`、`extractKnowledgeEntryIds`、`getKnowledgeSearchDetail`）
- [ ] 运行 `npx tsc --noEmit` 类型检查通过

#### 涉及文件
- `apps/api/src/modules/agents/agent-loop.ts`（重写，380→~200 行）

#### 依赖: ac-agent-runner-home, ac-metadata-types

---

### ac-eventbus-cleanup

covers: [源项目 #2, #7]

#### 验收标准
- [ ] 删除文件 `apps/api/src/modules/workunit/workunit-events.ts`
- [ ] 删除文件 `apps/api/src/modules/workunit/cycle-detection.ts`
- [ ] 从 `workunit.service.ts` 删除 `unlockDependents()` 方法、`validateNoCycle()` 调用、所有 `emit*()` 函数调用（`emitWorkUnitCreated`、`emitWorkUnitStatusChanged`、`emitWorkUnitDone`、`emitWorkUnitReviewPassed`、`emitWorkUnitReviewRejected`、`emitWorkUnitClaimed`）
- [ ] 从 `workunit.service.ts` 删除 `create()` 中的 `validateNoCycle()` 调用和 `getExistingEdges()` 私有方法
- [ ] 删除测试文件 `__tests__/workunit-events.test.ts` 和 `__tests__/cycle-detection.test.ts`
- [ ] 运行 `npx tsc --noEmit` 确认零引用（无 import 指向已删除文件）
- [ ] 运行 `pnpm test -- workunit` 现有测试通过

#### 涉及文件
- `apps/api/src/modules/workunit/workunit-events.ts`（删除）
- `apps/api/src/modules/workunit/cycle-detection.ts`（删除）
- `apps/api/src/modules/workunit/workunit.service.ts`（删除 unlockDependents + emit 调用 + cycle 检测）
- `apps/api/src/modules/workunit/__tests__/workunit-events.test.ts`（删除）
- `apps/api/src/modules/workunit/__tests__/cycle-detection.test.ts`（删除）

#### 依赖: ac-agent-loop-rewrite（新 agent-loop 不再 emit 事件）

---

### ac-channel-cleanup

covers: [源项目 #4]

#### 验收标准
- [ ] 删除文件 `apps/api/src/modules/channels/channel-message.events.ts`
- [ ] 从 `channel-message.service.ts` 删除 `eventBus.publish('channel.message.created', ...)` 调用（保留 DB 写入）
- [ ] 删除测试文件 `__tests__/channel-message.events.test.ts`
- [ ] 运行 `npx tsc --noEmit` 确认零引用
- [ ] 运行 `pnpm test -- channel` 现有测试通过

#### 涉及文件
- `apps/api/src/modules/channels/channel-message.events.ts`（删除）
- `apps/api/src/modules/channels/channel-message.service.ts`（删除 eventBus publish）
- `apps/api/src/modules/channels/__tests__/channel-message.events.test.ts`（删除）

#### 依赖: ac-agent-loop-rewrite（新 agent-loop 直接写 DB，不 publish event）

---

### ac-dependson-cleanup

covers: [源项目 #3]

#### 验收标准
- [ ] 从 `schema.prisma` WorkUnit model 删除 `dependsOn String @default("[]")` 字段
- [ ] 生成 Prisma migration（`npx prisma migrate dev`），migration 删除 `depends_on` 列
- [ ] 从 `workunit.service.ts` 删除 `create()` 和 `update()` 中 dependsOn 参数处理
- [ ] 从 `workunit.routes.ts` 删除 dependsOn 相关请求体参数处理
- [ ] 运行 migration 后数据不丢失（现有 WorkUnit 记录保留）
- [ ] 运行 `npx tsc --noEmit` 类型检查通过

#### 涉及文件
- `packages/studio-prisma/prisma/schema.prisma`（删除 dependsOn 字段）
- `apps/api/src/modules/workunit/workunit.service.ts`（删除 dependsOn 参数处理）
- `apps/api/src/modules/workunit/workunit.routes.ts`（删除 dependsOn 参数传递）

#### 依赖: ac-eventbus-cleanup（unlockDependents 已删除后才安全删 schema 字段）

---

### ac-trigger-cleanup

covers: [源项目 #5]

#### 验收标准
- [ ] 从 `default-triggers.ts` 删除 `agent-discover` trigger 定义（EVENT workunit.created → agent-loop）
- [ ] 从 `default-triggers.ts` 删除 `dependency-unlock` trigger 定义（EVENT workunit.done → UPDATE workunit）
- [ ] 从 `default-triggers.ts` 删除 `poll-fallback` trigger 定义（SCHEDULE */30 → agent-scan-workunits）
- [ ] 从 `trigger.types.ts` 删除 EVENT 条件类型（保留 SCHEDULE）
- [ ] 从 `trigger-scheduler.ts` 删除 `subscribeEvent()` 方法、`unsubscribeEvent()` 方法、`eventSubscriptions` Map 字段
- [ ] 从 `trigger-action.ts` 删除 `resolveTemplate()` 和 `getNestedValue()` 函数及 `$event` 模板逻辑
- [ ] 从 `trigger-store.ts` 删除 EVENT 条件类型验证逻辑
- [ ] 清理 `~/.studio/triggers/` 下对应 YAML 文件（agent-discover、dependency-unlock、poll-fallback）
- [ ] 保留 6 个 trigger：workunit-timeout、agent-timeout、knowledge-quality-audit、session-knowledge-extraction、zero-consumption-audit、knowledge-synthesis
- [ ] 运行 `npx tsc --noEmit` 类型检查通过
- [ ] 运行 `pnpm test -- trigger` 现有测试通过

#### 涉及文件
- `apps/api/src/modules/agents/default-triggers.ts`（删 3 trigger）
- `apps/api/src/modules/triggers/trigger.types.ts`（删 EVENT 类型）
- `apps/api/src/modules/triggers/trigger-scheduler.ts`（删 subscribeEvent/unsubscribeEvent）
- `apps/api/src/modules/triggers/trigger-action.ts`（删 resolveTemplate/getNestedValue/$event 逻辑）
- `apps/api/src/modules/triggers/trigger-store.ts`（删 EVENT 验证）

#### 依赖: ac-agent-loop-rewrite（新 agent-loop 不注册 EVENT handler）

---

### ac-tests

covers: [源项目 #9]

#### 验收标准
- [ ] 新建 `apps/api/src/modules/agents/__tests__/agent-loop-v2.test.ts`，覆盖 observe()（3 类查询）、resolveTarget()（4 优先级分支）、parseAgentOutput()（3 action 类型 + 格式容错）、dynamicInterval()（4 种返回值）
- [ ] 更新 `agent-loop.test.ts` 中因重写失效的测试（删除旧 describe 块、更新 mock 依赖）
- [ ] 更新 `agent-loop-e2e.test.ts` 适配新循环结构
- [ ] 所有测试运行 `pnpm test -- agent-loop` 通过
- [ ] 覆盖率 ≥ 80%（新代码）

#### 涉及文件
- `apps/api/src/modules/agents/__tests__/agent-loop-v2.test.ts`（新建）
- `apps/api/src/modules/agents/__tests__/agent-loop.test.ts`（更新）
- `apps/api/src/modules/agents/__tests__/agent-loop-e2e.test.ts`（更新）

#### 依赖: ac-agent-loop-rewrite, ac-eventbus-cleanup, ac-channel-cleanup, ac-trigger-cleanup

---

## 非目标

- **不改 Pipeline agent services**：`apps/api/src/modules/agents/agent.service.ts` 中的 Pipeline Agent CRUD/调度逻辑不受影响
- **不改 goals/* 废弃代码**：已标记 deprecated 的 Goal 体系代码不在本次范围
- **不改 studio-agent/* 执行逻辑**：Agent runtime 的执行逻辑不变，仅 HOME 路径变更
- **不改 Knowledge Engine / CONTEXT.md 质量系统**：独立于 Agent Loop 编排
- **不改 trigger-scheduler SCHEDULE 逻辑**：6 个保留的 SCHEDULE trigger 继续正常工作
- **不改 agent-profile / agent-instance 管理**：Agent 身份和运行时管理不变

## 源项目追溯

| # | 源项目 | 覆盖 AC Group |
|---|--------|-------------|
| 1 | agent-loop.ts 重写 | ac-agent-loop-rewrite |
| 2 | workunit-events.ts 删除 + emit 清理 | ac-eventbus-cleanup |
| 3 | cycle-detection.ts 删除 + dependsOn 清理 | ac-eventbus-cleanup, ac-dependson-cleanup |
| 4 | channel-message.events.ts 删除 + eventBus publish 清理 | ac-channel-cleanup |
| 5 | Trigger 清理（删 3 trigger + EVENT 类型） | ac-trigger-cleanup |
| 6 | agent-runner.ts HOME 路径变更 | ac-agent-runner-home |
| 7 | workunit.service.ts unlockDependents/dependsOn 删除 | ac-eventbus-cleanup, ac-dependson-cleanup |
| 8 | WorkUnit.metadata 扩展 | ac-metadata-types |
| 9 | agent-loop.ts 测试 | ac-tests |
