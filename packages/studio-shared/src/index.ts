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

// 导出统一配置 API（仅类型，避免前端引入 config 模块的 fs/path/os top-level 副作用）
// 后端需要 loadConfigEnv 等运行时配置请使用 '@dommaker/studio-shared/node'
export type { LlmProvider } from './config/index';

// 导出 Constants 模块
export * from './constants/levels';
export * from './constants/monitoring';

// 导出职能域词表（决策 8：阶段导向单一词表 + legacy 归一化）
export * from './domain-vocab';

// 导出 F6 信任证据模型（决策 1：attestations + 唯一派生口径 deriveDisplayState）
export * from './attestation';

// 导出 Types 模块
export * from './types/goal-status';
export * from './types/resolution';

// 导出 Harness 类型（供下游包使用）
export type { ConstraintLevel, ConstraintContext, ConstraintResult } from '@dommaker/harness';
export * from './harness/auditor/auditor-types';

// 导出 EventBus
export { eventBus, StudioEventBus } from './event-bus';

// 导出 MemoryStore
export { memoryStore } from './memory-store';

// 导出 FileStore (AN 运行时数据文件存储)
export { FileStore, LockTimeoutError, parseChannels, stringifyChannels, parseFrontmatter, serializeFrontmatter, formatRequirementId, formatEvolutionId } from './file-store';
export type { FileStoreOptions } from './file-store';
// 导出 JSONL append-only 折叠（#360：byId 分组 + 业务侧墓碑判据）
export { foldJsonlById } from './jsonl-fold';
export type { JsonlFoldGroup } from './jsonl-fold';
export type {
  AgentProfileData,
  RuntimeStateData,
  ChannelData,
  ChannelMessageData,
  ChannelMessageRow,
  QueryOpts,
  MessagePageOpts,
  MessagePage,
  MessageCompactionOptions,
  CountOpts,
  WorkUnitEvent,
  WorkUnitEventType,
  WorkUnitSnapshot,
  WorkUnitFilter,
  WorkUnitReconcileResult,
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
