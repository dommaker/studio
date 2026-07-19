/**
 * 通用入口 — 不包含 CLI/Config（避免前端引入 fs/path/yaml）
 * 前端和通用包使用此入口
 * 后端需要 CLI 功能请使用 '@dommaker/studio-shared/node'
 */

// 导出 Utils 模块
export * from './utils/index';

// 导出 LLM 模块
export * from './llm/index';

// 导出 Harness 模块
export * from './harness/index';

// 导出 Model Tier（类型安全，无依赖，可安全引入前端）
export { type ModelTier, getModelForTier } from './config/model-tier';

// 导出统一配置 API
export { getProviderApiKey, getConfigSummary, getConfiguredProviders, loadConfigEnv, type LlmProvider, type WorkloadType } from './config/index';

// 导出 Constants 模块
export * from './constants/levels';
export * from './constants/responsibility-chain';
export * from './constants/stage-definitions';

// 导出 Types 模块
export * from './types/stance';
export * from './types/goal-status';
export * from './types/resolution';
export * from './types/user-behavior';

// 导出 Harness 类型（供下游包使用）
export type { ConstraintLevel, ConstraintContext, ConstraintResult } from '@dommaker/harness';
export * from './harness/auditor/auditor-types';

// 导出 EventBus
export { eventBus, StudioEventBus } from './event-bus';

// 导出 MemoryStore
export { memoryStore } from './memory-store';

// 导出 FileStore (AN 运行时数据文件存储)
export { FileStore, LockTimeoutError, parseChannels, stringifyChannels, parseFrontmatter, serializeFrontmatter, formatRequirementId, formatEvolutionId } from './file-store';
export type {
  AgentProfileData,
  RuntimeStateData,
  ChannelData,
  ChannelMessageData,
  ChannelMessageRow,
  QueryOpts,
  CountOpts,
  WorkUnitEvent,
  WorkUnitEventType,
  WorkUnitSnapshot,
  WorkUnitFilter,
  RequirementData,
  RequirementStatus,
  RequirementFilter,
  EvolutionProposalData,
  EvolutionProposalStatus,
  EvolutionProposalFilter,
  EvolutionTargetType,
} from './file-store';

// 导出 Stats 模块
export * from './stats/anomaly-detector';
