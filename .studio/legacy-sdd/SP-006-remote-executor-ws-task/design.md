---
status: done
version: "1.0"
---

# SP-006 Design: RemoteExecutor P2 WS 通道

## 文件映射

| AC | 文件 (绝对路径) | 改动 |
|----|----------------|------|
| AC-1.1~1.4 | `apps/api/src/modules/workspaces/ws-gateway.ts` | 修改 — 新增 type/state/handler/export |
| AC-2.1 | `apps/api/src/modules/agents/remote-executor.ts` | 修改 — execute() 替换 throw stub |
| AC-3.1~3.3 | `apps/api/src/modules/workspaces/__tests__/ws-gateway.test.ts` | 修改 — 新增 describe 块 |
| AC-4.1~4.4 | `apps/api/src/modules/agents/__tests__/remote-executor.test.ts` | 修改 — 替换 stub 测试 + 新增 WS 测试 |

## 接口定义

### ws-gateway.ts 新增

```typescript
// ── Types 扩展 ──

type ClientMessage =
  | { type: 'auth'; workspaceId: string; token: string }
  | { type: 'pong' }
  | { type: 'discover_response'; requestId: string; entries: DiscoverEntry[]; error?: string }
  | { type: 'agent-task-result'; requestId: string; result?: ExecutionResult; error?: string };
  // ↑ 新增

// ── State 新增 ──

interface PendingTask {
  resolve: (result: ExecutionResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingTasks = new Map<string, PendingTask>();
```

### sendAgentTask 签名

```typescript
import type { AgentTask, ExecutionResult } from '@dommaker/studio-agent';

/**
 * 通过 WS 向远程 daemon 发送 AgentTask 并等待执行结果。
 * @param workspaceId — 目标节点（= AgentProfileData.nodeId）
 * @param task — AgentTask（onProgress 回调在发送前会被 strip）
 * @param timeoutMs — 超时 ms，默认 30_000
 * @returns Promise<ExecutionResult>
 * @throws RemoteNodeUnreachableError — 节点无活跃连接
 * @throws Error — 超时或 daemon 返回错误
 */
export function sendAgentTask(
  workspaceId: string,
  task: AgentTask,
  timeoutMs?: number,
): Promise<ExecutionResult>;
```

### 实现伪代码

```typescript
export function sendAgentTask(
  workspaceId: string,
  task: AgentTask,
  timeoutMs = 30_000,
): Promise<ExecutionResult> {
  return new Promise((resolve, reject) => {
    const entry = activeConnections.get(workspaceId);
    if (!entry || entry.ws.readyState !== WebSocket.OPEN || !entry.authenticated) {
      reject(new Error('No active connection for workspace'));
      return;
    }

    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => {
      pendingTasks.delete(requestId);
      reject(new Error('Agent task timed out'));
    }, timeoutMs);

    pendingTasks.set(requestId, { resolve, reject, timer });

    // Strip 不可序列化字段
    const safeTask = { ...task, onProgress: undefined };

    entry.ws.send(JSON.stringify({
      type: 'agent-task',
      requestId,
      task: safeTask,
    }));
  });
}
```

### handleMessage 新增 case

```typescript
case 'agent-task-result': {
  const pending = pendingTasks.get(msg.requestId);
  if (!pending) break;
  clearTimeout(pending.timer);
  pendingTasks.delete(msg.requestId);
  if (msg.error) {
    pending.reject(new Error(msg.error));
  } else {
    pending.resolve(msg.result!);
  }
  break;
}
```

### cleanup 扩展现有 cleanupConnection + attachWsGateway

需要在 `cleanupConnection` 和 `attachWsGateway` 返回的 cleanup 中 reject 所有指向该 workspace 的 pending tasks：

```typescript
// cleanupConnection 中新增（在 activeConnections.delete 之前）:
for (const [rid, pending] of pendingTasks) {
  // 只清理指向该 workspace 的 pending task
  // 需要额外 bookkeeping：requestId → workspaceId 映射，或遍历时逐个 reject
}
```

简化方案：在 `cleanupConnection` 中不做精确清理，在 `attachWsGateway` 的 cleanup 中 reject 全部（与 `pendingDiscovers` 一致）：

```typescript
// attachWsGateway cleanup 函数中新增:
for (const [, pending] of pendingTasks) {
  clearTimeout(pending.timer);
  pending.reject(new Error('Server shutting down'));
}
pendingTasks.clear();
```

### remote-executor.ts 改动

```typescript
// Before (P1 stub):
async execute(task: AgentTask): Promise<ExecutionResult> {
  throw new RemoteNodeUnreachableError(this.nodeId, 'WS agent-task channel not yet wired (P2)');
}

// After (P2):
import { sendAgentTask } from '../workspaces/ws-gateway.js';

async execute(task: AgentTask): Promise<ExecutionResult> {
  try {
    return await sendAgentTask(this.nodeId, task, this.timeoutMs);
  } catch (err) {
    throw new RemoteNodeUnreachableError(
      this.nodeId,
      err instanceof Error ? err.message : String(err),
    );
  }
}
```

## 代码依赖 DAG

```
ws-gateway.ts ──────────────── (layer 0 — 无内部依赖)
    │
    ├──→ remote-executor.ts ── (layer 1 — import sendAgentTask)
    │
    ├──→ ws-gateway.test.ts ── (layer 1 — 测试 ws-gateway.ts)
    │
    └──→ remote-executor.test.ts (layer 2 — 测试 remote-executor.ts, mock sendAgentTask)
```

**并行机会**：
- Layer 0: `ws-gateway.ts` 独立实现
- Layer 1: `remote-executor.ts` + `ws-gateway.test.ts` 可并行（无交叉依赖）
- Layer 2: `remote-executor.test.ts` 串行（依赖 Layer 1 的接口稳定）

## 消费方分析

`sendAgentTask` 的消费方：
1. `remote-executor.ts` — 直接调用，唯一生产消费方
2. `remote-executor.test.ts` — mock 后测试

`ClientMessage` 类型扩展的影响：
- 仅在 `handleMessage` 内部消费，新增 case 不改变现有分支行为

## 模块边界

- `ws-gateway.ts`: WS 消息编解码 + 连接管理 + Promise 化请求/响应。不涉及 Agent 业务逻辑。
- `remote-executor.ts`: 执行器适配层，将 `sendAgentTask` 返回的通用 Error 包装为 `RemoteNodeUnreachableError`，供 AgentLoop 统一 catch。
