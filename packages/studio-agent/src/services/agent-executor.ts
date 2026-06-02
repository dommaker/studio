/**
 * Agent Executor - Facade
 *
 * Session Loop 执行模型 (daemon async spawn)
 *
 * P11-02: Split into sub-modules:
 *   worktree-resolver.ts — git worktree 创建 + harness 配置传播 + 文件桥
 *   output-capture.ts — 进度读取 + 输出文件收集 + session 指标记录
 *   session-manager.ts — AgentExecutor 类 + session loop + prompt 构建
 */

// Re-export types for zero breaking changes
export type {
  ExecutorConfig,
  AgentTask,
  ExecutionResult,
  PrerequisiteCheck,
} from './session-manager.js';

export type { ProgressReport } from './output-capture.js';

// Re-export AgentExecutor class and singleton
export { AgentExecutor, agentExecutor } from './session-manager.js';

// Re-export worktree-resolver functions
export {
  createWorktree,
  propagateHarnessConfig,
  buildCachePrefix,
  writeRequirementsMd,
  writeContractTests,
} from './worktree-resolver.js';

// Re-export output-capture functions
export {
  readProgress,
  collectOutputFiles,
  parseJsonEnvelope,
  recordSessionMetrics,
  emitSessionStart,
  emitSessionEnd,
  recordExecutionError,
  getConstraintMeta,
} from './output-capture.js';
