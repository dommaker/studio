---
status: done
version: "1.0"
---

# SP-006 Task: RemoteExecutor P2 WS 通道

## 契约测试规划

### AC Group 1+3: ws-gateway.ts sendAgentTask (AC-1.1~1.4, AC-3.1~3.3)

**测试文件**: `apps/api/src/modules/workspaces/__tests__/ws-gateway.test.ts`

| # | 测试用例 | AC | 类型 | 方法 |
|---|---------|-----|------|------|
| T1 | sendAgentTask 发送 agent-task 并收到 agent-task-result → resolve result | AC-1.1, AC-1.4 | 行为 | mock daemon 客户端回复 `agent-task-result` 带 result |
| T2 | sendAgentTask 无活跃连接 → reject "No active connection" | AC-1.1 | 边界 | 对不存在的 workspaceId 调用 |
| T3 | sendAgentTask 超时 → reject "timed out" | AC-1.2 | 边界 | mock daemon 不回复，短 timeoutMs |
| T4 | sendAgentTask daemon 返回 error → reject Error(error) | AC-1.4 | 边界 | mock daemon 回复 `error: 'xxx'` |
| T5 | sendAgentTask 发送消息中 task 无 onProgress 字段 | AC-1.3 | 行为 | mock daemon 检查收到的 msg.task 不含 onProgress |

### AC Group 2+4: remote-executor.ts execute (AC-2.1, AC-4.1~4.4)

**测试文件**: `apps/api/src/modules/agents/__tests__/remote-executor.test.ts`

| # | 测试用例 | AC | 类型 | 方法 |
|---|---------|-----|------|------|
| T6 | mock sendAgentTask resolve → execute 返回 result | AC-2.1, AC-4.1 | 行为 | vi.mock sendAgentTask → resolve mockResult |
| T7 | mock sendAgentTask reject "No active connection" → throw RemoteNodeUnreachableError | AC-2.1, AC-4.2 | 边界 | vi.mock sendAgentTask → reject |
| T8 | mock sendAgentTask reject "timed out" → throw RemoteNodeUnreachableError | AC-2.1, AC-4.3 | 边界 | vi.mock sendAgentTask → reject |
| T9 | 更新 AC-8.4 测试：P1 stub → P2 mock | AC-4.4 | 回归 | 现有 stub 测试改为 mock sendAgentTask → resolve |

## 执行顺序

### Phase 1: ws-gateway.test.ts — RED `[safe]`

**风险**: `safe` — 纯增量测试
**文件**: `apps/api/src/modules/workspaces/__tests__/ws-gateway.test.ts`
**覆盖 AC**: AC-3.1, AC-3.2, AC-3.3

改动内容：
1. 新增 `import { sendAgentTask } from '../ws-gateway.js'`
2. 新增 `describe('sendAgentTask', ...)` 块
3. T1~T5 测试用例（成功/无连接/超时/错误/onProgress strip）

验证：`npx vitest run ws-gateway.test.ts` → FAIL（sendAgentTask 未实现）

### Phase 2: ws-gateway.ts — GREEN `[breaking]`

**风险**: `breaking` — ClientMessage type 扩展 + 新增导出 `sendAgentTask`
**文件**: `apps/api/src/modules/workspaces/ws-gateway.ts`
**覆盖 AC**: AC-1.1, AC-1.2, AC-1.3, AC-1.4

改动内容：
1. `ClientMessage` type 新增 `{ type: 'agent-task-result'; requestId: string; result?: ExecutionResult; error?: string }`
2. 新增 `PendingTask` interface + `pendingTasks` Map
3. `handleMessage` 新增 `case 'agent-task-result'`
4. 新增导出 `sendAgentTask(workspaceId, task, timeoutMs?)`
5. `attachWsGateway` cleanup 函数中新增 `pendingTasks` 清理
6. 导出 `pendingTasks`（供测试）

验证：`npx vitest run ws-gateway.test.ts` → PASS（T1~T5 全部通过）

### Phase 3: remote-executor.test.ts — RED `[safe]`

**风险**: `safe` — 测试更新
**文件**: `apps/api/src/modules/agents/__tests__/remote-executor.test.ts`
**覆盖 AC**: AC-4.1, AC-4.2, AC-4.3, AC-4.4

改动内容：
1. 新增 `vi.mock('../workspaces/ws-gateway.js', ...)` mock `sendAgentTask`
2. T6~T9 测试用例（成功/不可达/超时/回归）
3. 移除 P1 stub 期望（AC-8.4 测试更新）

验证：`npx vitest run remote-executor.test.ts` → FAIL（execute 仍是 stub）

### Phase 4: remote-executor.ts — GREEN `[breaking]`

**风险**: `breaking` — execute() 从 throw → WS 调用，行为变更
**文件**: `apps/api/src/modules/agents/remote-executor.ts`
**覆盖 AC**: AC-2.1

改动内容：
1. 新增 `import { sendAgentTask } from '../workspaces/ws-gateway.js'`
2. 移除未使用的 `agentRunner` import（现由 ws-gateway 导入）
3. `execute()` 方法：try `await sendAgentTask(this.nodeId, task, this.timeoutMs)` → catch → throw `RemoteNodeUnreachableError`
4. 更新 JSDoc（移除 "P1" 标记）

验证：`npx vitest run remote-executor.test.ts` → PASS（T6~T9 全部通过）

## 里程碑

| Phase | 产出 | 验证 |
|-------|------|------|
| Phase 1 | ws-gateway.test.ts 新测试 | RED: 新测试 FAIL（sendAgentTask 不存在） |
| Phase 2 | ws-gateway.ts 实现 | GREEN: ws-gateway.test.ts PASS |
| Phase 3 | remote-executor.test.ts 更新 | RED: 新测试 FAIL（execute 仍是 stub） |
| Phase 4 | remote-executor.ts 实现 | GREEN: 全部测试 PASS |

## Implementation Readiness

implementationReady: true

| # | 条件 | 满足 | 证据 |
|---|------|------|------|
| 1 | design.md 有精确接口定义 | ✅ | sendAgentTask 签名 + 实现伪代码 + handleMessage case 均在 design.md |
| 2 | 非平凡变更有 before/after 代码块 | ✅ | remote-executor.ts execute() before/after 已给出 |
| 3 | 消费方覆盖 | ✅ | 唯一消费方 remote-executor.ts，已在 design.md 标注 |
| 4 | 测试断言具体 | ✅ | T1~T9 每条有明确的 expect 行为（resolve/reject 具体值） |
| 5 | 接口定义完整 | ✅ | 签名 + 参数类型 + 返回值 + throws 均已定义 |
