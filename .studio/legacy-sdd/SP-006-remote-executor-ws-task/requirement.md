---
status: done
version: "1.0"
---

# SP-006: RemoteExecutor P2 — WS 通道 agent-task 接通

> 来源：`docs/specs/design/SP-006-remote-executor-ws-task.md`
> 依赖：`ws-gateway.ts`（`/ws/daemon`）、daemon task-executor、`remote-executor.ts`

## 源项目清单

| # | 源项目 | 产出类型 | SDD AC |
|---|--------|---------|--------|
| 1 | ws-gateway.ts: 新增 `sendAgentTask()` + `pendingTasks` + `agent-task-result` handler | 代码 | AC-1 |
| 2 | remote-executor.ts: 移除 throw stub，改调 `sendAgentTask()` | 代码 | AC-2 |
| 3 | ws-gateway.test.ts: 新增 sendAgentTask 响应测试 | 测试 | AC-3 |
| 4 | remote-executor.test.ts: 新增 WS 成功/超时/错误路径测试 | 测试 | AC-4 |

---

## AC Groups

### AC Group 1: ws-gateway.ts — sendAgentTask 发送+响应 (covers: [1])

**AC-1.1 — sendAgentTask 发送任务并等待响应**:
- 触发：调用 `sendAgentTask(workspaceId, task)`
- 预期：daemon 连接存在 → 发 `{ type: 'agent-task', requestId, task }` → 等待 `agent-task-result` → resolve `result`
- 边界：无连接 → reject `RemoteNodeUnreachableError`（与 `discoverViaWs` 一致的模式）
- 不做：不新建 WS 端点，不复用 HTTP

**AC-1.2 — 30s 默认超时**:
- 触发：`sendAgentTask` 30s 内无 `agent-task-result` 响应
- 预期：reject with `Error('Agent task timed out')`
- 边界：`timeoutMs` 参数可覆盖默认值
- 不做：不实现重试逻辑

**AC-1.3 — onProgress 回调序列化前 strip**:
- 触发：AgentTask 含 `onProgress` 回调
- 预期：发送的 WS message 中 task 无 `onProgress` 字段
- 边界：`onProgress` 为 `undefined` → 不报错
- 不做：不序列化/传输回调函数

**AC-1.4 — agent-task-result 消息路由**:
- 触发：daemon 回复 `{ type: 'agent-task-result', requestId, result/error }`
- 预期：`handleMessage` 按 `requestId` 找到 `pendingTask` → resolve result 或 reject error → 清理 timer + map entry
- 边界：`requestId` 未匹配 → 忽略（daemon 重复回复 / 竞态）
- 边界：`error` 非空 → reject `Error(error)`
- 不做：不处理 daemon 端 handler（远程节点代码）

### AC Group 2: remote-executor.ts — 接通 WS (covers: [2])

> 测试由 AC Group 4 覆盖（remote-executor.test.ts）

**AC-2.1 — execute() 通过 WS 发送任务**:
- 触发：`RemoteExecutor.execute(task)` 被 AgentLoop agentStep 调用
- 预期：调 `sendAgentTask(this.nodeId, task, this.timeoutMs)` → 返回 `ExecutionResult`
- 边界：`sendAgentTask` reject → `execute()` throw `RemoteNodeUnreachableError`（由 AgentLoop catch → need_input）
- 边界：`nodeId` 即为 `workspaceId`（直接传给 `sendAgentTask` 第一个参数）
- 不做：不改 AgentLoop 状态机，不改 `Executor` 接口

### AC Group 3: ws-gateway.test.ts — sendAgentTask 测试 (covers: [3])

**AC-3.1 — sendAgentTask 成功路径测试**:
- 触发：测试中 mock 连接 + 发送 `agent-task` + 回复 `agent-task-result`
- 预期：`sendAgentTask` resolve 正确的 `ExecutionResult`
- 边界：验证 requestId 匹配

**AC-3.2 — sendAgentTask 无连接测试**:
- 触发：对无活跃连接的 workspaceId 调用 `sendAgentTask`
- 预期：reject with error 包含 "No active connection"

**AC-3.3 — sendAgentTask 超时测试**:
- 触发：客户端不回复 `agent-task-result`
- 预期：reject with error 包含 "timed out"

### AC Group 4: remote-executor.test.ts — execute WS 测试 (covers: [4])

**AC-4.1 — execute 成功路径测试**:
- 触发：mock `sendAgentTask` → resolve `mockResult`
- 预期：`execute(task)` 返回 `mockResult`

**AC-4.2 — execute 节点不可达测试**:
- 触发：mock `sendAgentTask` → reject `Error('No active connection')`
- 预期：`execute(task)` throw `RemoteNodeUnreachableError`

**AC-4.3 — execute 超时测试**:
- 触发：mock `sendAgentTask` → reject `Error('timed out')`
- 预期：`execute(task)` throw `RemoteNodeUnreachableError`

**AC-4.4 — P1 stub 测试更新**:
- 触发：现有测试 AC-8.4 期望 P1 stub 抛错
- 预期：更新为 P2 行为（mock `sendAgentTask` → resolve）

---

## AC → 文件映射

| AC | 文件 | 改动类型 |
|----|------|---------|
| AC-1.1 | `apps/api/src/modules/workspaces/ws-gateway.ts` | 修改 — 新增 `sendAgentTask()` 导出 |
| AC-1.2 | `apps/api/src/modules/workspaces/ws-gateway.ts` | 修改 — 超时逻辑（同上函数） |
| AC-1.3 | `apps/api/src/modules/workspaces/ws-gateway.ts` | 修改 — onProgress strip（同上函数） |
| AC-1.4 | `apps/api/src/modules/workspaces/ws-gateway.ts` | 修改 — ClientMessage type + handleMessage case |
| AC-2.1 | `apps/api/src/modules/agents/remote-executor.ts` | 修改 — execute() 替换 throw stub |
| AC-3.1 | `apps/api/src/modules/workspaces/__tests__/ws-gateway.test.ts` | 修改 — 新增 sendAgentTask 测试 |
| AC-3.2 | `apps/api/src/modules/workspaces/__tests__/ws-gateway.test.ts` | 修改 — 同上 |
| AC-3.3 | `apps/api/src/modules/workspaces/__tests__/ws-gateway.test.ts` | 修改 — 同上 |
| AC-4.1 | `apps/api/src/modules/agents/__tests__/remote-executor.test.ts` | 修改 — 新增 WS 成功测试 |
| AC-4.2 | `apps/api/src/modules/agents/__tests__/remote-executor.test.ts` | 修改 — 新增强断连测试 |
| AC-4.3 | `apps/api/src/modules/agents/__tests__/remote-executor.test.ts` | 修改 — 新增超时测试 |
| AC-4.4 | `apps/api/src/modules/agents/__tests__/remote-executor.test.ts` | 修改 — 更新 P1 stub 测试 |
