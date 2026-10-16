import { resolveStudioEventsFile } from '@dommaker/studio-shared';
import type { WorkUnitData, WorkUnitMetadata } from '../../workunit/index.js';
import {
  composeStepPrompt,
  type ComposedStepPrompt,
  type PromptComposerDeps,
} from '../prompt-composer.js';
import type { Target } from '../agent-loop.types.js';
import type { AgentLoopHost } from './loop-host.js';

export interface StepPromptInput {
  target: Target;
  wu: WorkUnitData;
  metadata: WorkUnitMetadata;
  resumeSessionId: string | null;
  metadataUpdates: Partial<WorkUnitMetadata>;
}

export interface StepPromptResolution {
  composed: ComposedStepPrompt;
  composeDeps: PromptComposerDeps;
}

/** 组装本步 prompt/注入上下文，并汇总 matchedSkills 与 hint 消费增量。 */
export async function composeAgentStepPrompt(
  input: StepPromptInput,
  host: AgentLoopHost,
): Promise<StepPromptResolution> {
  const { target, wu, metadata, resumeSessionId, metadataUpdates } = input;
  // prompt 组装与上下文注入（hint 读取/注入/消费清除、skill > persona > roster > knowledge
  // 共用分段软定额注入）已抽到 ./prompt-composer.js（2026-08 工单 05）——agentStep 只保留编排。
  // #95: 续用判定在 worktree 解析后、prompt 组装前完成 —— isNewSession（续用不命中）决定
  // 是否注入「前序进展」段与回放 waitingQuestion。
  const composeDeps = {
    role: host.role, acceptedTypes: host.acceptedTypes, fileStore: host.fileStore,
    resolveEventsFile: resolveStudioEventsFile,
  };
  const composed = await composeStepPrompt(
    { wu, metadata, newReplies: target.newReplies?.map(r => r.content), isNewSession: !resumeSessionId },
    composeDeps,
  );
  const { skillMatched } = composed;
  if (skillMatched.length > 0) {
    // 决策 7: step 时匹配名单落盘 metadata.matchedSkills（随 recordResult 原子写入，
    // 供 skill-demotion 成功率与被无视率度量——替代原 claim 时 fire-and-forget 落盘，消竞态）
    metadataUpdates.matchedSkills = skillMatched;
  }
  // 已消费 hint（pendingReplies/commitGuardHint/verifyFailHint/childGuardHint/processCheckHint）的清除增量
  // （undefined 在 JSON 序列化时丢弃，清除避免后续步骤重复注入）
  Object.assign(metadataUpdates, composed.consumedHintUpdates);
  return { composed, composeDeps };
}
