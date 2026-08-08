// studio-agent 入口

export { AgentRegistry } from './services/agent-registry.js';
export { AgentRunner, agentRunner } from './services/agent-runner.js';

export type { AgentTask, ExecutionResult } from './services/types.js';

// B3b-i: 每 WU 专属 worktree（按 WU id 键控，跨 step 复用；失败清理后抛错）
export { ensureWuWorktree, ensureBranchExists, ensurePmoIntegrationWorktree, getDefaultBranch } from './services/worktree-resolver.js';
export type { WuWorktreeInfo } from './services/worktree-resolver.js';

// CLI adapter — pure function buildSpawnArgs for provider-specific CLI args
export { buildSpawnArgs } from './cli-adapter.js';
export type { Provider, SpawnParams, SpawnArgs } from './cli-adapter.js';