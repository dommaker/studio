---
slug: agent-runner-enhancement
title: Agent Runner 增强 — 知识注入 + Provider 适配 + Skill 加载
status: draft
createdAt: "2026-07-13"
---

# Design: Agent Runner 增强

## 架构变更

### 1. cli-adapter 移动路径

```
迁移前:
  apps/api/src/daemon/cli-adapter.ts  (daemon 层，含 session-id file + pid file 读取)

迁移后:
  packages/studio-agent/src/cli-adapter.ts  (packages 层，纯函数)
```

提纯内容：移除 daemon 特有的文件读取（session-id file、pid file），保留 `buildSpawnArgs(provider, params)` 纯函数签名。

导出方式：`packages/studio-agent/src/index.ts` 新增 `export * from './cli-adapter'`。

daemon 侧 import 改为引用 packages 路径。

### 2. AgentTask 接口变更

**变更前**（`packages/studio-agent/src/services/session-manager.ts`）：

```typescript
interface AgentTask {
  id: string;
  executionId: string;
  agentType: 'codex' | 'claude';           // ← 改名为 provider
  model?: string;
  prompt: string;
  notifyTarget?: string;
  parameters?: Record<string, unknown>;     // ← 内部含 sessionFlags: string
}
```

**变更后**：

```typescript
interface AgentTask {
  id: string;
  executionId: string;
  provider: 'claude' | 'codex' | 'opencode' | 'openclaw';  // 重命名 + 扩展
  model?: string;
  prompt: string;
  notifyTarget?: string;
  parameters?: {
    sessionId?: string;        // 替代 sessionFlags
    maxTurns?: number;         // 新增
    knowledgeContext?: string; // 新增（GAP-5）
    agentRole?: string;        // 保留
    [key: string]: unknown;    // 扩展性
  };
}
```

### 3. Provider Session 策略

| Provider | Session 机制 | 实现方式 |
|----------|-------------|---------|
| `claude` | `--session-id` / `--resume` | 原生 CLI flag |
| `codex` | `--session` | 原生 CLI flag |
| `openclaw` | `--session` | 原生 CLI flag |
| `opencode` | 文件上下文注入 | 读写 `~/.studio/data/agents/{id}/opencode-sessions/{sessionId}.jsonl` |

opencode 策略约 30 行：执行前读 JSONL 取最近 N 轮格式化为 context 插入 prompt 头部，执行后从输出取摘要 append 到 JSONL。

### 4. skillLoader.load 调用变更

```typescript
// 当前
skillLoader.load({ agentType: 'executor', tier: skillTier })
// 修复
skillLoader.load({ tier: skillTier })
```

Tier 过滤保留。agentType 过滤逻辑（skillLoader L116: `if (agentType && s.agentTypes.length > 0 ...)`）在调用侧不传 agentType 时自然跳过。

## 数据流

### 完整数据流：agent-loop → task.parameters → agent-runner

```
agent-loop (apps/api/src/daemon/)
  │
  ├─ 1. knowledgeService.injectContext(taskScope)        ← GAP-5b
  │     │  taskScope = { type: WorkUnit.type, title: WorkUnit.title }
  │     │  return knowledgeContext (string)
  │     ▼
  ├─ 2. 构造 AgentTask
  │     {
  │       provider: 'claude',
  │       prompt,
  │       parameters: {
  │         sessionId: this.instance?.sessionId,
  │         maxTurns: 50,
  │         knowledgeContext,    // ← GAP-5b 返回
  │         agentRole: 'executor',
  │       },
  │     }
  │     ▼
  ├─ 3. agentRunner.executeLightweight(task)
  │     │
  │     ▼  agent-runner (packages/studio-agent/src/services/)
  │     │
  │     ├─ 3a. 读取 provider
  │     │      provider = 'claude'
  │     │      ▼
  │     ├─ 3b. 调用 cli-adapter.buildSpawnArgs(provider, params)   ← AC-4a.2
  │     │      │  params = { sessionId, maxTurns, worktreeDir }
  │     │      │  return { command: 'claude', args: ['--print', '--output-format', 'stream-json', ...] }
  │     │      ▼
  │     ├─ 3c. 读取 knowledgeContext                               ← AC-5a.1
  │     │      const kc = task.parameters?.knowledgeContext || '';
  │     │      const augmentedPrompt = kc ? kc + '\n\n---\n\n' + task.prompt : task.prompt;
  │     │      ▼
  │     ├─ 3d. 加载 skills (去 agentType)                          ← AC-7.1
  │     │      skillLoader.load({ tier: skillTier })
  │     │      ▼
  │     └─ 3e. spawn CLI 进程
  │            spawn(command, args, { cwd: worktree, ... })
  │
  └─ 4. 结果 → 回调
```

### execute 路径（完整 Agent session，同样改造）

```
agent-loop → agentRunner.execute(task)
  │
  ├─ buildSpawnArgs(provider, params)     ← 替换硬编码 L408
  ├─ buildPrompt(...) 已有 knowledgeContext 参数
  ├─ skillLoader.load({ tier })           ← 替换 agentType 硬编码
  └─ spawn
```

## 文件映射表

| AC | 文件路径 | 改动类型 | 说明 |
|----|---------|---------|------|
| AC-5a.1-3 | `packages/studio-agent/src/services/agent-runner.ts` | 修改 | executeLightweight 加 knowledgeContext 注入 |
| AC-7.1-3 | `packages/studio-agent/src/services/agent-runner.ts` | 修改 | skillLoader.load 去 agentType 参数 |
| AC-4a.1 | `apps/api/src/daemon/cli-adapter.ts` | 删除 | 迁移至 packages |
| AC-4a.1 | `packages/studio-agent/src/cli-adapter.ts` | 新增 | 迁入 + 提纯 |
| AC-4a.1 | `packages/studio-agent/src/index.ts` | 修改 | 新增 cli-adapter 导出 |
| AC-4a.2 | `packages/studio-agent/src/services/agent-runner.ts` | 修改 | L408 + L812 改为 buildSpawnArgs |
| AC-4a.3 | `packages/studio-agent/src/services/session-manager.ts` | 修改 | AgentTask 接口变更 |
| AC-4a.4 | `apps/api/src/daemon/` (agent-loop/claim-loop) | 修改 | 传新 AgentTask 字段 |
| AC-4a.5 | `packages/studio-agent/src/cli-adapter.ts` | 实现 | claude/codex/openclaw session flag |
| AC-4a.6 | `packages/studio-agent/src/cli-adapter.ts` | 实现 | opencode 文件上下文注入 |

## 接口定义

### buildSpawnArgs

```typescript
// packages/studio-agent/src/cli-adapter.ts

export interface SpawnParams {
  worktreeDir: string;
  sessionId?: string;
  maxTurns?: number;
  agentSessionId?: string;  // 用于 resume
}

export interface SpawnArgs {
  command: string;
  args: string[];
}

export function buildSpawnArgs(
  provider: 'claude' | 'codex' | 'opencode' | 'openclaw',
  params: SpawnParams,
): SpawnArgs;
```

### agent-runner 内部 extractKnowledgeContext

```typescript
// packages/studio-agent/src/services/agent-runner.ts (内部函数)

function extractKnowledgeContext(task: AgentTask): string | undefined {
  return task.parameters?.knowledgeContext as string | undefined;
}

function buildAugmentedPrompt(prompt: string, knowledgeContext?: string): string {
  return knowledgeContext
    ? knowledgeContext + '\n\n---\n\n' + prompt
    : prompt;
}
```
