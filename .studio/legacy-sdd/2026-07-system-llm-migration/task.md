---
status: done
version: "1.0"
slug: 2026-07-system-llm-migration
title: 系统级 LLM 调用迁移 + A2A Backlog 整合 - 任务
created: 2026-07-21
---

## 执行概要

4 阶段，按依赖顺序串行。每阶段内可并行子任务。风险评估：

| Phase | 内容 | 风险 | 理由 |
|-------|------|------|------|
| Phase 1 | 基础设施：studio 角色 + systemExecutor + buildSpawnEnv 简化 + 前端提醒 + 初始化向导 | `[safe]` | 新建文件 + 简化函数，不改现有行为 |
| Phase 2 | 系统级 LLM 调用迁移（10 处 modelGateway -> systemExecutor）+ dead code 删除 | `[breaking]` | 改 10 个调用点，行为依赖 systemExecutor 正确性 |
| Phase 3 | review 系统代派 + A2A P2 预算闸门 + 树聚合 + 频道管线 + skill 降级 | `[breaking]` | 新增 WorkUnit 创建路径 + 状态机订阅 |
| Phase 4 | 废弃代码清理（删除 modelGateway/buildSpawnEnv/全局 key）+ RemoteExecutor | `[destructive]` | 删除多个模块 + 跨包影响 |

`[destructive]` Phase 4 在 tdd-implement 执行前需用户再次确认破坏性操作清单。

---

## Phase 1: 基础设施 `[safe]`

**目标**：建立 systemExecutor 基座，为 Phase 2 迁移做准备。

### 1.1 内置 studio 角色（AC-1.1 ~ AC-1.5）

| # | 任务 | 文件 | 测试 | 依赖 |
|---|------|------|------|------|
| T-1.1.1 | 新增 `ensureStudioProfile(fileStore)` 函数 | `agent-profile.service.ts` | `agent-profile.service.test.ts` 新增用例 | - |
| T-1.1.2 | `AgentProfileService.create()` 拒绝 name='studio' | `agent-profile.service.ts` | 同上 | T-1.1.1 |
| T-1.1.3 | `AgentProfileService.update()` 拒绝改名 'studio' | `agent-profile.service.ts` | 同上 | T-1.1.1 |
| T-1.1.4 | `AgentProfileService.delete()` 拒绝删 studio 角色 | `agent-profile.service.ts` | 同上 | T-1.1.1 |
| T-1.1.5 | `AgentProfileService.list()` 默认排除 studio | `agent-profile.service.ts` | 同上 | T-1.1.1 |
| T-1.1.6 | `agent-profile.routes.ts` 透传 `includeSystem` query 参数 | `agent-profile.routes.ts` | `agent-profile.routes.test.ts` | T-1.1.5 |
| T-1.1.7 | `agent-loop-registry.ts:mount()` 跳过 name='studio' | `agent-loop-registry.ts` | `agent-loop-registry.test.ts` 新增用例 | - |
| T-1.1.8 | `index.ts` 启动时调 `ensureStudioProfile()` | `index.ts` | 启动 smoke test | T-1.1.1 |

**并行性**：T-1.1.1~T-1.1.7 互不依赖，可并行。T-1.1.8 依赖 T-1.1.1。

### 1.2 systemExecutor 抽象（AC-1.6 ~ AC-1.10）

| # | 任务 | 文件 | 测试 | 依赖 |
|---|------|------|------|------|
| T-1.2.1 | 新建 `system-executor.ts` 文件骨架 + 类型定义 | `system-executor.ts` | - | - |
| T-1.2.2 | 实现 `run(prompt, options)` | `system-executor.ts` | `system-executor.test.ts` | T-1.2.1 |
| T-1.2.3 | 实现 `runJson<T>(prompt, options)` | `system-executor.ts` | 同上 | T-1.2.2 |
| T-1.2.4 | 实现 studio 角色 provider 读取 + `StudioRoleNotConfiguredError` | `system-executor.ts` | 同上 | T-1.2.1, T-1.1.1 |
| T-1.2.5 | 实现 token 度量写入 `studio-events.jsonl` | `system-executor.ts` | 同上 | T-1.2.2 |
| T-1.2.6 | 导出 `systemExecutor` 单例 | `system-executor.ts` | - | T-1.2.5 |

**并行性**：T-1.2.1 串行（骨架）；T-1.2.2~T-1.2.5 可并行（不同方法）。

### 1.3 buildSpawnEnv 简化（AC-1.11, AC-1.12）

| # | 任务 | 文件 | 测试 | 依赖 |
|---|------|------|------|------|
| T-1.3.1 | 简化 `buildSpawnEnv` 为 `{ ...extra }` | `spawn-claude-cli.ts` | `spawn-claude-cli.test.ts` 更新 | - |
| T-1.3.2 | 加 `@deprecated` JSDoc | `spawn-claude-cli.ts` | - | T-1.3.1 |

### 1.4 前端提醒机制（AC-2.1 ~ AC-2.4）

| # | 任务 | 文件 | 测试 | 依赖 |
|---|------|------|------|------|
| T-1.4.1 | API list 加 `includeSystem` 参数 | `apps/web/src/api/agents.ts` | - | T-1.1.6 |
| T-1.4.2 | 新建 `StudioRoleSetupModal.tsx` | `apps/web/src/components/setup/` | 组件测试 | T-1.4.1 |
| T-1.4.3 | 新建 `FirstRoleSetupModal.tsx` | 同上 | 组件测试 | T-1.4.1 |
| T-1.4.4 | `App.tsx` 启动时检测 studio provider=null + 无角色 -> 弹框 | `App.tsx` | - | T-1.4.2, T-1.4.3 |
| T-1.4.5 | 新建 `ReviewHint.tsx`（in_review + 无 reviewer 横幅） | `apps/web/src/components/workunit/` | 组件测试 | - |
| T-1.4.6 | `WorkUnitDetail.tsx` 渲染 `ReviewHint` | `apps/web/src/pages/` | - | T-1.4.5 |

**并行性**：T-1.4.2, T-1.4.3, T-1.4.5 可并行。

### 1.5 角色初始化向导（AC-2.5, AC-2.6）

| # | 任务 | 文件 | 测试 | 依赖 |
|---|------|------|------|------|
| T-1.5.1 | `daemon.routes.ts` 新增 `GET /daemons/runtimes` 接口 | `apps/api/src/modules/daemons/` | 路由测试 | - |
| T-1.5.2 | `studio-daemon.ts` 上报 runtime 清单（binary/version/nodeId） | `apps/api/src/daemon/` | 单元测试 | - |
| T-1.5.3 | 提取 `ChannelMemberManager` 表单为可复用组件 + 补 description + provider | `apps/web/src/components/channel/` | 组件测试 | - |
| T-1.5.4 | 新建 `RolesSetup.tsx` 向导页 | `apps/web/src/pages/setup/` | 组件测试 | T-1.5.1, T-1.5.3 |
| T-1.5.5 | `App.tsx` 加路由 `/setup/roles` | `App.tsx` | - | T-1.5.4 |

### Phase 1 里程碑

- M1.1: studio 角色创建 + agentLoopRegistry 跳过 mount + 前端可见（T-1.1.x 完成）
- M1.2: systemExecutor 可用（T-1.2.x 完成）
- M1.3: 前端提醒 + 向导可用（T-1.4.x, T-1.5.x 完成）
- 验证：`pnpm test` + `pnpm run build` 通过

---

## Phase 2: 系统级 LLM 调用迁移 `[breaking]`

**目标**：10 处 modelGateway 调用全部改 systemExecutor。

### 2.1 迁移调用点（AC-3.1 ~ AC-3.7）

| # | 任务 | 文件 | 测试 | 依赖 |
|---|------|------|------|------|
| T-2.1.1 | 迁移 `knowledge-maintenance.ts` 4 处 | `knowledge-maintenance.ts` | `knowledge-maintenance.test.ts` 更新 mock | Phase 1 完成 |
| T-2.1.2 | 迁移 `triage-agent.service.ts:378` | `triage-agent.service.ts` | `triage-agent.test.ts` 更新 | Phase 1 完成 |
| T-2.1.3 | 迁移 `knowledge-service.ts:512` | `knowledge-service.ts` | 对应测试更新 | Phase 1 完成 |
| T-2.1.4 | 迁移 `evolution.service.ts` 2 处 | `evolution.service.ts` | 对应测试更新 | Phase 1 完成 |
| T-2.1.5 | 迁移 `skill-extraction.service.ts:302` | `skill-extraction.service.ts` | 对应测试更新 | Phase 1 完成 |
| T-2.1.6 | 迁移 `decision-chain-extractor.ts:87` | `decision-chain-extractor.ts` | 对应测试更新 | Phase 1 完成 |
| T-2.1.7 | 迁移 `entries.routes.ts:101` | `entries.routes.ts` | 对应测试更新 | Phase 1 完成 |

**并行性**：7 个文件互不依赖，可全部并行（parallel-execution）。

### 2.2 dead code 删除（AC-3.8）

| # | 任务 | 文件 | 依赖 |
|---|------|------|------|
| T-2.2.1 | 删除 `improver-scheduler.service.ts` + 测试 | `knowledge/` | - |
| T-2.2.2 | `index.ts` 移除相关引用（如有） | `index.ts` | T-2.2.1 |

### 2.3 modelGateway 标 deprecated（AC-3.10, AC-3.11）

| # | 任务 | 文件 | 依赖 |
|---|------|------|------|
| T-2.3.1 | `model-gateway.ts` 顶部加 `@deprecated` JSDoc | `model-gateway.ts` | - |
| T-2.3.2 | `index.ts:69` 加 TODO 注释 | `index.ts` | - |

### 2.4 全量验证（AC-3.9, AC-3.12）

| # | 任务 | 验证方法 | 依赖 |
|---|------|---------|------|
| T-2.4.1 | grep 验证 modelGateway 调用归零 | `grep -r "modelGateway\.\(prompt\|promptJson\|chat\)" apps/api/src/ --include="*.ts" \| grep -v __tests__` 输出空 | T-2.1.x |
| T-2.4.2 | 全量测试 | `pnpm test` 通过 | T-2.1.x, T-2.2.x |
| T-2.4.3 | 类型检查 | `npx tsc --noEmit` 无错误 | T-2.1.x |

### Phase 2 里程碑

- M2.1: 10 处调用迁移完成（T-2.1.x 完成）
- M2.2: dead code + deprecated 标注完成（T-2.2.x, T-2.3.x 完成）
- 验证：grep 输出空 + 全量测试通过

---

## Phase 3: review 系统代派 + A2A P2 `[breaking]`

**目标**：review 走角色派发；A2A P2 预算/树聚合/管线/skill 降级。

### 3.1 ReviewDispatcher（AC-4.1 ~ AC-4.8）

| # | 任务 | 文件 | 测试 | 依赖 |
|---|------|------|------|------|
| T-3.1.1 | 新建 `review-dispatcher.ts` 骨架 + 类型 | `review-dispatcher.ts` | - | Phase 2 完成 |
| T-3.1.2 | 实现 `subscribeToEvents()`（订阅 workunit.status_changed） | 同上 | 单元测试 | T-3.1.1 |
| T-3.1.3 | 实现 `findReviewerInChannel(channelId)` | 同上 | 单元测试 | T-3.1.1 |
| T-3.1.4 | 实现 `createReviewWorkUnit(parent, reviewer)`（绕过 DelegationGate + 同父唯一性校验） | 同上 | 单元测试 | T-3.1.3 |
| T-3.1.5 | 实现 `onReviewComplete(child, parent)`（解析 metadata.reviewReport -> reviewPassed/reviewRejected） | 同上 | 单元测试 | T-3.1.4 |
| T-3.1.6 | `agent-loop.ts:recordResult()` reviewer 角色 complete 时写 metadata.reviewReport | `agent-loop.ts` | `agent-loop.test.ts` 更新 | T-3.1.5 |
| T-3.1.7 | `agent-loop.ts:agentStep()` reviewer 角色 claim 后注入父 WU git diff context | `agent-loop.ts` | 同上 | T-3.1.6 |
| T-3.1.8 | `index.ts` 启动时 `reviewDispatcher.subscribeToEvents()` | `index.ts` | - | T-3.1.2 |
| T-3.1.9 | `routes.ts:154` 移除 `reviewAgent.review` 调用 | `routes.ts` | 路由测试 | T-3.1.8 |
| T-3.1.10 | 验证 code-review skill 在 reviewer 角色 skillLoader 路径下 | `~/.studio/skills/code-review/SKILL.md` + `manifest-loader.ts` | 手动验证 | - |

**并行性**：T-3.1.2~T-3.1.5 串行（同一文件递进）；T-3.1.10 可并行。

### 3.2 A2A P2 预算闸门（AC-5.1 ~ AC-5.3）

| # | 任务 | 文件 | 测试 | 依赖 |
|---|------|------|------|------|
| T-3.2.1 | 重构 `checkTreeBudget(rootId, fileStore)` 签名 + 实现 | `delegation-gate.ts` | `delegation-gate.test.ts` 新增用例 | - |
| T-3.2.2 | `checkDelegation` 第 8 步调新签名 | `delegation-gate.ts` | 同上 | T-3.2.1 |
| T-3.2.3 | `resolveMaxDepth` 默认 1 -> 2 | `delegation-gate.ts` | 同上 | - |
| T-3.2.4 | `token-usage.service.ts` 新增 `aggregateTreeTokens(rootId)` | `token-usage.service.ts` | `token-usage.service.test.ts` 新增用例 | - |

### 3.3 树聚合只读接口 + UI（AC-5.4 ~ AC-5.7）

| # | 任务 | 文件 | 测试 | 依赖 |
|---|------|------|------|------|
| T-3.3.1 | 新增 `GET /api/v1/workunits/:id/tree-tokens` 接口 | `workunit.routes.ts` | 路由测试 | T-3.2.4 |
| T-3.3.2 | 新建 `TreeTokenDrawer.tsx`（树状开销抽屉） | `apps/web/src/components/workunit/` | 组件测试 | T-3.3.1 |
| T-3.3.3 | `WorkUnitDetail.tsx` 加抽屉 | `apps/web/src/pages/` | - | T-3.3.2 |
| T-3.3.4 | ~~`DelegateCard.tsx` 加"树开销 x/预算"~~ **作废（2026-08-04）**：委派拒绝原因文本已含「已耗 X / 上限 Y」（delegation-gate.ts，后端权威预算），TreeTokenDrawer 提供完整树开销；独立组件属重复展示且预算硬编码有失真风险，组件+接线已删 | - | - | T-3.3.1 |

**并行性**：T-3.3.2, T-3.3.4 可并行（不同组件）。

### 3.4 频道默认管线（AC-6.1 ~ AC-6.3）

| # | 任务 | 文件 | 测试 | 依赖 |
|---|------|------|------|------|
| T-3.4.1 | `ChannelData` 加 `defaultPipeline?: string[]` | `file-store.ts` | schema 测试 | - |
| T-3.4.2 | `channel.routes.ts` POST/PATCH 支持 defaultPipeline + 校验 | `channel.routes.ts` | 路由测试 | T-3.4.1 |
| T-3.4.3 | `workunit.service.ts:create()` type='feature' + defaultPipeline 存在 -> 创建链头子 WU | `workunit.service.ts` | `workunit.service.test.ts` 新增用例 | T-3.4.1 |

### 3.5 skill 降级通路（AC-6.4 ~ AC-6.6）

| # | 任务 | 文件 | 测试 | 依赖 |
|---|------|------|------|------|
| T-3.5.1 | `DemotionProposalStore` 新增 `approve(id)` 方法（写 frontmatter + 移动文件） | `skill-demotion.ts` | `skill-demotion.test.ts` 新增用例 | - |
| T-3.5.2 | `DemotionProposalStore` 新增 `reject(id)` 方法 | `skill-demotion.ts` | 同上 | T-3.5.1 |
| T-3.5.3 | 新增 `POST /api/v1/skills/demotion-proposals/:id/approve` 和 `/reject` 接口 | `skill.routes.ts` | 路由测试 | T-3.5.1, T-3.5.2 |
| T-3.5.4 | e2e 测试：构造零使用率 skill -> scanDemotionProposals -> approve -> 验证 frontmatter + 文件移动 | `skill-demotion.test.ts` | - | T-3.5.3 |

### Phase 3 里程碑

- M3.1: ReviewDispatcher 端到端可用（T-3.1.x 完成）
- M3.2: 预算闸门 + 树聚合 + UI 可见（T-3.2.x, T-3.3.x 完成）
- M3.3: 频道默认管线 + skill 降级通路可用（T-3.4.x, T-3.5.x 完成）
- 验证：`pnpm test` + e2e 用例通过

---

## Phase 4: 清理 + RemoteExecutor `[destructive]`

> **破坏性操作清单**（需用户确认后执行）：
> - 删除 4 个 LLM 模块文件（model-gateway/provider-registry/model-router/usage-tracker）
> - 删除 spawn-claude-cli.ts
> - 删除 LLM proxy.ts
> - 删除 getProviderApiKey.ts + 测试
> - 清理 `~/.claude/settings-deepseek.json` 明文 key
> - 移除 6 个环境变量引用（影响 cli/config.ts managed keys 列表）
> - 改 `packages/studio-shared/src/llm/index.ts` 导出（影响下游 import）
> - 改 `packages/studio-agent/src/services/runner-params.ts` 和 `session-manager.ts`（移除 buildSpawnEnv 调用）
> - 改 `review-agent.service.ts`（移除 4 处 buildSpawnEnv + 重写 review() 方法）

### 4.1 清理 buildSpawnEnv 消费方（AC-7.17, AC-7.18）

| # | 任务 | 文件 | 测试 | 依赖 |
|---|------|------|------|------|
| T-4.1.1 | `review-agent.service.ts` 4 处 buildSpawnEnv 移除；review() 方法重写（reviewDiff 保留） | `review-agent.service.ts` | `review-agent.test.ts` 更新 | Phase 3 完成 |
| T-4.1.2 | `runner-params.ts:388` 移除 buildSpawnEnv 调用，改为直接 spread `process.env` | `packages/studio-agent/src/services/runner-params.ts` | 对应测试更新 | T-4.1.1 |
| T-4.1.3 | `session-manager.ts:399` 移除 buildSpawnEnv 调用 | `packages/studio-agent/src/services/session-manager.ts` | 对应测试更新 | T-4.1.1 |

### 4.2 删除 LLM 旧模块（AC-7.1 ~ AC-7.6）

| # | 任务 | 文件 | 依赖 |
|---|------|------|------|
| T-4.2.1 | 删除 `model-gateway.ts` | `packages/studio-shared/src/llm/` | T-4.1.x 完成 |
| T-4.2.2 | 删除 `provider-registry.ts` | 同上 | T-4.2.1 |
| T-4.2.3 | 删除 `model-router.ts` + `__tests__/model-router.test.ts` | 同上 | T-4.2.1 |
| T-4.2.4 | 删除 `usage-tracker.ts` | 同上 | T-4.2.1 |
| T-4.2.5 | 删除 `spawn-claude-cli.ts` + `__tests__/spawn-claude-cli.test.ts` | 同上 | T-4.1.x 完成 |
| T-4.2.6 | `llm/index.ts` 移除 modelGateway/buildSpawnEnv export | `llm/index.ts` | T-4.2.1, T-4.2.5 |

### 4.3 删除全局 key 引用（AC-7.7 ~ AC-7.14）

| # | 任务 | 文件 | 依赖 |
|---|------|------|------|
| T-4.3.1 | `index.ts` 删除 `loadFromEnv()` 调用 + KNOWLEDGE_API_KEY provider 注册块 | `index.ts` | T-4.2.1 |
| T-4.3.2 | `config.service.ts` 移除 STUDIO_API_KEY 读取（321-325 行） | `config.service.ts` | - |
| T-4.3.3 | 删除 `proxy.ts` | `modules/llm/proxy.ts` | - |
| T-4.3.4 | `internal.routes.ts:126` 移除 KNOWLEDGE_API_KEY 读取 | `internal.routes.ts` | - |
| T-4.3.5 | `cli/config.ts` managed keys 列表移除 3 个 key | `cli/config.ts` | - |
| T-4.3.6 | 删除 `getProviderApiKey.ts` + `__tests__/getProviderApiKey.test.ts` | `packages/studio-shared/src/config/` | - |
| T-4.3.7 | `config/index.ts` 移除 PROVIDER_KEY_MAP/getProviderApiKey/WorkloadType export | `packages/studio-shared/src/config/index.ts` | T-4.3.6 |

### 4.4 配置文件清理（AC-7.15, AC-7.16）

| # | 任务 | 文件 | 依赖 |
|---|------|------|------|
| T-4.4.1 | 移除 `~/.claude/settings-deepseek.json` 中 STUDIO_API_KEY 明文 | 本地配置 | - |
| T-4.4.2 | 更新 A2A §10.1 第 8 条"双轨架构" | `docs/plans/2026-07-agent-to-agent-collab-design.md` | - |

### 4.5 文档同步（AC-7.20）

| # | 任务 | 文件 | 依赖 |
|---|------|------|------|
| T-4.5.1 | CAPABILITIES.md 移除 modelGateway/buildSpawnEnv 条目 + 新增 systemExecutor | `CAPABILITIES.md` | T-4.2.x |
| T-4.5.2 | 运行 `harness sync-docs` 验证 | - | T-4.5.1 |

### 4.6 RemoteExecutor（AC-8.1 ~ AC-8.9）

| # | 任务 | 文件 | 测试 | 依赖 |
|---|------|------|------|------|
| T-4.6.1 | `AgentTask` 加 `nodeId?: string` | `packages/studio-agent/src/types.ts` | 类型测试 | - |
| T-4.6.2 | `AgentProfileData` 加 `nodeId?: string` | `file-store.ts` | schema 测试 | - |
| T-4.6.3 | `ws-gateway.ts` 新增 `agent-task` 消息类型路由 | `ws-gateway.ts` | 单元测试 | T-4.6.1 |
| T-4.6.4 | `task-executor.ts` 新增 `agent-task` handler + 调 agentRunner.executeLightweight + 写 workunit:tokens | `task-executor.ts` | 单元测试 | T-4.6.3 |
| T-4.6.5 | 新建 `remote-executor.ts` 实现 `Executor` 接口 + 30s 超时 | `remote-executor.ts` | `remote-executor.test.ts` | T-4.6.3 |
| T-4.6.6 | `agent-loop.ts:constructor` 根据 `profile.nodeId` 选 Executor | `agent-loop.ts` | `agent-loop.test.ts` 更新 | T-4.6.5 |
| T-4.6.7 | `monitor-agent.service.ts` 节点心跳超时 -> profile lastError='node offline' | `monitor-agent.service.ts` | 单元测试 | - |

**并行性**：T-4.6.1, T-4.6.2 可并行；T-4.6.3 依赖 T-4.6.1；T-4.6.4, T-4.6.5 依赖 T-4.6.3；T-4.6.7 独立。

### 4.7 全量验证（AC-7.19）

| # | 任务 | 验证方法 | 依赖 |
|---|------|---------|------|
| T-4.7.1 | grep 全局 key 引用归零 | `grep -r "STUDIO_API_KEY\|PIPELINE_API_KEY\|KNOWLEDGE_API_KEY" apps/ packages/ --include="*.ts" \| grep -v __tests__ \| grep -v dist` 输出空 | T-4.3.x |
| T-4.7.2 | grep modelGateway 调用归零 | `grep -r "modelGateway\.\(prompt\|promptJson\|chat\)" apps/api/src/` 输出空 | T-4.2.x |
| T-4.7.3 | grep buildSpawnEnv 引用归零 | `grep -r "buildSpawnEnv" apps/ packages/ --include="*.ts" \| grep -v __tests__ \| grep -v dist` 输出空 | T-4.1.x, T-4.2.5 |
| T-4.7.4 | 全量测试 | `pnpm test` 通过 | T-4.x 全部 |
| T-4.7.5 | 构建 | `pnpm run build` 成功 | T-4.x 全部 |
| T-4.7.6 | 类型检查 | `npx tsc --noEmit` 无错误 | T-4.x 全部 |

### Phase 4 里程碑

- M4.1: buildSpawnEnv 消费方清理完成（T-4.1.x 完成）
- M4.2: LLM 旧模块删除完成（T-4.2.x 完成）
- M4.3: 全局 key 引用归零（T-4.3.x, T-4.7.1 完成）
- M4.4: RemoteExecutor 可用（T-4.6.x 完成）
- M4.5: 全量验证通过（T-4.7.x 完成）

---

## 契约测试规划

### Phase 1 契约测试

| AC | 测试文件 | 测试用例 |
|----|---------|---------|
| AC-1.1 | `agent-profile.service.test.ts` | ensureStudioProfile 首次创建；已存在跳过；不发事件 |
| AC-1.2 | 同上 | create name='studio' 拒绝；update 改名 'studio' 拒绝 |
| AC-1.3 | `agent-loop-registry.test.ts` | mount studio 角色 -> status='skipped' |
| AC-1.4 | `agent-profile.service.test.ts` | list 默认排除 studio；includeSystem=true 包含 |
| AC-1.5 | 同上 | delete studio 角色拒绝 |
| AC-1.6~1.10 | `system-executor.test.ts` | run 返回 SystemExecutorResult；runJson 解析 JSON；provider=null 抛 StudioRoleNotConfiguredError；JSON parse 失败抛 SystemExecutorJsonParseError；写 system:tokens 事件 |
| AC-1.11 | `spawn-claude-cli.test.ts` | buildSpawnEnv 返回空 obj（不读 env）；extra 透传 |
| AC-2.1 | `apps/web/src/api/agents.test.ts` | list 含 includeSystem=true 参数 |
| AC-2.2 | `StudioRoleSetupModal.test.tsx` | studio provider=null -> 弹框；选 provider -> PATCH 调用；关闭后 sessionStorage 标记 |
| AC-2.3 | `FirstRoleSetupModal.test.tsx` | 无角色 -> 弹框；填表 -> POST 调用；关闭后 sessionStorage 标记 |
| AC-2.4 | `ReviewHint.test.tsx` | in_review + 无 reviewer -> 显示横幅；有 reviewer -> 不显示 |
| AC-2.5 | `RolesSetup.test.tsx` | runtime 清单渲染；勾选 + 填表 -> 批量 POST；空清单提示 |
| AC-2.6 | `daemon.routes.test.ts` | GET /daemons/runtimes 返回 runtime 清单；空列表返回 [] |

### Phase 2 契约测试

| AC | 测试文件 | 测试用例 |
|----|---------|---------|
| AC-3.1 | `knowledge-maintenance.test.ts` | 4 处调用 mock systemExecutor；mock 返回成功；mock 抛错 -> 跳过批次 |
| AC-3.2 | `triage-agent.test.ts` | LLM 兜底调 systemExecutor.run |
| AC-3.3~3.7 | 对应文件测试 | 同模式 |
| AC-3.8 | `ls` 验证文件不存在 | - |
| AC-3.9 | grep 验证 | - |
| AC-3.12 | 7 个调用方测试 | mock systemExecutor 替代 modelGateway |

### Phase 3 契约测试

| AC | 测试文件 | 测试用例 |
|----|---------|---------|
| AC-4.1~4.5 | `review-dispatcher.test.ts` | in_review + 有 reviewer -> 创建子 WU；in_review + 无 reviewer -> 跳过；reviewer complete + approved -> 父 reviewPassed；reviewer complete + rejected -> 父 reviewRejected；reviewer 输出格式异常 -> 父 reviewRejected |
| AC-4.4 | `agent-loop.test.ts` | reviewer 角色 claim 子 WU 后 prompt 含父 WU diff |
| AC-4.5 | 同上 | reviewer complete 时 metadata.reviewReport 被写入 |
| AC-5.1 | `delegation-gate.test.ts` | 预算未超 pass；预算超限 fail + reason 含数字 |
| AC-5.3 | 同上 | 默认 maxDepth=2；env=1 -> 1 |
| AC-5.5 | `token-usage.service.test.ts` | aggregateTreeTokens 单节点；多节点聚合；文件不存在零值 |
| AC-5.4 | `workunit.routes.test.ts` | GET tree-tokens 返回 TreeTokenReport；404 用例 |
| AC-6.3 | `workunit.service.test.ts` | type='feature' + defaultPipeline -> 创建链头子 WU；无 defaultPipeline -> 不展开 |
| AC-6.4~6.6 | `skill-demotion.test.ts` | e2e：零使用 skill -> scan -> approve -> frontmatter + 文件移动 |

### Phase 4 契约测试

| AC | 测试文件 | 测试用例 |
|----|---------|---------|
| AC-7.1~7.5 | `ls` 验证文件不存在 | - |
| AC-7.6 | grep llm/index.ts | 无 modelGateway/buildSpawnEnv export |
| AC-7.7 | grep 全局 | 6 个环境变量零引用 |
| AC-7.19 | `pnpm test` + `pnpm run build` + `npx tsc --noEmit` | 全部通过 |
| AC-8.1~8.5 | `remote-executor.test.ts` | 在线任务路由；离线超时抛 RemoteNodeUnreachableError；结果回传 |
| AC-8.6 | `agent-loop.test.ts` | nodeId='local' -> LocalExecutor；nodeId='node-1' -> RemoteExecutor |

---

## 执行顺序

### 串行依赖（Phase 间）

```
Phase 1 [safe] -> Phase 2 [breaking] -> Phase 3 [breaking] -> Phase 4 [destructive]
```

Phase 1 是 Phase 2 的前置（systemExecutor 必须先建好）。
Phase 2 是 Phase 3 的前置（review 迁移需要 systemExecutor 稳定）。
Phase 3 是 Phase 4 的前置（清理前所有消费方必须迁移完）。

### 并行机会（Phase 内）

- Phase 1: T-1.1.x / T-1.2.x / T-1.3.x / T-1.4.x / T-1.5.x 可并行（5 个独立子任务组）
- Phase 2: T-2.1.1 ~ T-2.1.7 可全部并行（7 个独立文件）
- Phase 3:
  - T-3.1.x（ReviewDispatcher）独立
  - T-3.2.x + T-3.3.x（预算 + 树聚合）独立
  - T-3.4.x（频道管线）独立
  - T-3.5.x（skill 降级）独立
  - 4 组可并行
- Phase 4:
  - T-4.1.x 必须先于 T-4.2.x（删除前清理消费方）
  - T-4.3.x 独立于 T-4.2.x（环境变量 vs 模块）
  - T-4.4.x, T-4.5.x 独立
  - T-4.6.x（RemoteExecutor）独立于其他清理
  - 4 组可并行（T-4.1 -> T-4.2 串行后，T-4.3/T-4.4/T-4.5/T-4.6 并行）

### 推荐 parallel-execution 分组

- Group A: Phase 2 T-2.1.1 ~ T-2.1.7（7 文件并行迁移）
- Group B: Phase 3 T-3.1.x + T-3.2.x + T-3.4.x + T-3.5.x（4 模块并行）
- Group C: Phase 4 T-4.3.x + T-4.4.x + T-4.5.x + T-4.6.x（4 模块并行，T-4.1/T-4.2 完成后）

---

## Implementation Readiness

implementationReady: true

| # | 条件 | 满足 | 证据/缺口 |
|---|------|------|----------|
| 1 | design.md 有精确 file:line 引用 | ✅ | design.md §2 文件映射表 + §3 接口定义含路径；requirement.md AC 含 grep 命令验证 |
| 2 | 非平凡变更有 before/after 代码块 | ✅ | design.md §8 实现伪代码：§8.1 systemExecutor（run/runJson/writeSystemTokenEvent/单例，4 节 before/after）；§8.2 ReviewDispatcher（subscribeToEvents/findReviewerInChannel/handleParentInReview+createReviewWorkUnit/handleReviewChildDone + AgentLoop 配合 2 节，6 节 before/after）；§8.3 RemoteExecutor（execute/ws-gateway handleMessage/daemon onAgentTask/AgentLoop constructor/类型扩展，6 节 before/after）；§8.4 树聚合（checkTreeBudget/checkDelegation 调用更新/aggregateTreeTokens/tree-tokens 接口，4 节 before/after）；§8.5 关键参考映射表 16 行 |
| 3 | 消费方覆盖（谁 import 受影响文件） | ✅ | design.md §4 依赖图列出 systemExecutor/ReviewDispatcher/树聚合的依赖；§2.7 列出 buildSpawnEnv 的 6 个消费方（review-agent 4 处 + runner-params + session-manager） |
| 4 | 测试断言具体（不只是"测试通过"） | ✅ | task.md "契约测试规划"节每个 AC 列出具体断言（如"mock 返回成功"、"mock 抛错 -> 跳过批次"） |
| 5 | 接口定义完整（签名+参数+返回值） | ✅ | design.md §3 含 SystemExecutor / ensureStudioProfile / ReviewDispatcher / checkTreeBudget / aggregateTreeTokens / RemoteExecutor / DemotionProposalStore 完整签名 |

**状态**：5 条全满足，implementationReady=true。

**模型设置建议**：tdd-implement 使用 CLI 轻量模型设置（所有任务接口已定 + 实现伪代码已给，直接 TDD）。
