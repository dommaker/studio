---
status: done
version: "1.0"
slug: 2026-07-system-llm-migration
title: 系统级 LLM 调用迁移 + A2A Backlog 整合 - 设计
created: 2026-07-21
---

## 1. 架构决策

### 1.1 第一性原则

Studio 是薄编排层（vision-2026 §1）。LLM 调用分两类：

- **系统内部任务**（knowledge-maintenance / triage / extraction / evolution / 用户问答）：高频低复杂度，由 studio 内置角色执行
- **review**：WorkUnit in_review 时触发的代码审查，由用户创建的 reviewer 角色 + code-review skill 执行

两类都不该走"全局 API key + modelGateway"（pipeline 时代设计），应统一走"角色 provider + CLI spawn"（agent network 时代设计）。

### 1.2 关键决策

| # | 决策 | 理由 | 对应 AC |
|---|------|------|---------|
| D1 | systemExecutor 复用 `resolveProviderDefinition` + `buildArgsFromTemplate` + `execSh`，不走 `Executor`/`AgentTask`/`agentRunner` | Executor 接口设计给 AgentLoop（含 sessionId/timeoutMs/120s 默认值/特定 parameters 形状），systemExecutor 是轻量 spawn（30s 超时/无状态），不该继承重型抽象 | AC-1.6 ~ AC-1.10 |
| D2 | studio 角色不 mount AgentLoop | AgentLoop 是为频道 @mention 派发设计的 observe->resolve->step->record 循环，studio 角色不消费 WU，不需要 loop。systemExecutor 直接 spawn | AC-1.3 |
| D3 | studio 角色通过 `fileStore.createProfile` 直接创建，不走 `AgentProfileService.create` | service.create 会发 `agent-profile.created` 事件 -> 触发 mount。studio 角色 mount 应跳过，但事件流的设计是"created 即 mount"，最简方案是绕过事件 | AC-1.1 |
| D4 | `buildSpawnEnv` 简化为 `{ ...extra }` 后保留类型签名 | `studio-agent` 包（runner-params.ts, session-manager.ts）和 review-agent.service.ts 共 6 处消费方在 AC Group 3/4 迁移完前不能删；类型签名保留让消费方继续编译 | AC-1.11 |
| D5 | review 系统代派用状态机驱动（`workunit.status_changed -> in_review`），不用 agent DELEGATE 协议 | 规划文档 §4.4 明确："系统代派不是 agent 主动 DELEGATE，而是状态机驱动"。DELEGATE 是 agent 输出 ACTION 协议，需要 agent 知道何时派 review（不该让 agent 决策） | AC-4.2 |
| D6 | review 子 WU 继承 collab 元数据但绕过 DelegationGate | DelegationGate 的 8 项校验（目标存在/非自派/深度/宽度/树规模/环/重复/预算）是为 agent 主动 DELEGATE 设计。系统代派的"目标=reviewer 角色"已由频道成员关系保证，深度/宽度/环也天然满足。调用 `checkDelegation` 会重复校验且可能因 `delegationCount >= 3` 拒绝合理 review | AC-4.3 |
| D7 | 旧 `reviewAgent.review()` 作为 fallback 保留至 AC Group 7 | AC Group 4 实现 ReviewDispatcher 后，review-agent.service.ts 的 `review()` 方法（spawn 模式）不再被新代码调用，但保留可让 `reviewDiff` 手动 API 继续工作。AC Group 7 移除 4 处 buildSpawnEnv 后，review 内部 spawn 也需重写或删除 | AC-4.6, AC-7.17 |
| D8 | `checkTreeBudget` 按 rootId 聚合 `workunit:tokens` 的 executionTokens 总和 | A2A §4.3 设计：树已耗 = sum(executionTokens)；子 WU 预估取 0（无先验数据）。子 WU 预估 TODO 标注后续可基于历史均值 | AC-5.1 |
| D9 | `STUDIO_COLLAB_MAX_DEPTH` 默认从 1 改为 2 | P1 深度=1（只允许根 WU 委派一次），P2 放开到 2（允许根->子->孙三层）。env 仍可覆盖 1-3 | AC-5.3 |
| D10 | 频道默认管线只展开第一跳，后续靠 agent DELEGATE | 规划文档 §5.3："复用 §4 DELEGATE 机制，第一跳由代码发起"。不全链路代码展开（避免与 DELEGATE 机制重复） | AC-6.3 |
| D11 | skill 降级通路接通人审 + 写 SKILL.md frontmatter + 移动到 `_deprecated/` | skill-demotion.ts 已有 ProposalStore 骨架，缺 approve/reject 通道 + 实际执行降级。approve -> frontmatter `status: archived` + 文件移动 | AC-6.4 |
| D12 | RemoteExecutor 通过 daemon WebSocket 通道路由 AgentTask | 现有 ws-gateway 已建立 server<->daemon 持久连接。新增 `agent-task` 消息类型走该通道，不引入新基础设施 | AC-8.4 |
| D13 | `AgentProfileData.nodeId` 默认 'local' | 现有 profile 无此字段 -> undefined -> `=== 'local'` false -> 需用 `profile.nodeId ?? 'local'` 判断。直接默认 'local' 更安全 | AC-8.3 |

### 1.3 不做决策

- 不重写 AgentLoop 执行模型（Claude CLI 限制，规划文档 §3.3 排除）
- 不实现 L2 分层审查（规划文档 §3.3 排除）
- 不实现 2K 注入硬截断（属飞轮修复范围）
- 不删除 `LLMClient`/`llmClient`（单独排期，本次仅迁移 modelGateway）

---

## 2. 文件映射表

### 2.1 AC Group 1: studio 角色 + systemExecutor

| AC | 文件路径 | 改动类型 | 改动内容 |
|----|---------|---------|---------|
| AC-1.1 | `apps/api/src/modules/agents/agent-profile.service.ts` | 新增方法 | `async ensureStudioProfile(fileStore: FileStore): Promise<AgentProfileData>` 幂等创建 studio 角色 |
| AC-1.1 | `apps/api/src/index.ts` | 修改 | 启动时调 `ensureStudioProfile()`（在 `agentLoopRegistry.subscribeToEvents()` 之前） |
| AC-1.2 | `apps/api/src/modules/agents/agent-profile.service.ts` | 修改 `create()` | 在 name uniqueness check 之前加 `if (input.name === 'studio') throw new Error('name studio is reserved')` |
| AC-1.2 | `apps/api/src/modules/agents/agent-profile.service.ts` | 修改 `update()` | 如果 `input.name === 'studio'` 抛错 |
| AC-1.3 | `apps/api/src/modules/agents/agent-loop-registry.ts:27 mount()` | 修改 | 第一行加 `if (profile.name === 'studio') return { profileId: profile.id, loop: null as any, status: 'skipped', error: 'system role' }`（MountedLoop.status 加 'skipped' 字面量） |
| AC-1.4 | `apps/api/src/modules/agents/agent-profile.service.ts:list()` | 修改 | 默认过滤 `p.name === 'studio'`；`options.includeSystem === true` 时包含 |
| AC-1.4 | `apps/api/src/modules/agents/agent-profile.routes.ts` | 修改 | query 参数 `includeSystem` 透传 |
| AC-1.5 | `apps/api/src/modules/agents/agent-profile.service.ts:delete()` | 修改 | 先读 profile，若 `name === 'studio'` 抛错 |
| AC-1.6 | `apps/api/src/modules/agents/system-executor.ts` | 新建 | SystemExecutor class + 单例 + 类型定义 |
| AC-1.6 | `apps/api/src/modules/agents/__tests__/system-executor.test.ts` | 新建 | 单元测试 |
| AC-1.7~1.10 | `apps/api/src/modules/agents/system-executor.ts` | 实现 | run/runJson + studio 角色 provider 读取 + buildArgsFromTemplate 调用 + execSh + JSON envelope 解析 + studio-events.jsonl 写入 |
| AC-1.11 | `packages/studio-shared/src/llm/spawn-claude-cli.ts:buildSpawnEnv` | 修改 | 简化为 `return { ...extra }`；保留类型签名 |
| AC-1.11 | `packages/studio-shared/src/llm/__tests__/spawn-claude-cli.test.ts` | 修改 | 更新断言：buildSpawnEnv 不再读 env 变量 |
| AC-1.12 | `packages/studio-shared/src/llm/spawn-claude-cli.ts` | 修改 | 加 `@deprecated use systemExecutor` JSDoc |

### 2.2 AC Group 2: 前端提醒 + 初始化向导

| AC | 文件路径 | 改动类型 | 改动内容 |
|----|---------|---------|---------|
| AC-2.1 | `apps/web/src/api/agents.ts` | 修改 | list 函数加 `includeSystem=true` 参数 |
| AC-2.2 | `apps/web/src/components/setup/StudioRoleSetupModal.tsx` | 新建 | studio 未配 provider 弹框 + provider 下拉 + PATCH 调用 |
| AC-2.2 | `apps/web/src/App.tsx` | 修改 | 启动时检测 studio 角色 provider=null -> 弹框 |
| AC-2.3 | `apps/web/src/components/setup/FirstRoleSetupModal.tsx` | 新建 | 无角色时弹框 + name/description/provider 表单 + POST 调用 |
| AC-2.3 | `apps/web/src/App.tsx` | 修改 | 启动时检测 profile 数量 |
| AC-2.4 | `apps/web/src/components/workunit/ReviewHint.tsx` | 新建 | in_review + 无 reviewer 时横幅提醒 |
| AC-2.4 | `apps/web/src/pages/WorkUnitDetail.tsx` | 修改 | 加载时渲染 ReviewHint |
| AC-2.5 | `apps/web/src/pages/setup/RolesSetup.tsx` | 新建 | 角色初始化向导页 |
| AC-2.5 | `apps/web/src/App.tsx` | 修改 | 加路由 `/setup/roles` |
| AC-2.5 | `apps/web/src/components/channel/ChannelMemberManager.tsx` | 修改 | 提取表单为可复用组件 + 补 description + provider 字段 |
| AC-2.6 | `apps/api/src/modules/daemons/daemon.routes.ts` | 新增接口 | `GET /api/v1/daemons/runtimes` 返回 runtime 清单 |
| AC-2.6 | `apps/api/src/daemon/studio-daemon.ts` | 修改 | daemon 上报时含 runtime 清单（binary/version/nodeId） |

### 2.3 AC Group 3: 系统级 LLM 调用迁移

| AC | 文件路径 | 改动类型 | 改动内容 |
|----|---------|---------|---------|
| AC-3.1 | `apps/api/src/modules/agents/knowledge-maintenance.ts` | 修改 | 4 处 `modelGateway.promptJson<T>(prompt, sysPrompt)` -> `systemExecutor.runJson<T>(prompt, { systemPrompt: sysPrompt })`；移除 `import { modelGateway }` |
| AC-3.2 | `apps/api/src/modules/agents/triage-agent.service.ts:378` | 修改 | `modelGateway.prompt(...)` -> `systemExecutor.run(...)`；移除动态 import |
| AC-3.3 | `apps/api/src/modules/knowledge/knowledge-service.ts:512` | 修改 | `modelGateway.promptJson` -> `systemExecutor.runJson` |
| AC-3.4 | `apps/api/src/modules/knowledge/evolution.service.ts:99,196` | 修改 | 2 处迁移 |
| AC-3.5 | `apps/api/src/modules/skills/skill-extraction.service.ts:302` | 修改 | 迁移 |
| AC-3.6 | `apps/api/src/modules/knowledge/decision-chain-extractor.ts:87` | 修改 | 迁移 |
| AC-3.7 | `apps/api/src/modules/knowledge/entries.routes.ts:101` | 修改 | 迁移 |
| AC-3.8 | `apps/api/src/modules/knowledge/improver-scheduler.service.ts` | 删除 | 整文件删除 |
| AC-3.8 | `apps/api/src/modules/knowledge/__tests__/improver-scheduler.service.test.ts` | 删除 | 同步删除 |
| AC-3.8 | `apps/api/src/index.ts` | 修改 | 移除 `startEvolutionScheduler` 调用中相关引用（如有） |
| AC-3.10 | `packages/studio-shared/src/llm/model-gateway.ts` | 修改 | 顶部加 `@deprecated` JSDoc |
| AC-3.11 | `apps/api/src/index.ts:69` | 修改 | 加 TODO 注释 |
| AC-3.12 | 上述 7 个调用方测试文件 | 修改 | mock systemExecutor 替代 modelGateway |

### 2.4 AC Group 4: review 系统代派

| AC | 文件路径 | 改动类型 | 改动内容 |
|----|---------|---------|---------|
| AC-4.1 | `apps/api/src/modules/agents/review-dispatcher.ts` | 新建 | ReviewDispatcher class + 单例 |
| AC-4.1 | `apps/api/src/modules/agents/__tests__/review-dispatcher.test.ts` | 新建 | 单元测试 |
| AC-4.2 | `apps/api/src/modules/agents/review-dispatcher.ts` | 实现 | 订阅 `workunit.status_changed`，status=in_review 时触发 |
| AC-4.3 | `apps/api/src/modules/agents/review-dispatcher.ts` | 实现 | 创建子 WU（parentId/assigneeId/type='review'/scope/collab 继承）；**绕过 checkDelegation**，直接调 `workUnitService.create()` |
| AC-4.4 | `apps/api/src/modules/agents/agent-loop.ts` | 修改 | reviewer 角色的 AgentLoop claim 子 WU 后，prompt 注入父 WU diff context（需读父 WU 的 workspaceRoot + git diff） |
| AC-4.5 | `apps/api/src/modules/agents/review-dispatcher.ts` | 实现 | 订阅子 WU `workunit.status_changed -> done`，解析 reviewer 输出（从 metadata.reviewReport），调 `workUnitService.reviewPassed(parentId)` 或 `reviewRejected(parentId, reason)` |
| AC-4.5 | `apps/api/src/modules/agents/agent-loop.ts:recordResult()` | 修改 | reviewer 角色 complete 时，把 review report 写入 metadata.reviewReport |
| AC-4.6 | `apps/api/src/modules/agents/routes.ts:154` | 修改 | 移除 `reviewAgent.review` 调用（reviewDiff 保留） |
| AC-4.7 | `~/.studio/skills/code-review/SKILL.md` | 验证 | 确认存在；frontmatter `agentType: reviewer` 或 `tags: [reviewer]` |
| AC-4.7 | `apps/api/src/modules/skills/manifest-loader.ts` | 验证 | load({ agentType: 'reviewer' }) 能命中 code-review |

### 2.5 AC Group 5: A2A P2 预算 + 树聚合 + UI

| AC | 文件路径 | 改动类型 | 改动内容 |
|----|---------|---------|---------|
| AC-5.1 | `apps/api/src/modules/workunit/delegation-gate.ts:checkTreeBudget` | 修改 | 签名 `checkTreeBudget(rootId, fileStore)`；实现：读 studio-events.jsonl 按 rootId 子树聚合 executionTokens；返回 `{ pass, reason? }` |
| AC-5.1 | `apps/api/src/modules/agents/token-usage.service.ts` | 新增方法 | `aggregateTreeTokens(rootId): TreeTokenReport` 读取 workunit:tokens 事件按 rootId 聚合 |
| AC-5.2 | `apps/api/src/modules/workunit/delegation-gate.ts:checkDelegation` | 修改 | 第 8 步调 `checkTreeBudget(parentCollab.rootId, fileStore)` |
| AC-5.3 | `apps/api/src/modules/workunit/delegation-gate.ts:resolveMaxDepth` | 修改 | 默认值 1 -> 2 |
| AC-5.4 | `apps/api/src/modules/workunit/workunit.routes.ts` | 新增接口 | `GET /api/v1/workunits/:id/tree-tokens` |
| AC-5.5 | `apps/api/src/modules/agents/token-usage.service.ts` | 实现 | aggregateTreeTokens |
| AC-5.6 | `apps/web/src/components/workunit/TreeTokenDrawer.tsx` | 新建 | 树状开销抽屉组件 |
| AC-5.6 | `apps/web/src/pages/WorkUnitDetail.tsx` | 修改 | 加抽屉 |
| AC-5.7 | `apps/web/src/components/workunit/DelegateCard.tsx` | 修改 | 卡片底部加"树开销 x/预算"行 |
| AC-5.8 | `apps/api/src/modules/workunit/__tests__/delegation-gate.test.ts` | 修改 | 新增预算超限用例 |
| AC-5.8 | `apps/api/src/modules/agents/__tests__/token-usage.service.test.ts` | 修改 | 新增 aggregateTreeTokens 用例 |

### 2.6 AC Group 6: 频道默认管线 + skill 降级

| AC | 文件路径 | 改动类型 | 改动内容 |
|----|---------|---------|---------|
| AC-6.1 | `packages/studio-shared/src/file-store.ts:ChannelData` | 修改 | 新增 `defaultPipeline?: string[]` 字段 |
| AC-6.2 | `apps/api/src/modules/channels/channel.routes.ts` | 修改 | POST/PATCH 支持 defaultPipeline，校验每项是 active AgentProfile name |
| AC-6.3 | `apps/api/src/modules/workunit/workunit.service.ts:create()` | 修改 | type='feature' + channel.defaultPipeline 存在 -> 创建链头子 WU（type=pipeline[0]） |
| AC-6.4 | `apps/api/src/modules/skills/skill-demotion.ts:DemotionProposalStore` | 新增方法 | `approve(id)` -> 写 SKILL.md frontmatter status=archived + 移动到 `_deprecated/`；`reject(id)` -> 标 rejected |
| AC-6.5 | `apps/api/src/modules/skills/skill.routes.ts` | 新增接口 | `POST /api/v1/skills/demotion-proposals/:id/approve` 和 `/reject` |
| AC-6.6 | `apps/api/src/modules/skills/__tests__/skill-demotion.test.ts` | 新增 | e2e 用例 |

### 2.7 AC Group 7: 清理

| AC | 文件路径 | 改动类型 |
|----|---------|---------|
| AC-7.1 | `packages/studio-shared/src/llm/model-gateway.ts` | 删除 |
| AC-7.2 | `packages/studio-shared/src/llm/provider-registry.ts` | 删除 |
| AC-7.3 | `packages/studio-shared/src/llm/model-router.ts` | 删除 |
| AC-7.4 | `packages/studio-shared/src/llm/usage-tracker.ts` | 删除 |
| AC-7.5 | `packages/studio-shared/src/llm/spawn-claude-cli.ts` | 删除 |
| AC-7.6 | `packages/studio-shared/src/llm/index.ts` | 修改：移除 modelGateway/buildSpawnEnv export |
| AC-7.6 | `packages/studio-shared/src/llm/__tests__/spawn-claude-cli.test.ts` | 删除 |
| AC-7.6 | `packages/studio-shared/src/llm/__tests__/model-router.test.ts` | 删除 |
| AC-7.8 | `apps/api/src/index.ts:69` | 删除 loadFromEnv 调用 |
| AC-7.9 | `apps/api/src/index.ts:71-83` | 删除 KNOWLEDGE_API_KEY 块 |
| AC-7.10 | `apps/api/src/modules/llm/config.service.ts` | 修改：移除 STUDIO_API_KEY 读取 |
| AC-7.11 | `apps/api/src/modules/llm/proxy.ts` | 删除 |
| AC-7.12 | `apps/api/src/modules/knowledge/internal.routes.ts:126` | 修改：移除 KNOWLEDGE_API_KEY |
| AC-7.13 | `packages/studio-shared/src/config/getProviderApiKey.ts` | 删除 |
| AC-7.13 | `packages/studio-shared/src/config/__tests__/getProviderApiKey.test.ts` | 删除 |
| AC-7.14 | `packages/studio-shared/src/config/index.ts` | 修改：移除 export |
| AC-7.15 | `~/.claude/settings-deepseek.json` | 修改：移除明文 key |
| AC-7.16 | `docs/plans/2026-07-agent-to-agent-collab-design.md §10.1` | 修改：更新双轨架构描述 |
| AC-7.17 | `apps/api/src/modules/agents/review-agent.service.ts` | 修改：4 处 buildSpawnEnv 移除，review() 方法重写或删除（reviewDiff 保留） |
| AC-7.18 | `packages/studio-agent/src/services/runner-params.ts` | 修改：移除 buildSpawnEnv |
| AC-7.18 | `packages/studio-agent/src/services/session-manager.ts` | 修改：移除 buildSpawnEnv |
| AC-7.19 | `pnpm test` + `pnpm run build` | 验证 |
| AC-7.20 | `CAPABILITIES.md` | 修改：移除 modelGateway 条目，新增 systemExecutor |

### 2.8 AC Group 8: RemoteExecutor

| AC | 文件路径 | 改动类型 |
|----|---------|---------|
| AC-8.1 | `apps/api/src/modules/agents/remote-executor.ts` | 新建 |
| AC-8.1 | `apps/api/src/modules/agents/__tests__/remote-executor.test.ts` | 新建 |
| AC-8.2 | `packages/studio-agent/src/types.ts:AgentTask` | 修改：加 nodeId? 字段 |
| AC-8.3 | `packages/studio-shared/src/file-store.ts:AgentProfileData` | 修改：加 nodeId? 字段 |
| AC-8.4 | `apps/api/src/modules/workspaces/ws-gateway.ts` | 修改：新增 agent-task 消息类型路由 |
| AC-8.4 | `apps/api/src/daemon/task-executor.ts` | 修改：新增 agent-task handler |
| AC-8.5 | `apps/api/src/daemon/task-executor.ts` | 实现：调 agentRunner.executeLightweight + 写 workunit:tokens |
| AC-8.6 | `apps/api/src/modules/agents/agent-loop.ts:constructor` | 修改：根据 profile.nodeId 选 Executor |
| AC-8.7 | `apps/api/src/modules/agents/monitor-agent.service.ts` | 修改：节点心跳超时 -> profile lastError='node offline' |
| AC-8.9 | `apps/api/src/modules/agents/__tests__/remote-executor.test.ts` | 实现 |

---

## 3. 接口定义

### 3.1 SystemExecutor

```typescript
// apps/api/src/modules/agents/system-executor.ts

export interface SystemExecutorOptions {
  /** 系统提示词（注入 CLI prompt 的 system 部分，通过 --append-system-prompt 或 stdin prefix） */
  systemPrompt?: string;
  /** 执行目录（review 等 worktree 场景需要） */
  cwd?: string;
  /** CLI --allowedTools 参数（如 "Read,Grep"） */
  allowedTools?: string;
  /** 超时（默认 30_000） */
  timeoutMs?: number;
  /** 输出缓冲（默认 5MB） */
  maxBuffer?: number;
}

export interface SystemExecutorResult {
  /** CLI stdout（纯文本或 JSON 字符串） */
  output: string;
  /** CLI --output-format json 返回的 usage；缺失时 undefined */
  usage?: {
    inputTokens: number;
    outputTokens: number;
  };
  /** 执行时长（ms） */
  durationMs: number;
}

export class StudioRoleNotConfiguredError extends Error {
  constructor() {
    super('studio role provider not configured; open UI to configure');
    this.name = 'StudioRoleNotConfiguredError';
  }
}

export class SystemExecutorJsonParseError extends Error {
  constructor(public readonly rawOutput: string, cause: unknown) {
    super(`systemExecutor JSON parse failed: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = 'SystemExecutorJsonParseError';
  }
}

export class SystemExecutor {
  constructor(private fileStore: FileStore) {}

  async run(prompt: string, options?: SystemExecutorOptions): Promise<SystemExecutorResult>;
  async runJson<T>(prompt: string, options?: SystemExecutorOptions): Promise<T>;
}

export const systemExecutor: SystemExecutor; // 单例，懒初始化
```

### 3.2 ensureStudioProfile

```typescript
// apps/api/src/modules/agents/agent-profile.service.ts

export async function ensureStudioProfile(fileStore: FileStore): Promise<AgentProfileData> {
  const existing = (await fileStore.listProfiles()).find(p => p.name === 'studio');
  if (existing) return existing;

  const now = new Date().toISOString();
  const data: AgentProfileData = {
    id: randomUUID(),
    name: 'studio',
    description: null,
    channels: '[]', // 空 channels
    provider: null, // 部署时由前端配置
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  await fileStore.createProfile(data);
  // 不发 agent-profile.created 事件，避免触发 mount
  return data;
}
```

### 3.3 ReviewDispatcher

```typescript
// apps/api/src/modules/agents/review-dispatcher.ts

export class ReviewDispatcher {
  constructor(
    private fileStore: FileStore,
    private workUnitService: WorkUnitService,
  ) {}

  /** 订阅 workunit.status_changed 事件。幂等。 */
  subscribeToEvents(): void;

  /** 检查频道是否有 reviewer 角色（profile.description 含 'reviewer' 或挂 code-review skill） */
  private async findReviewerInChannel(channelId: string): Promise<AgentProfileData | null>;

  /** 创建 review 子 WU（绕过 DelegationGate） */
  private async createReviewWorkUnit(parent: WorkUnitData, reviewer: AgentProfileData): Promise<WorkUnitData>;

  /** 子 WU done 时回调：解析 reviewer 输出 -> 父 WU reviewPassed/reviewRejected */
  private async onReviewComplete(childWu: WorkUnitData, parentWu: WorkUnitData): Promise<void>;
}

export const reviewDispatcher: ReviewDispatcher;
```

### 3.4 checkTreeBudget（重构后）

```typescript
// apps/api/src/modules/workunit/delegation-gate.ts

export const TREE_TOKEN_BUDGET = 400_000;

export function checkTreeBudget(
  rootId: string,
  fileStore: FileStore,
): { pass: boolean; reason?: string; treeTotal: number };
```

### 3.5 aggregateTreeTokens

```typescript
// apps/api/src/modules/agents/token-usage.service.ts

export interface TreeTokenReport {
  rootId: string;
  nodes: Array<{
    workUnitId: string;
    profileName: string | null;
    status: string;
    injectedTokens: number | null;
    executionTokens: number | null;
    totalTokens: number | null;
  }>;
  rootTotal: number;
  budgetRemaining: number;
}

export async function aggregateTreeTokens(rootId: string, fileStore: FileStore): Promise<TreeTokenReport>;
```

### 3.6 GET /api/v1/workunits/:id/tree-tokens

```
Response 200:
{
  "rootId": "wu_xxx",
  "nodes": [
    { "workUnitId": "wu_xxx", "profileName": "executor", "status": "in_review", "injectedTokens": 1500, "executionTokens": 12000, "totalTokens": 13500 },
    { "workUnitId": "wu_yyy", "profileName": "reviewer", "status": "active", "injectedTokens": 800, "executionTokens": 5000, "totalTokens": 5800 }
  ],
  "rootTotal": 19300,
  "budgetRemaining": 380700
}

Response 404: { "error": "WorkUnit not found" }
```

### 3.7 DemotionProposalStore 扩展

```typescript
// apps/api/src/modules/skills/skill-demotion.ts

export class DemotionProposalStore {
  // 已有：list, add, findPending

  /** 人审通过：写 SKILL.md frontmatter status=archived + 移动到 _deprecated/ */
  async approve(proposalId: string): Promise<DemotionProposal>;
  /** 人审拒绝：标 rejected */
  async reject(proposalId: string): Promise<DemotionProposal>;
}
```

### 3.8 RemoteExecutor

```typescript
// apps/api/src/modules/agents/remote-executor.ts

export class RemoteExecutor implements Executor {
  constructor(private nodeId: string) {}
  async execute(task: AgentTask): Promise<ExecutionResult>;
}

export class RemoteNodeUnreachableError extends Error {
  constructor(nodeId: string) {
    super(`remote node ${nodeId} unreachable`);
    this.name = 'RemoteNodeUnreachableError';
  }
}
```

### 3.9 daemon WebSocket 消息

```typescript
// ws-gateway.ts 扩展消息类型
type WsMessage =
  | { type: 'heartbeat'; nodeId: string; runtimes: RuntimeInfo[] }
  | { type: 'agent-task'; task: AgentTask }                          // server -> daemon
  | { type: 'agent-task-result'; executionId: string; result: ExecutionResult }; // daemon -> server
```

### 3.10 AgentProfileData 扩展

```typescript
// packages/studio-shared/src/file-store.ts

export interface AgentProfileData {
  id: string;
  name: string;
  description: string | null;
  channels: string; // JSON 串
  provider: string | null;
  status: string;
  nodeId?: string; // 新增，默认 'local'
  createdAt: string;
  updatedAt: string;
}
```

### 3.11 ChannelData 扩展

```typescript
export interface ChannelData {
  id: string;
  name: string;
  type: string;
  defaultWorkspaceId: string | null;
  defaultPath: string | null;
  discord: any;
  members: string; // JSON 串
  defaultPipeline?: string[]; // 新增，AgentProfile name 数组
  createdAt: string;
  updatedAt: string;
}
```

---

## 4. 代码依赖图

### 4.1 systemExecutor 依赖

```
system-executor.ts
  ├─ FileStore (读 studio 角色)
  ├─ resolveProviderDefinition (from @dommaker/studio-shared/node)
  ├─ buildArgsFromTemplate (from @dommaker/studio-shared/node)
  ├─ execSh (from @dommaker/studio-shared/node)
  └─ writeSystemTokenEvent (新增，类似 writeWorkunitTokenEvent)
       └─ studio-events.jsonl
```

### 4.2 ReviewDispatcher 依赖

```
review-dispatcher.ts
  ├─ eventBus.subscribe('workunit.status_changed')
  ├─ FileStore (读 channel, profiles)
  ├─ WorkUnitService.create / reviewPassed / reviewRejected
  └─ AgentLoop（通过 agentLoopRegistry，reviewer 角色 claim 子 WU）
       └─ skillLoader.load({ agentType: 'reviewer' }) -> code-review skill
```

### 4.3 调用链：WorkUnit in_review -> review 完成

```
WorkUnit.status -> in_review (由 agent COMPLETE 或子 WU 聚合触发)
  ↓ eventBus.publish('workunit.status_changed', { wu, newStatus: 'in_review' })
reviewDispatcher 监听
  ↓ findReviewerInChannel(wu.channelId) -> reviewer profile 或 null
有 reviewer
  ↓ createReviewWorkUnit(parent, reviewer) -> child WU (type='review', status='unassigned')
reviewer.agentLoop.observe() -> claim(child.id)
  ↓ agentStep: prompt 含父 WU git diff + code-review skill
reviewer COMPLETE -> child.status -> done
  ↓ eventBus.publish('workunit.status_changed', { wu: child, newStatus: 'done' })
reviewDispatcher 监听
  ↓ onReviewComplete(child, parent) -> 解析 child.metadata.reviewReport
  ↓ approved=true -> workUnitService.reviewPassed(parent.id)
  ↓ approved=false -> workUnitService.reviewRejected(parent.id, reason)
```

### 4.4 树聚合依赖

```
GET /api/v1/workunits/:id/tree-tokens
  ↓ workUnitService.getById(id) -> wu
  ↓ readCollab(wu.metadata) -> collab (rootId)
  ↓ aggregateTreeTokens(rootId, fileStore)
       ├─ fileStore.getIndex() -> 找出所有 rootId 子树 WU
       └─ 读 studio-events.jsonl 按 workUnitId 聚合 workunit:tokens 事件
```

---

## 5. 模块边界与约束

### 5.1 systemExecutor

- 只负责 spawn + 解析 + 写事件，不管业务逻辑
- 不消费 AgentLoop/WorkUnit（系统任务无 WU 状态机）
- 失败由调用方 catch（fire-and-forget 模式由调用方决定）
- 单例，懒初始化（首次调用时读 FileStore）

### 5.2 ReviewDispatcher

- 只创建子 WU，不直接 spawn CLI（spawn 由 reviewer.agentLoop 负责）
- 绕过 DelegationGate（系统代派不是 agent DELEGATE）
- 订阅事件幂等，多次调用 `subscribeToEvents()` 只订阅一次
- onReviewComplete 失败 -> log + 不阻塞子 WU 完成

### 5.3 树聚合

- 只读接口，不修改 studio-events.jsonl
- aggregateTreeTokens 复用 token-usage.service.ts 的读取逻辑
- 文件不存在 -> 返回零值报告（不抛错）

### 5.4 RemoteExecutor

- 接口与 LocalExecutor 一致（`execute(task): Promise<ExecutionResult>`）
- 节点离线 -> 30s 超时 -> 抛 RemoteNodeUnreachableError
- AgentLoop 捕获错误后按现有 `executeLightweight failed` 路径处理（need_input + consecutiveStuck）

---

## 6. 风险与缓解

| 风险 | 影响 | 缓解 | 对应 AC |
|------|------|------|---------|
| systemExecutor 和 modelGateway 过渡期并存 | 短期维护成本 | AC Group 3 分阶段迁移，每个调用点独立验证 | AC-3.1 ~ AC-3.7 |
| CLI 鉴权配置不在 studio 管控范围 | 用户配错 CLI key 时 studio 无法感知 | 启动时 health probe 验证 studio 角色 CLI 可用（已有 `buildHealthProbeCommand`） | AC-1.7 |
| reviewer 角色未创建时 review 不自动执行 | 用户体验 | 前端提醒（AC-2.4），不卡流程 | AC-4.2 |
| RemoteExecutor 跨节点通信复杂 | 实现 risk | P1 先做 LocalExecutor 验证（已完成），RemoteExecutor 独立 Phase 4 | AC-8.1 ~ AC-8.9 |
| 频道默认管线增加编排层复杂度 | 过度设计 risk | 按需启用，默认不配 pipeline | AC-6.3 |
| buildSpawnEnv 简化破坏 studio-agent 包 | agent-loop 执行链断 | AC-3.x 迁移完后 AC Group 7 删除前，runner-params.ts 和 session-manager.ts 同步迁移 | AC-1.11, AC-7.18 |
| ReviewDispatcher 绕过 DelegationGate 导致协作树失控 | review 子 WU 数量无限 | type='review' 类型的子 WU 不参与 DELEGATE 计数；每父 WU 最多 1 个未完结 review 子 WU（在 createReviewWorkUnit 内部校验） | AC-4.3 |
| 删除 LLMClient 误伤 | llm-client.ts 仍有消费者 | 本次只删 modelGateway，不删 llm-client | AC-7.6 |

---

## 7. 测试策略

### 7.1 单元测试

- 每个新模块（system-executor / review-dispatcher / remote-executor）单独测试文件
- 每个迁移点（AC-3.1 ~ AC-3.7）更新现有测试 mock

### 7.2 集成测试

- AC-4.8: ReviewDispatcher 完整链路（status_changed -> 创建子 WU -> reviewer claim -> complete -> 父 WU 状态变更）
- AC-6.6: skill 降级 e2e
- AC-8.9: RemoteExecutor 跨节点（用 mock daemon）

### 7.3 验证命令

```bash
cd /root/projects/studio
pnpm test
pnpm run build
npx tsc --noEmit

# AC-3.9
grep -r "modelGateway\.\(prompt\|promptJson\|chat\)" apps/api/src/ --include="*.ts" | grep -v __tests__ | grep -v dist
# AC-7.7
grep -r "STUDIO_API_KEY\|PIPELINE_API_KEY\|KNOWLEDGE_API_KEY" apps/ packages/ --include="*.ts" | grep -v __tests__ | grep -v dist
# AC-7.5
ls packages/studio-shared/src/llm/spawn-claude-cli.ts 2>&1 | grep -q "No such file" && echo "DELETED"
```

---

## 8. 实现伪代码

三个核心模块的 before/after 代码块。before=现状或接口签名，after=实现伪代码。伪代码用 TypeScript 风格，省略 import 和错误处理细节，聚焦核心逻辑。

### 8.1 systemExecutor（AC-1.6 ~ AC-1.10）

#### 8.1.1 run(prompt, options) 实现

**before**（design.md §3.1 接口签名）：
```typescript
async run(prompt: string, options?: SystemExecutorOptions): Promise<SystemExecutorResult>;
```

**after**（实现伪代码）：
```typescript
async run(prompt: string, options?: SystemExecutorOptions): Promise<SystemExecutorResult> {
  const opts = { timeoutMs: 30_000, maxBuffer: 5 * 1024 * 1024, ...options };
  const startMs = Date.now();

  // 1. 读 studio 角色 provider
  const profiles = await this.fileStore.listProfiles();
  const studioProfile = profiles.find(p => p.name === 'studio');
  if (!studioProfile || !studioProfile.provider) {
    throw new StudioRoleNotConfiguredError();
  }
  const providerId = studioProfile.provider;

  // 2. 构造 CLI args
  const def = resolveProviderDefinition(providerId);
  const { args, promptViaStdin } = buildArgsFromTemplate(def, {
    outputFormat: 'json',  // 强制 json 输出以解析 usage envelope
    prompt: promptViaStdin ? undefined : prompt,  // stdin 投递时不放 args
  });

  // 3. 组装 shell 命令（与 review-agent.service.ts:687 模式一致）
  const bin = def.binaries[0];
  const cmd = promptViaStdin
    ? `${bin} ${args.join(' ')}`
    : `${bin} ${args.join(' ')}`;

  // 4. 执行（env 继承 process.env，CLI 自己读鉴权配置）
  const { stdout } = await execSh(cmd, {
    cwd: opts.cwd,
    stdin: promptViaStdin ? (opts.systemPrompt ? `${opts.systemPrompt}\n\n${prompt}` : prompt) : undefined,
    env: {
      ...process.env,
      ...(opts.allowedTools ? { CLAUDE_ALLOWED_TOOLS: opts.allowedTools } : {}),
    },
    timeoutMs: opts.timeoutMs!,
    maxBuffer: opts.maxBuffer!,
  });

  // 5. 解析 JSON envelope.usage（CLI --output-format json 返回 { result, usage }）
  let usage: { inputTokens: number; outputTokens: number } | undefined;
  try {
    const envelope = JSON.parse(stdout);
    if (envelope.usage) {
      usage = {
        inputTokens: envelope.usage.input_tokens ?? 0,
        outputTokens: envelope.usage.output_tokens ?? 0,
      };
    }
  } catch { /* 非 JSON 输出，usage 保持 undefined */ }

  const result: SystemExecutorResult = {
    output: stdout,
    usage,
    durationMs: Date.now() - startMs,
  };

  // 6. 写 system:tokens 事件（await + catch：失败只 log，不影响 run 结果）
  try {
    await this.writeSystemTokenEvent({
      provider: providerId,
      usage,
      durationMs: result.durationMs,
      promptSignature: hashPrompt(prompt),
    });
  } catch (err) {
    logger.warn('[SystemExecutor] writeSystemTokenEvent failed', { error: String(err) });
  }

  return result;
}
```

#### 8.1.2 runJson<T>(prompt, options) 实现

**before**：
```typescript
async runJson<T>(prompt: string, options?: SystemExecutorOptions): Promise<T>;
```

**after**：
```typescript
async runJson<T>(prompt: string, options?: SystemExecutorOptions): Promise<T> {
  const result = await this.run(prompt, options);
  try {
    return JSON.parse(result.output) as T;
  } catch (err) {
    throw new SystemExecutorJsonParseError(result.output, err);
  }
}
```

#### 8.1.3 writeSystemTokenEvent 辅助函数

**before**：无（新增）。

**after**：
```typescript
// 与 agent-loop.ts:1239 writeWorkunitTokenEvent 同款 JSONL 风格
private async writeSystemTokenEvent(args: {
  provider: string;
  usage?: { inputTokens: number; outputTokens: number };
  durationMs: number;
  promptSignature: string;
}): Promise<void> {
  const eventsFile = path.join(os.homedir(), '.studio', 'logs', 'studio-events.jsonl');
  const metricsFs = new FileStore();
  await metricsFs.appendJsonl(eventsFile, {
    type: 'system:tokens',
    source: 'system-executor',
    payload: JSON.stringify({
      provider: args.provider,
      inputTokens: args.usage?.inputTokens ?? null,  // 缺失记 null 不编造
      outputTokens: args.usage?.outputTokens ?? null,
      durationMs: args.durationMs,
      promptSignature: args.promptSignature,
    }),
    createdAt: new Date().toISOString(),
  });
}

function hashPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 8);
}
```

#### 8.1.4 单例导出

**before**：无。

**after**：
```typescript
// 懒初始化（首次调用时读 FileStore，避免模块加载时 IO）
let _systemExecutor: SystemExecutor | null = null;
export function getSystemExecutor(): SystemExecutor {
  if (!_systemExecutor) _systemExecutor = new SystemExecutor(new FileStore());
  return _systemExecutor;
}

/** 测试用：重置单例 */
export function resetSystemExecutor(): void {
  _systemExecutor = null;
}
```

> 注：design.md 初稿用 Proxy 实现懒单例，实现时改为直接懒单例（避免 `as any` 绕过类型检查 + Proxy method `this` 绑定微妙问题 + YAGNI）。接口契约不变。

---

### 8.2 ReviewDispatcher（AC-4.1 ~ AC-4.5）

#### 8.2.1 subscribeToEvents() 实现

**before**（design.md §3.3 接口签名）：
```typescript
subscribeToEvents(): void;
```

**after**：
```typescript
private subscribed = false;

subscribeToEvents(): void {
  if (this.subscribed) return;
  this.subscribed = true;

  eventBus.subscribe('workunit.status_changed', async (payload: { workunit: WorkUnitData }) => {
    const wu = payload.workunit;
    // 路径 A：父 WU 进入 in_review -> 尝试创建 review 子 WU
    if (wu.status === 'in_review') {
      await this.handleParentInReview(wu).catch(err =>
        logger.warn('[ReviewDispatcher] handleParentInReview failed', { wuId: wu.id, error: String(err) })
      );
    }
    // 路径 B：子 WU（type='review'）完成 -> 处理父 WU review 结果
    if (wu.status === 'done' && wu.type === 'review' && wu.parentId) {
      await this.handleReviewChildDone(wu).catch(err =>
        logger.warn('[ReviewDispatcher] handleReviewChildDone failed', { childId: wu.id, error: String(err) })
      );
    }
  });
}
```

#### 8.2.2 findReviewerInChannel(channelId) 实现

**before**：
```typescript
private async findReviewerInChannel(channelId: string): Promise<AgentProfileData | null>;
```

**after**：
```typescript
private async findReviewerInChannel(channelId: string): Promise<AgentProfileData | null> {
  const channel = await this.fileStore.getChannel(channelId);
  if (!channel?.members) return null;
  const memberIds: string[] = JSON.parse(channel.members);
  if (memberIds.length === 0) return null;

  const allProfiles = await this.fileStore.listProfiles({ status: 'active' });
  const members = allProfiles.filter(p => memberIds.includes(p.id) && p.name !== 'studio');
  if (members.length === 0) return null;

  // reviewer 角色识别：description 含 'reviewer' 关键词
  // （与 skillLoader.load({ agentType: 'reviewer' }) 命中口径一致）
  const reviewer = members.find(p =>
    p.description?.toLowerCase().includes('reviewer')
  );
  return reviewer ?? null;
}
```

#### 8.2.3 handleParentInReview + createReviewWorkUnit 实现

**before**：
```typescript
private async createReviewWorkUnit(parent: WorkUnitData, reviewer: AgentProfileData): Promise<WorkUnitData>;
```

**after**：
```typescript
private async handleParentInReview(parent: WorkUnitData): Promise<void> {
  if (!parent.channelId) return;  // 无频道 -> 跳过
  const reviewer = await this.findReviewerInChannel(parent.channelId);
  if (!reviewer) return;  // 无 reviewer 角色 -> 前端提醒（AC-2.4），不卡流程

  // 同父唯一性校验：已有未完结 review 子 WU -> 跳过
  const snapshots = await this.fileStore.getIndex();
  const existingReview = snapshots.some(s =>
    s.parentId === parent.id
    && s.type === 'review'
    && s.status !== 'done'
    && s.status !== 'closed'
  );
  if (existingReview) return;

  await this.createReviewWorkUnit(parent, reviewer);
}

private async createReviewWorkUnit(parent: WorkUnitData, reviewer: AgentProfileData): Promise<WorkUnitData> {
  // 继承父 collab 元数据（绕过 DelegationGate，design.md D6）
  const parentMeta = parent.metadata ? JSON.parse(parent.metadata) as WorkUnitMetadata : {};
  const parentCollab = parentMeta.collab ?? {
    rootId: parent.id,
    depth: 0,
    chain: [],  // 父无 collab 时 chain 空
    delegationCount: 0,
  };

  const childMeta: WorkUnitMetadata = {
    ...parentMeta,
    collab: {
      rootId: parentCollab.rootId,
      depth: parentCollab.depth + 1,
      chain: [...parentCollab.chain, reviewer.id],
      delegatedBy: { profileId: parent.assigneeId ?? '', workUnitId: parent.id },
      delegationCount: 0,
    },
    // reviewer 输出报告的承载字段（onReviewComplete 读）
    reviewReport: undefined,
  };

  return await this.workUnitService.create({
    type: 'review',
    scope: `审查代码变更：${parent.scope?.slice(0, 200) ?? ''}`,
    assigneeId: reviewer.id,  // 指定 reviewer profile
    status: 'unassigned',     // 等 reviewer AgentLoop claim
    channelId: parent.channelId,
    parentId: parent.id,
    workspaceId: parent.workspaceId ?? null,
    reqId: (parentMeta as any).reqId ?? null,
    metadata: childMeta,
  });
}
```

#### 8.2.4 handleReviewChildDone + onReviewComplete 实现

**before**：
```typescript
private async onReviewComplete(childWu: WorkUnitData, parentWu: WorkUnitData): Promise<void>;
```

**after**：
```typescript
private async handleReviewChildDone(child: WorkUnitData): Promise<void> {
  const parent = await this.workUnitService.getById(child.parentId!);
  if (!parent) return;
  if (parent.status !== 'in_review') return;  // 父已被手动处理 -> 跳过

  const childMeta = child.metadata ? JSON.parse(child.metadata) as WorkUnitMetadata : {};
  const report = childMeta.reviewReport as
    | { approved: boolean; reason?: string; issues?: Array<{ severity: string; message: string }> }
    | undefined;

  if (!report) {
    // reviewer 输出格式异常 -> 默认拒绝（AC-4.5 边界）
    await this.workUnitService.reviewRejected(parent.id, 'reviewer 输出格式异常，无法解析审查结论');
    return;
  }

  if (report.approved) {
    await this.workUnitService.reviewPassed(parent.id);
  } else {
    const reason = report.reason
      ?? report.issues?.filter(i => i.severity === 'error').map(i => i.message).join('; ')
      ?? 'reviewer 拒绝';
    await this.workUnitService.reviewRejected(parent.id, reason);
  }
}
```

#### 8.2.5 AgentLoop 配合：reviewer claim 子 WU 后注入父 diff

**before**（agent-loop.ts:514-536 现有 AgentTask 构造）：
```typescript
const task: AgentTask = {
  id: wu.id,
  executionId: `${wu.id}-${Date.now()}`,
  provider: (this.role.provider || 'claude') as AgentTask['provider'],
  prompt,
  parameters: { /* ... */ },
  model: 'standard',
  timeoutMs: 120_000,
};
```

**after**（reviewer 角色额外注入父 WU diff context）：
```typescript
// reviewer 角色 claim type='review' 子 WU 时，prompt 追加父 WU git diff
let reviewContext = '';
if (this.role.description?.toLowerCase().includes('reviewer') && wu.type === 'review' && wu.parentId) {
  const parent = await this.workUnitService.getById(wu.parentId);
  if (parent?.workspaceId) {
    const workspaceRoot = await this.resolveBoundWorkspaceRoot(parent.workspaceId);
    if (workspaceRoot) {
      try {
        const { stdout: diffStat } = await execSh(
          `git diff HEAD~1 --stat 2>/dev/null || git diff --stat 2>/dev/null`,
          { cwd: workspaceRoot, timeoutMs: 10_000, maxBuffer: 1024 * 1024 },
        );
        const { stdout: diffContent } = await execSh(
          `git diff HEAD~1 2>/dev/null || git diff 2>/dev/null`,
          { cwd: workspaceRoot, timeoutMs: 10_000, maxBuffer: 5 * 1024 * 1024 },
        );
        reviewContext = `\n## 父任务变更范围\n\`\`\`\n${diffStat.trim()}\n\`\`\`\n\`\`\`diff\n${diffContent.slice(0, 30000)}\n\`\`\``;
      } catch { /* best-effort */ }
    }
  }
}

const task: AgentTask = {
  // ... 现有字段
  prompt: prompt + reviewContext,
  // ...
};
```

#### 8.2.6 AgentLoop 配合：reviewer complete 时写 metadata.reviewReport

**before**（agent-loop.ts:794-815 recordResult 现有逻辑）：
```typescript
// action='complete' -> transitionStatus(wuId, 'in_review') 或 done
```

**after**（reviewer 角色 complete 时额外写 reviewReport 到 metadata）：
```typescript
// 在 recordResult 内 action='complete' 分支：
if (action === 'complete' && this.role.description?.toLowerCase().includes('reviewer') && wu.type === 'review') {
  // 解析 reviewer 输出提取 approved/issues（与 review-agent.service.ts:224-250 解析 .review-report.json 模式一致）
  const report = parseReviewReport(stepResult.summary);
  metadataUpdates.reviewReport = report;
}
```

---

### 8.3 RemoteExecutor（AC-8.1 ~ AC-8.5）

#### 8.3.1 execute(task) 实现

**before**（design.md §3.8 接口签名）：
```typescript
export class RemoteExecutor implements Executor {
  constructor(private nodeId: string) {}
  async execute(task: AgentTask): Promise<ExecutionResult>;
}
```

**after**：
```typescript
export class RemoteExecutor implements Executor {
  constructor(private nodeId: string) {}

  async execute(task: AgentTask): Promise<ExecutionResult> {
    // 1. 找到节点对应的 ws-gateway 连接
    const conn = activeConnections.get(this.nodeId);
    if (!conn || conn.ws.readyState !== WebSocket.OPEN) {
      throw new RemoteNodeUnreachableError(this.nodeId);
    }

    // 2. 生成 executionId + 准备 pending promise
    const executionId = task.executionId ?? `${task.id}-${Date.now()}`;
    const pending = new Promise<ExecutionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingExecutions.delete(executionId);
        reject(new RemoteNodeUnreachableError(this.nodeId));
      }, 30_000);  // 30s 超时

      pendingExecutions.set(executionId, { resolve, reject, timer });
    });

    // 3. 发送 agent-task 消息到远程节点
    conn.ws.send(JSON.stringify({
      type: 'agent-task',
      task: { ...task, executionId },
    }));

    // 4. 等待 agent-task-result 回包（由 ws-gateway handleMessage 路由）
    return pending;
  }
}

// 模块级 pending map（与 ws-gateway pendingDiscovers 同款模式）
const pendingExecutions = new Map<string, {
  resolve: (r: ExecutionResult) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
```

#### 8.3.2 ws-gateway 扩展：路由 agent-task-result

**before**（ws-gateway.ts:154-188 handleMessage）：
```typescript
function handleMessage(entry: ConnectionEntry, raw: string): void {
  const msg = JSON.parse(raw);
  switch (msg.type) {
    case 'pong': /* ... */ break;
    case 'discover_response': /* ... */ break;
    default: logger.warn('Unknown message type');
  }
}
```

**after**（新增 agent-task-result 分支）：
```typescript
function handleMessage(entry: ConnectionEntry, raw: string): void {
  const msg = JSON.parse(raw);
  switch (msg.type) {
    case 'pong': /* ... */ break;
    case 'discover_response': /* ... */ break;

    case 'agent-task-result': {
      // daemon 回传的执行结果 -> resolve 对应 pending promise
      const pending = pendingExecutions.get(msg.executionId);
      if (!pending) break;  // 已超时或不存在
      clearTimeout(pending.timer);
      pendingExecutions.delete(msg.executionId);
      if (msg.error) {
        pending.reject(new Error(msg.error));
      } else {
        pending.resolve(msg.result as ExecutionResult);
      }
      break;
    }

    default: logger.warn('Unknown message type');
  }
}
```

#### 8.3.3 daemon 端 task-executor 扩展：接收 agent-task

**before**（task-executor.ts:62 现有 execute(task: ClaimedTask)）：
```typescript
async execute(task: ClaimedTask): Promise<void> {
  // 现有：spawn CLI + 解析 stream-json + POST 回 server
}
```

**after**（新增 onAgentTask handler 用于 ws-gateway 接收）：
```typescript
// daemon 侧 ws 客户端注册的 message handler
async function onAgentTask(ws: WebSocket, msg: { type: 'agent-task'; task: AgentTask }): Promise<void> {
  const { task } = msg;
  const executionId = task.executionId!;
  try {
    // 复用 agentRunner.executeLightweight（与 LocalExecutor 同款执行路径）
    const result: ExecutionResult = await agentRunner.executeLightweight(task);

    // 写 workunit:tokens 到节点本地 studio-events.jsonl（与 agent-loop.ts:549 同款）
    const executionTokens = result.usage && (result.usage.inputTokens + result.usage.outputTokens) > 0
      ? result.usage.inputTokens + result.usage.outputTokens
      : null;
    void writeWorkunitTokenEvent(STUDIO_EVENTS_JSONL, {
      workUnitId: task.id,
      executionId,
      injectedTokens: 0,  // 远程执行无注入上下文
      executionTokens,
    }).catch(() => {});

    // 回传结果
    ws.send(JSON.stringify({
      type: 'agent-task-result',
      executionId,
      result,
    }));
  } catch (err) {
    ws.send(JSON.stringify({
      type: 'agent-task-result',
      executionId,
      error: err instanceof Error ? err.message : String(err),
    }));
  }
}
```

#### 8.3.4 AgentLoop constructor 根据 nodeId 选 Executor

**before**（agent-loop.ts:96-106 现有 constructor）：
```typescript
constructor(role: AgentProfileData, fileStore?: FileStore) {
  // ...
  // §9.6: 执行面走 Executor 接口。TODO(§9.6 P1): profile.nodeId === 'local' ->
  // LocalExecutor，否则 RemoteExecutor(nodeId)；profile 尚无 nodeId 字段，目前恒为 LocalExecutor。
  this.executor = new LocalExecutor();
}
```

**after**：
```typescript
constructor(role: AgentProfileData, fileStore?: FileStore) {
  // ...
  // §9.6 P1: profile.nodeId 决定本地/远程执行
  const nodeId = role.nodeId ?? 'local';
  this.executor = nodeId === 'local'
    ? new LocalExecutor()
    : new RemoteExecutor(nodeId);
}
```

#### 8.3.5 ws-gateway ClientMessage 类型扩展

**before**（ws-gateway.ts:20-23）：
```typescript
type ClientMessage =
  | { type: 'auth'; workspaceId: string; token: string }
  | { type: 'pong' }
  | { type: 'discover_response'; requestId: string; entries: DiscoverEntry[]; error?: string };
```

**after**：
```typescript
type ClientMessage =
  | { type: 'auth'; workspaceId: string; token: string }
  | { type: 'pong' }
  | { type: 'discover_response'; requestId: string; entries: DiscoverEntry[]; error?: string }
  | { type: 'agent-task-result'; executionId: string; result?: ExecutionResult; error?: string };
```

#### 8.3.6 ServerMessage 类型扩展（server -> daemon）

**before**：`ping` / `auth_ok` / `auth_error` / `discover`（隐式）。

**after**：新增 `agent-task`：
```typescript
type ServerMessage =
  | { type: 'ping' }
  | { type: 'auth_ok'; workspaceId: string }
  | { type: 'auth_error'; error: string }
  | { type: 'discover'; requestId: string; path: string }
  | { type: 'agent-task'; task: AgentTask };
```

---

### 8.4 树聚合（AC-5.1, AC-5.5）

#### 8.4.1 checkTreeBudget(rootId, fileStore) 实现

**before**（delegation-gate.ts:84-86 留桩）：
```typescript
export function checkTreeBudget(): { pass: boolean; reason?: string } {
  return { pass: true };
}
```

**after**（重构签名 + 实现）：
```typescript
export const TREE_TOKEN_BUDGET = 400_000;

export async function checkTreeBudget(
  rootId: string,
  fileStore: FileStore,
): Promise<{ pass: boolean; reason?: string; treeTotal: number }> {
  // 1. 找出 rootId 子树所有 WU id（含根）
  const snapshots = await fileStore.getIndex();
  const treeWuIds = new Set<string>([rootId]);
  for (const s of snapshots) {
    const collab = readCollab(s.metadata);
    if (collab?.rootId === rootId) treeWuIds.add(s.id);
  }

  // 2. 读 studio-events.jsonl 聚合 executionTokens
  const eventsFile = path.join(os.homedir(), '.studio', 'logs', 'studio-events.jsonl');
  let treeTotal = 0;
  try {
    const events = await fileStore.readJsonl<{ type: string; payload: string }>(eventsFile);
    for (const evt of events) {
      if (evt.type !== 'workunit:tokens') continue;
      try {
        const payload = JSON.parse(evt.payload) as { workUnitId: string; executionTokens: number | null };
        if (!treeWuIds.has(payload.workUnitId)) continue;
        if (typeof payload.executionTokens === 'number') {
          treeTotal += payload.executionTokens;
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* 文件不存在 -> treeTotal=0，pass */ }

  // 3. 校验（子 WU 预估取 0，TODO 后续基于历史均值）
  if (treeTotal > TREE_TOKEN_BUDGET) {
    return {
      pass: false,
      reason: `协作树预算超限（已耗 ${treeTotal} / 上限 ${TREE_TOKEN_BUDGET}）`,
      treeTotal,
    };
  }
  return { pass: true, treeTotal };
}
```

#### 8.4.2 checkDelegation 第 8 步调用更新

**before**（delegation-gate.ts:154-158）：
```typescript
// 8. 预算（P1 留桩）
const budget = checkTreeBudget();
if (!budget.pass) {
  return { pass: false, reason: budget.reason ?? '协作树预算超限' };
}
```

**after**：
```typescript
// 8. 预算：按 rootId 聚合 studio-events.jsonl 的 executionTokens
const budget = await checkTreeBudget(parentCollab.rootId, fileStore);
if (!budget.pass) {
  return { pass: false, reason: budget.reason ?? '协作树预算超限' };
}
```

#### 8.4.3 aggregateTreeTokens(rootId, fileStore) 实现

**before**（无，新增方法）。

**after**：
```typescript
export interface TreeTokenReport {
  rootId: string;
  nodes: Array<{
    workUnitId: string;
    profileName: string | null;
    status: string;
    injectedTokens: number | null;
    executionTokens: number | null;
    totalTokens: number | null;
  }>;
  rootTotal: number;
  budgetRemaining: number;
}

export async function aggregateTreeTokens(
  rootId: string,
  fileStore: FileStore,
): Promise<TreeTokenReport> {
  // 1. 找出子树 WU + 建立 workUnitId -> snapshot 映射
  const snapshots = await fileStore.getIndex();
  const treeNodes = new Map<string, WorkUnitSnapshot>();
  const root = snapshots.find(s => s.id === rootId);
  if (root) treeNodes.set(rootId, root);
  for (const s of snapshots) {
    const collab = readCollab(s.metadata);
    if (collab?.rootId === rootId) treeNodes.set(s.id, s);
  }

  // 2. 读 events 聚合每 WU 的 tokens（与 checkTreeBudget 同款读取，可提取共享 helper）
  const eventsFile = path.join(os.homedir(), '.studio', 'logs', 'studio-events.jsonl');
  const perWuTokens = new Map<string, { injected: number; execution: number }>();
  try {
    const events = await fileStore.readJsonl<{ type: string; payload: string }>(eventsFile);
    for (const evt of events) {
      if (evt.type !== 'workunit:tokens') continue;
      try {
        const p = JSON.parse(evt.payload) as {
          workUnitId: string;
          injectedTokens: number;
          executionTokens: number | null;
        };
        if (!treeNodes.has(p.workUnitId)) continue;
        const prev = perWuTokens.get(p.workUnitId) ?? { injected: 0, execution: 0 };
        prev.injected += p.injectedTokens ?? 0;
        if (typeof p.executionTokens === 'number') prev.execution += p.executionTokens;
        perWuTokens.set(p.workUnitId, prev);
      } catch { /* skip */ }
    }
  } catch { /* 文件不存在 -> 全零 */ }

  // 3. 读 profiles 拿 name（assigneeId 是 instance id，需经 state.roleId 反查 profile）
  const allStates = await fileStore.listStates();
  const allProfiles = await fileStore.listProfiles();
  const instanceToProfile = new Map<string, string>();
  for (const st of allStates) instanceToProfile.set(st.id, st.roleId);
  const profileNameById = new Map<string, string>();
  for (const p of allProfiles) profileNameById.set(p.id, p.name);

  // 4. 组装 nodes（含无 token 事件的 WU，tokens=null）
  const nodes: TreeTokenReport['nodes'] = [];
  let rootTotal = 0;
  for (const [wuId, snap] of treeNodes) {
    const tokens = perWuTokens.get(wuId);
    const profileId = snap.assigneeId ? instanceToProfile.get(snap.assigneeId) : undefined;
    const profileName = profileId ? profileNameById.get(profileId) ?? null : null;
    const injected = tokens?.injected ?? null;
    const execution = tokens?.execution ?? null;
    const total = tokens ? tokens.injected + tokens.execution : null;
    nodes.push({
      workUnitId: wuId,
      profileName,
      status: snap.status,
      injectedTokens: injected,
      executionTokens: execution,
      totalTokens: total,
    });
    if (typeof execution === 'number') rootTotal += execution;
  }

  return {
    rootId,
    nodes,
    rootTotal,
    budgetRemaining: TREE_TOKEN_BUDGET - rootTotal,
  };
}
```

#### 8.4.4 GET /api/v1/workunits/:id/tree-tokens 接口实现

**before**（无，新增接口）。

**after**：
```typescript
router.get('/:id/tree-tokens', async (req: Request, res: Response) => {
  const wu = await service.getById(req.params.id);
  if (!wu) return res.status(404).json({ error: 'WorkUnit not found' });

  // 解析 rootId：有 collab 用 collab.rootId，否则自身为根
  const meta = wu.metadata ? JSON.parse(wu.metadata) : {};
  const rootId = meta.collab?.rootId ?? wu.id;

  const report = await aggregateTreeTokens(rootId, fileStore);
  res.json(report);
});
```

---

### 8.5 关键参考映射

| 伪代码节 | 参考源码 | 复用模式 |
|---------|---------|---------|
| §8.1.1 systemExecutor.run | `agent-loop.ts:540-554` executor.execute + `review-agent.service.ts:687` execSh + `providers.ts:297` buildArgsFromTemplate | CLI spawn + usage 解析 |
| §8.1.3 writeSystemTokenEvent | `agent-loop.ts:1239` writeWorkunitTokenEvent | JSONL append + payload JSON.stringify |
| §8.2.1 subscribeToEvents | `agent-loop-registry.ts:82-107` subscribeToEvents | eventBus.subscribe 幂等模式 |
| §8.2.2 findReviewerInChannel | `agent-loop-registry.ts` + `message-routing.ts:77-126` | profile + channel.members 过滤 |
| §8.2.3 createReviewWorkUnit | `workunit.service.ts:221` create + `delegation-gate.ts:52` effectiveParentCollab | collab 元数据继承 |
| §8.2.4 handleReviewChildDone | `workunit.service.ts:643` reviewPassed / `:688` reviewRejected | 直接调服务方法 |
| §8.2.5 reviewer 注入 diff | `review-agent.service.ts:99-113` git diff 获取 | execSh + cwd=workspaceRoot |
| §8.2.6 reviewReport 解析 | `review-agent.service.ts:224-250` .review-report.json 解析 | JSON.parse + 字段映射 |
| §8.3.1 RemoteExecutor.execute | `ws-gateway.ts:172-183` pendingDiscovers 模式 | pending Map + 超时 timer |
| §8.3.2 handleMessage 扩展 | `ws-gateway.ts:154-188` 现有 switch | 新增 case 分支 |
| §8.3.3 daemon onAgentTask | `task-executor.ts:62` execute + `agent-loop.ts:549` writeWorkunitTokenEvent | agentRunner.executeLightweight + token 事件 |
| §8.3.4 AgentLoop constructor | `agent-loop.ts:96-106` 现有 | 加 nodeId 判断 |
| §8.4.1 checkTreeBudget | `token-usage.service.ts:150` readJsonl + `delegation-gate.ts:36` readCollab + `agent-loop.ts:1243` appendJsonl 写入端 | JSONL 聚合 + collab 解析 |
| §8.4.2 checkDelegation 第 8 步 | `delegation-gate.ts:154-158` 现有留桩 | 改 sync -> await |
| §8.4.3 aggregateTreeTokens | `token-usage.service.ts` 现有读取模式 + `agent-loop-registry.ts:103-105` instance->profile 映射 | 同款 readJsonl + 反向归因 |
| §8.4.4 tree-tokens 接口 | `workunit.routes.ts:223` review-passed 现有路由模式 | getById + 404 + JSON 响应 |
