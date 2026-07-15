// studio-agent 入口

export { AgentRegistry } from './services/agent-registry.js';
export { AgentExecutor, agentExecutor } from './services/agent-executor.js';
export { AgentRunner, agentRunner } from './services/agent-runner.js';
export { AgentCompleter, agentCompleter } from './services/agent-completer.js';

export type {
  AgentMetadata,
  JSONSchema,
  AgentConfig,
  AgentCapabilities,
  AgentPersona,
  AgentPersonaConstraints,
} from './types.js';

export { getPersona, listPersonas, DEFAULT_PERSONAS } from './registry.js';

export type { AgentTask, ExecutionResult } from './services/session-manager.js';

// CLI adapter — pure function buildSpawnArgs for provider-specific CLI args
export { buildSpawnArgs } from './cli-adapter.js';
export type { Provider, SpawnParams, SpawnArgs } from './cli-adapter.js';