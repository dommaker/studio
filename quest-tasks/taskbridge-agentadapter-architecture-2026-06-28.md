# TaskBridge + AgentAdapter 架构重构

## Context

当前 studio 项目有 3 个独立模块处理任务/工作流：

1. **quest-formatter.ts** - 格式化逻辑（~500 行）
   - 功能：将 AC Groups 转为 LLM prompt
   - 输入：QuestTask, ACGroup
   - 输出：string（prompt 文本）

2. **workunit-runner.ts** - 执行逻辑（~300 行）
   - 功能：运行单个 WorkUnit
   - 调用：session-api, agent-network, event-bus
   - 问题：与 formatter 强耦合（直接调用 buildQuestPrompt）

3. **quest-executor.ts** - 批量调度（~200 行）
   - 功能：批量运行 WorkUnits
   - 调用：workunit-runner, progress-tracker
   - 问题：重试逻辑硬编码，无策略抽象

**现状问题**：
- formatter ↔ runner 强耦合（无法独立测试）
- 重试/超时/进度上报无统一策略
- 错误处理不一致（有的 throw，有的 catch，有的忽略）

## Design Proposal

### 架构模式：Adapter + Bridge

```
QuestTask ──┐
             ├─→ [TaskBridge] ──→ NormalizedTask ──→ [AgentAdapter] ──→ Agent Execution
ACGroup ─────┘         ↑                                    ↓
                       │                              SessionManager
                       └────────────────────────────────────┘
                                  (回调上报进度)
```

### 核心接口

#### 1. TaskBridge（适配器层）
**职责**：统一输入格式，隔离数据源差异
**位置**：`apps/api/src/modules/quest/task-bridge.ts`

```typescript
interface TaskBridge {
  normalize(task: QuestTask, acGroup: ACGroup): NormalizedTask;
  toPrompt(normalized: NormalizedTask): string;
}

interface NormalizedTask {
  id: string;
  context: {
    description: string;
    constraints: string[];
    testStrategy: string;
  };
  validation: {
    type: 'contract' | 'integration';
    successCriteria: string[];
  };
}
```

#### 2. AgentAdapter（执行层）
**职责**：封装 agent 执行策略（重试/超时/回退）
**位置**：`apps/api/src/modules/quest/agent-adapter.ts`

```typescript
interface AgentAdapter {
  execute(
    task: NormalizedTask,
    options: ExecutionOptions,
    callbacks: ProgressCallbacks
  ): Promise<ExecutionResult>;
}

interface ExecutionOptions {
  retry: RetryStrategy;
  timeout: TimeoutConfig;
  fallback?: FallbackStrategy;
}

interface ProgressCallbacks {
  onStart: () => void;
  onProgress: (percent: number) => void;
  onComplete: (result: ExecutionResult) => void;
  onError: (error: Error) => void;
}

interface ExecutionResult {
  status: 'success' | 'failed' | 'timeout';
  output: string;
  duration: number;
  retries: number;
}
```

### 策略配置

```typescript
// 可配置策略，不硬编码
interface RetryStrategy {
  maxAttempts: number;
  backoff: 'linear' | 'exponential';
}

interface TimeoutConfig {
  duration: number;
  action: 'fail' | 'warn';
}

interface FallbackStrategy {
  type: 'mock' | 'cached' | 'skip';
}
```

## Acceptance Criteria

### AC-1: TaskBridge 接口（must）
- **AC-1.1** TaskBridge.normalize() 接收 QuestTask + ACGroup，输出 NormalizedTask
- **AC-1.2** NormalizedTask 包含 id, context(description/constraints/testStrategy), validation(type/successCriteria)
- **AC-1.3** TaskBridge.toPrompt() 将 NormalizedTask 转为 prompt 字符串
- **AC-1.4** 单元测试覆盖 normalize/toPrompt（正常路径 + 边界情况）

### AC-2: AgentAdapter 接口（must）
- **AC-2.1** AgentAdapter.execute() 接收 NormalizedTask + ExecutionOptions + ProgressCallbacks
- **AC-2.2** ExecutionOptions 包含 retry/timeout/fallback 策略配置
- **AC-2.3** ProgressCallbacks 提供 onStart/onProgress/onComplete/onError 回调
- **AC-2.4** ExecutionResult 包含 status/output/duration/retries
- **AC-2.5** 单元测试覆盖 execute（成功/失败/超时/重试场景）

### AC-3: 集成替换（must）
- **AC-3.1** workunit-runner.ts 使用 TaskBridge + AgentAdapter 替代原有逻辑
- **AC-3.2** quest-executor.ts 通过 AgentAdapter 批量执行，移除硬编码重试
- **AC-3.3** quest-formatter.ts 重构为 TaskBridge 的实现细节（不直接导出 buildQuestPrompt）
- **AC-3.4** 现有功能不受影响（quest 任务可正常执行）

### AC-4: 测试覆盖（must）
- **AC-4.1** task-bridge.test.ts 覆盖 normalize/toPrompt（≥5 用例）
- **AC-4.2** agent-adapter.test.ts 覆盖 execute 各策略组合（≥8 用例）
- **AC-4.3** 集成测试：workunit-runner 端到端执行（≥3 用例）
- **AC-4.4** 测试覆盖率 ≥ 80%

## Implementation Strategy

### Phase 1: TaskBridge（1 天）
1. 创建 `task-bridge.ts`，实现 normalize/toPrompt
2. 编写 `task-bridge.test.ts`（AC-1.4）
3. Checkpoint：单元测试通过

### Phase 2: AgentAdapter（1.5 天）
1. 创建 `agent-adapter.ts`，实现 execute + 策略配置
2. 编写 `agent-adapter.test.ts`（AC-2.5）
3. Checkpoint：单元测试通过，覆盖所有策略组合

### Phase 3: 集成替换（1.5 天）
1. 重构 `workunit-runner.ts` 使用 TaskBridge + AgentAdapter（AC-3.1）
2. 重构 `quest-executor.ts` 使用 AgentAdapter（AC-3.2）
3. 重构 `quest-formatter.ts` 为 TaskBridge 实现（AC-3.3）
4. 编写集成测试（AC-4.3）
5. Checkpoint：所有测试通过，功能正常

### Phase 4: 验证（0.5 天）
1. 运行完整测试套件
2. 验证覆盖率 ≥ 80%（AC-4.4）
3. 验证现有 quest 任务可正常执行（AC-3.4）

## File Mapping

| 文件 | 变更类型 | 说明 |
|------|----------|------|
| `apps/api/src/modules/quest/task-bridge.ts` | 新增 | TaskBridge 接口 + 实现 |
| `apps/api/src/modules/quest/task-bridge.test.ts` | 新增 | TaskBridge 单元测试 |
| `apps/api/src/modules/quest/agent-adapter.ts` | 新增 | AgentAdapter 接口 + 实现 |
| `apps/api/src/modules/quest/agent-adapter.test.ts` | 新增 | AgentAdapter 单元测试 |
| `apps/api/src/modules/quest/workunit-runner.ts` | 重构 | 使用 TaskBridge + AgentAdapter |
| `apps/api/src/modules/quest/quest-executor.ts` | 重构 | 使用 AgentAdapter，移除硬编码 |
| `apps/api/src/modules/quest/quest-formatter.ts` | 重构 | 改为 TaskBridge 实现细节 |

## Dependencies

- 无外部依赖
- 复用现有 session-api, agent-network, event-bus
- 类型定义复用 `types/quest.types.ts`

## Risks & Mitigations

| 风险 | 缓解 |
|------|------|
| 重构影响现有功能 | Phase 3 完成后立即验证，有回归则回滚 |
| 策略配置过度设计 | 保持最简，仅实现 retry/timeout/fallback，不加未用功能 |
| 测试覆盖不足 | Phase 4 强制检查覆盖率，< 80% 不通过 |

## Checkpoints

- [ ] Phase 1: TaskBridge 单元测试通过
- [ ] Phase 2: AgentAdapter 单元测试通过（覆盖所有策略）
- [ ] Phase 3: 集成测试通过，功能正常
- [ ] Phase 4: 完整测试通过，覆盖率 ≥ 80%
