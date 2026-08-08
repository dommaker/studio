/**
 * A2A §4.1 DELEGATE 分支（2026-08 从 agent-loop.recordResult 抽出，行为一字不改）：
 * DelegationGate 纯代码校验（零 LLM）后的委派政策判定。
 *
 * 职责边界：
 *   - 本模块 = 委派政策：gate 校验 → 通过则建子单 + collab 元数据 + delegate 卡片文案
 *    （父 WU 状态不变，按 progress 继续）；拒绝则降级 NEED_INPUT + 「拟委派…需人工确认」文案。
 *   - agent-loop.recordResult = 编排：跑收口守卫链 → 调 handleDelegateBranch →
 *     新鲜度检查 → 单次原子写 → 状态迁移与频道通知（delegate 卡片走统一回帖路径，含新鲜度检查）。
 *
 * 可测试性：fileStore/role/建单全部经 deps 注入，单测用纯 ctx 对象驱动，无需 vi.mock 模块工厂。
 */

import { logger, FileStore, type AgentProfileData } from '@dommaker/studio-shared';
import {
  checkDelegation, effectiveParentCollab, resolveMaxDepth,
  type CollabMeta,
} from '../../workunit/delegation-gate.js';
import type { WorkUnitData, WorkUnitService } from '../../workunit/workunit.service.js';
import type { StepResult } from './agent-loop.types.js';

/** DELEGATE 分支输入。仅在 action === 'delegate' 且 result.delegate 存在时由 recordResult 调用。 */
export interface DelegateBranchCtx {
  wu: WorkUnitData;
  wuId: string;
  /** A2A §4.1: DELEGATE 协议解析结果 */
  delegate: { targetName: string; scope: string };
}

/** DELEGATE 分支外部依赖（loop 绑定状态下传：workUnitService.create 绑定方法）。 */
export interface DelegateBranchDeps {
  fileStore: FileStore;
  /** 委派方（本 loop 的 profile） */
  role: AgentProfileData;
  createWorkUnit: WorkUnitService['create'];
}

export interface DelegateBranchOutcome {
  /** 通过 → 'progress'（父 WU 继续推进自己的部分）；拒绝 → 'need_input'（请人裁决） */
  action: StepResult['action'];
  /** delegate 卡片 / 拟委派确认文案（recordResult 写回 result.summary，走统一回帖路径） */
  summary: string;
  /** 父 WU 补记/累加的 collab（仅通过时存在），由 recordResult 合进 guardUpdates 原子写 */
  collabUpdate?: CollabMeta;
}

/**
 * A2A §4.1: DELEGATE 分支 —— DelegationGate 纯代码校验（零 LLM）。
 * 通过：建子单 + collab 元数据 + delegate 卡片（父 WU 状态不变，按 progress 继续）；
 * 拒绝：降级 NEED_INPUT（现有 blocked 路径），频道发「拟委派…需人工确认」请人裁决。
 */
export async function handleDelegateBranch(
  ctx: DelegateBranchCtx,
  deps: DelegateBranchDeps,
): Promise<DelegateBranchOutcome> {
  const { wu, wuId, delegate } = ctx;
  const gate = await checkDelegation({
    fileStore: deps.fileStore,
    parent: wu,
    delegator: deps.role,
    targetName: delegate.targetName,
  });
  if (gate.pass && gate.target) {
    const parentCollab = effectiveParentCollab(wu, deps.role.id);
    const childCollab: CollabMeta = {
      rootId: parentCollab.rootId,
      depth: parentCollab.depth + 1,
      chain: [...parentCollab.chain, gate.target.id],
      delegatedBy: { profileId: deps.role.id, workUnitId: wuId },
      delegationCount: 0,
    };
    await deps.createWorkUnit({
      scope: delegate.scope,
      type: wu.type,
      parentId: wuId,
      assigneeId: gate.target.id, // unassigned 语义 = 目标 profile id（同 @mention 点名，§1.2-b）
      channelId: wu.channelId,
      projectPath: wu.projectPath,
      workspaceId: wu.workspaceId ?? null,
      reqId: wu.reqId ?? null,
      status: 'unassigned',
      metadata: { creationMode: 'agent-delegate', collab: childCollab },
    });
    // 父 WU 补记/累加 collab（根 WU 首次委派时从无 collab 合并为 depth=0 的根记录）
    const collabUpdate: CollabMeta = { ...parentCollab, delegationCount: (parentCollab.delegationCount ?? 0) + 1 };
    // delegate 卡片即本步的 progress 消息（走下方统一回帖路径，含新鲜度检查）
    const summary = `@${deps.role.name} 委派 @${gate.target.name}：${delegate.scope}（深度 ${childCollab.depth}/${resolveMaxDepth()}）`;
    logger.info(`[AgentLoop] Delegation created: ${wuId} → @${gate.target.name} (depth ${childCollab.depth})`);
    return { action: 'progress', summary, collabUpdate };
  }
  const summary = `拟委派 @${delegate.targetName}：${delegate.scope}，因 ${gate.reason ?? '未知原因'} 需人工确认`;
  logger.info(`[AgentLoop] Delegation rejected for ${wuId}: ${gate.reason}`);
  return { action: 'need_input', summary };
}
