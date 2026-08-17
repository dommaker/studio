---
slug: agent-runner-enhancement
title: Agent Runner 增强 — 知识注入 + Provider 适配 + Skill 加载
status: draft
createdAt: "2026-07-13"
---

# Task: Agent Runner 增强

## 实现步骤

### Step 1: AgentTask 接口变更（session-manager.ts）

**文件**: `packages/studio-agent/src/services/session-manager.ts`

**改动**:
- `agentType: 'codex' | 'claude'` → `provider: 'claude' | 'codex' | 'opencode' | 'openclaw'`
- `parameters?: Record<string, unknown>` → `parameters?: { sessionId?: string; maxTurns?: number; knowledgeContext?: string; agentRole?: string; [key: string]: unknown }`

**完成标准**:
- 编译通过，无类型错误
- 所有引用 `task.agentType` 的代码报类型错误（待后续步骤修复）

**涉及**：AC-4a.3

---

### Step 2: cli-adapter 迁移 + 提纯

**文件**:
- `apps/api/src/daemon/cli-adapter.ts` (读取，迁移)
- `packages/studio-agent/src/cli-adapter.ts` (新建)

**改动**:
1. 复制 `cli-adapter.ts` 到 `packages/studio-agent/src/cli-adapter.ts`
2. 移除 daemon 特有文件读取（session-id file、pid file 相关代码）
3. 保持 `buildSpawnArgs(provider, params)` 纯函数签名
4. 更新 import 路径（原 daemon 内引用 → packages 引用）

**buildSpawnArgs 新增逻辑**:

```typescript
export function buildSpawnArgs(
  provider: Provider,
  params: SpawnParams,
): SpawnArgs {
  switch (provider) {
    case 'claude':
      return buildClaudeArgs(params);
    case 'codex':
      return buildCodexArgs(params);
    case 'openclaw':
      return buildOpenclawArgs(params);
    case 'opencode':
      return buildOpencodeArgs(params);
  }
}
```

各 Provider 的 args 构造：

| Provider | command | args |
|----------|---------|------|
| claude | `'claude'` | `['--print', '--output-format', 'stream-json', ...(sessionId ? ['--session-id', sessionId] : []), ...(maxTurns ? ['--max-turns', String(maxTurns)] : [])]` |
| codex | `'codex'` | `['--print', '--output-format', 'stream-json', ...(sessionId ? ['--session', sessionId] : [])]` |
| openclaw | `'openclaw'` | `['--print', '--output-format', 'stream-json', ...(sessionId ? ['--session', sessionId] : [])]` |
| opencode | `'opencode'` | `['--print', '--output-format', 'stream-json']` (session 通过文件上下文注入) |

**完成标准**:
- `packages/studio-agent/src/cli-adapter.ts` 存在且为纯函数（无文件系统副作用）
- `buildSpawnArgs` 返回正确的 command + args
- 所有 4 个 Provider 的 args 生成正确
- 编译通过

**涉及**：AC-4a.1, AC-4a.5, AC-4a.6

---

### Step 3: cli-adapter 导出

**文件**: `packages/studio-agent/src/index.ts`

**改动**:
- 新增 `export * from './cli-adapter'` (或具名导出)

**完成标准**:
- `packages/studio-agent` 可外部 import `buildSpawnArgs`
- 编译通过

**涉及**：AC-4a.1

---

### Step 4: agent-runner 集成 cli-adapter（两处）

**文件**: `packages/studio-agent/src/services/agent-runner.ts`

**改动**:
- L408（execute 路径）：硬编码 shell 命令 → `buildSpawnArgs(provider, spawnParams)`
- L812（executeLightweight 路径）：硬编码 shell 命令 → `buildSpawnArgs(provider, spawnParams)`
- 两处均从 `task.provider` 读取 provider 值
- spawnParams 从 `task.parameters` 提取 `sessionId`、`maxTurns`、`worktreeDir`

**完成标准**:
- 两处 spawn 参数构造通过 cli-adapter 生成
- execute 和 executeLightweight 路径均正常工作
- `task.agentType` 引用更新为 `task.provider`
- 编译通过

**涉及**：AC-4a.2, AC-4a.4

---

### Step 5: knowledgeContext 注入（executeLightweight）

**文件**: `packages/studio-agent/src/services/agent-runner.ts`

**改动**:
- executeLightweight 中，prompt 构造前加：

```typescript
const knowledgeContext = (task.parameters?.knowledgeContext as string) || '';
const augmentedPrompt = knowledgeContext
  ? knowledgeContext + '\n\n---\n\n' + task.prompt
  : task.prompt;
```

- prompt 相关逻辑使用 `augmentedPrompt` 替代 `task.prompt`

**完成标准**:
- `task.parameters.knowledgeContext` 非空时 prompt 头部拼接知识上下文
- `task.parameters.knowledgeContext` 为空/undefined 时 prompt 不变
- `task.parameters` 为 undefined 时无异常（`?.` 安全访问）
- 编译通过

**涉及**：AC-5a.1, AC-5a.2, AC-5a.3

---

### Step 6: skillLoader.load 去 agentType

**文件**: `packages/studio-agent/src/services/agent-runner.ts`

**改动**:
- L1113：`skillLoader.load({ agentType: 'executor', tier: skillTier })` → `skillLoader.load({ tier: skillTier })`

**完成标准**:
- skillLoader.load 调用不传 agentType
- Tier 过滤仍然生效
- 编译通过

**涉及**：AC-7.1, AC-7.2, AC-7.3

---

### Step 7: 更新 agent-loop 侧 AgentTask 构造

**文件**: `apps/api/src/daemon/claim-loop.ts` (或 agent-loop 所在文件)

**改动**:
- `agentType` → `provider`
- `parameters.sessionFlags` → `parameters.sessionId` + `parameters.maxTurns` + `parameters.knowledgeContext`
- 删除 `sessionFlags` 构造逻辑
- 新增 `sessionId`、`maxTurns` 传递

**完成标准**:
- AgentTask 构造使用新接口
- daemon 侧编译通过
- 不再引用 `sessionFlags`

**涉及**：AC-4a.4

---

### Step 8: 更新 daemon 侧 cli-adapter import

**文件**: `apps/api/src/daemon/` 中原引用 `cli-adapter.ts` 的文件

**改动**:
- import 路径从 `'./cli-adapter'` 改为 `'@dommaker/studio-agent'` (或对应包名)

**完成标准**:
- daemon 侧不再直接引用 `apps/api/src/daemon/cli-adapter.ts`
- 编译通过

**涉及**：AC-4a.1

---

### Step 9: 删除旧 cli-adapter

**文件**: `apps/api/src/daemon/cli-adapter.ts`

**改动**:
- 删除文件

**完成标准**:
- `apps/api/src/daemon/cli-adapter.ts` 不存在
- 全仓库编译通过
- 无 dangling import

**涉及**：AC-4a.1

---

### Step 10: 新增/更新测试

**测试文件**:

| 测试文件 | 测试内容 | 预估行数 |
|---------|---------|---------|
| `packages/studio-agent/src/__tests__/cli-adapter.test.ts` | buildSpawnArgs 4 种 Provider args 生成 | ~80 |
| `packages/studio-agent/src/__tests__/cli-adapter.test.ts` | sessionId/maxTurns 参数 | ~40 |
| `packages/studio-agent/src/__tests__/cli-adapter.test.ts` | opencode session 文件上下文注入 | ~30 |
| `packages/studio-agent/src/services/__tests__/agent-runner.test.ts` | executeLightweight knowledgeContext 注入 | ~40 |
| `packages/studio-agent/src/services/__tests__/agent-runner.test.ts` | skillLoader.load 不传 agentType | ~20 |
| `packages/studio-agent/src/services/__tests__/agent-runner.test.ts` | AgentTask.provider 读取 | ~20 |

**完成标准**:
- 所有新增测试通过
- 现有测试不受影响
- 覆盖率不下降

## 依赖顺序

```
Step 1 (AgentTask 接口)
  │
  ├──→ Step 2 (cli-adapter 迁移)
  │       │
  │       └──→ Step 3 (cli-adapter 导出)
  │               │
  │               └──→ Step 4 (agent-runner 集成 cli-adapter)
  │                       │
  │                       └──→ Step 8 (daemon import 更新)
  │                               │
  │                               └──→ Step 9 (删除旧文件)
  │
  ├──→ Step 5 (knowledgeContext 注入)      ← 与 Step 2-4 无依赖
  │
  ├──→ Step 6 (skillLoader 去 agentType)   ← 与 Step 2-5 无依赖
  │
  ├──→ Step 7 (agent-loop 侧 AgentTask)   ← 依赖 Step 1
  │
  └──→ Step 10 (测试)                      ← 依赖所有 Step
```

**并行可执行**: Step 5 + Step 6 可并行（互不依赖，均只改 agent-runner.ts）

## 关键接口定义

### AgentTask（变更后）

```typescript
// packages/studio-agent/src/services/session-manager.ts

export interface AgentTask {
  id: string;
  executionId: string;
  provider: 'claude' | 'codex' | 'opencode' | 'openclaw';
  model?: string;
  prompt: string;
  notifyTarget?: string;
  parameters?: {
    sessionId?: string;
    maxTurns?: number;
    knowledgeContext?: string;
    agentRole?: string;
    [key: string]: unknown;
  };
}
```

### buildSpawnArgs（新增）

```typescript
// packages/studio-agent/src/cli-adapter.ts

export type Provider = 'claude' | 'codex' | 'opencode' | 'openclaw';

export interface SpawnParams {
  worktreeDir: string;
  sessionId?: string;
  maxTurns?: number;
}

export interface SpawnArgs {
  command: string;
  args: string[];
}

export function buildSpawnArgs(
  provider: Provider,
  params: SpawnParams,
): SpawnArgs;
```

### extractKnowledgeContext（agent-runner 内部）

```typescript
// packages/studio-agent/src/services/agent-runner.ts (新增内部函数)

function extractKnowledgeContext(task: AgentTask): string | undefined {
  return task.parameters?.knowledgeContext as string | undefined;
}

function buildAugmentedPrompt(
  basePrompt: string,
  knowledgeContext?: string,
): string {
  if (!knowledgeContext) return basePrompt;
  return knowledgeContext + '\n\n---\n\n' + basePrompt;
}
```
