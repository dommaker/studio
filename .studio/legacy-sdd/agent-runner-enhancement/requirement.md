---
slug: agent-runner-enhancement
title: Agent Runner 增强 — 知识注入 + Provider 适配 + Skill 加载
status: draft
createdAt: "2026-07-13"
---

# Agent Runner 增强 — 知识注入 + Provider 适配 + Skill 加载

来源：agent-network-gaps-analysis.md GAP-4a + GAP-5 + GAP-7

## AC Groups

### GAP-5：知识注入（agent-runner 侧）

executeLightweight 路径补 knowledgeContext 注入。调用方是 agent-loop（调 `injectContext` 后传入 `task.parameters.knowledgeContext`），agent-runner 只负责读取并拼入 prompt。

#### 验收标准

- **AC-5a.1** `executeLightweight` 从 `task.parameters.knowledgeContext` 读取知识上下文
- **AC-5a.2** `knowledgeContext` 非空时拼入 prompt 头部（`knowledgeContext + '\n\n---\n\n' + task.prompt`）
- **AC-5a.3** `knowledgeContext` 为空时不影响执行，prompt 原样传递

#### Files

| 文件 | 改动 |
|------|------|
| `packages/studio-agent/src/services/agent-runner.ts` | `executeLightweight` 路径加 knowledgeContext 注入 |

#### 边界情况

- `task.parameters` 为 undefined → 安全读取（`task.parameters?.knowledgeContext`）
- `knowledgeContext` 为纯空白字符串 → 按空字符串处理，不注入
- 多段 knowledgeContext 拼接格式：单 `---` 分隔，与系统 prompt 风格一致

#### 不做

- 不在 agent-runner 侧调 `injectContext`（该职责在 agent-loop，见 GAP-5b）
- 不修改 `execute()` 路径（已支持 knowledgeContext）

---

### GAP-7：Skill 加载去 agentType

`skillLoader.load()` 移除 `agentType` 参数，让 `agentTypes: []` 的 skill 对所有 Agent 可见。

#### 验收标准

- **AC-7.1** `skillLoader.load` 不传 `agentType` 参数
- **AC-7.2** Tier 过滤生效：fast 任务不加载 premium 的 skill
- **AC-7.3** `agentTypes: []` 的 skill 对所有 Agent 可见

#### Files

| 文件 | 改动 |
|------|------|
| `packages/studio-agent/src/services/agent-runner.ts` | L1113：`skillLoader.load({ agentType: 'executor', tier: skillTier })` → `skillLoader.load({ tier: skillTier })` |

#### 边界情况

- `tier` 为空时视为 `'standard'`（skillLoader 内部默认行为）
- 仍保留 skillTypes 过滤（若存在）
- agentType 过滤逻辑（skillLoader L116）在调用侧不传 agentType 时自然跳过

#### 不做

- 不修改 skillLoader.load 接口签名，只移除调用侧 agentType 参数
- 不修改 Tier 过滤逻辑

---

### GAP-4a：cli-adapter 迁移 + Provider 抽象

cli-adapter 从 apps/api 层迁入 packages 层，agent-runner 两处硬编码 `claude` 改为通过 cli-adapter 构造 spawn 参数。AgentTask.agentType 重命名为 provider，类型扩展为 4 种。

#### 验收标准

- **AC-4a.1** cli-adapter 迁移至 `packages/studio-agent/src/cli-adapter.ts`，保持纯函数（去 daemon 特有文件读取）
- **AC-4a.2** agent-runner 两处（execute 路径 L408 + executeLightweight 路径 L812）改为通过 `buildSpawnArgs(provider, params)` 构造 spawn 参数
- **AC-4a.3** `AgentTask.agentType` → `provider`（重命名），类型从 2 种扩展为 4 种：`'claude' | 'codex' | 'opencode' | 'openclaw'`
- **AC-4a.4** agent-loop 传 `sessionId` + `provider` + `maxTurns` + `knowledgeContext`，不再传 `sessionFlags`
- **AC-4a.5** claude/codex/openclaw session 通过原生 CLI flag 持久化
- **AC-4a.6** opencode session 通过文件上下文注入持久化

#### Files

| 文件 | 改动 |
|------|------|
| `apps/api/src/daemon/cli-adapter.ts` | 迁移（删除） |
| `packages/studio-agent/src/cli-adapter.ts` | 迁入 + 提纯（去 daemon 特有读取） |
| `packages/studio-agent/src/services/agent-runner.ts` | L408 + L812 两处改为 buildSpawnArgs 调用 |
| `packages/studio-agent/src/index.ts` | 新增 cli-adapter 导出 |
| `packages/studio-agent/src/services/session-manager.ts` | AgentTask 接口变更（agentType→provider, parameters 增减） |

#### 边界情况

- `provider` 为未知值 → 回退到 `'claude'`（默认 Provider，向下兼容）
- `sessionId` 为 undefined → 新 session（不传 resume flag）
- `maxTurns` 为 undefined → 不传 `--max-turns`（使用 CLI 默认值）
- opencode session 文件不存在 → 按新 session 处理（空 context）
- cli-adapter 移动后 daemon 侧 import 需同步更新

#### 不做

- 不实现 `opencode` Provider 的具体注入逻辑（仅定义接口和 session 策略）
- 不修改其他已存在的 AgentTask 消费方（仅改类型定义）
- 不改变 spawn 执行流程本身（exec/spawn 方式不变）

---

### 关联：GAP-5b（agent-loop 侧，记录于此）

以下 AC 在 agent-loop 侧实现（spec: agent-loop-enhancement.md），agent-runner 只消费其结果。

| # | 验收标准 |
|---|---------|
| AC-5b.1 | agent-loop 构建 AgentTask 前调 `knowledgeService.injectContext(taskScope)` |
| AC-5b.2 | taskScope 从 `WorkUnit.type + WorkUnit.title` 推导 |
| AC-5b.3 | injectContext 返回值写入 `task.parameters.knowledgeContext` |
| AC-5b.4 | injectContext 失败时不阻断执行（catch → 空字符串） |
