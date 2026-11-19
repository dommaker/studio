/**
 * 纯类型入口（#685）：实体类型正本，供契约包/前端 import type 同源。
 *
 * 只含 type re-export，零运行时 import——消费方一律 import type，
 * 编译期整体擦除，不带入任何 Node 依赖。
 */

export type {
  AgentProfileData,
  RuntimeStateData,
  ChannelData,
  ChannelMessageData,
  RequirementData,
  RequirementStatus,
  EvolutionProposalData,
  EvolutionProposalStatus,
  EvolutionTargetType,
  EvolutionMetricSnapshot,
  EvolutionObservation,
} from './file-store/file-store-types';

export type { Resolution, CreateResolutionInput } from './types/resolution';

export type {
  KnowledgeEntry,
  SourceRef,
  ExecutionResult,
  ExecutionTrace,
  AgentState,
  RetiredConstraintEntry,
} from '@dommaker/harness';
