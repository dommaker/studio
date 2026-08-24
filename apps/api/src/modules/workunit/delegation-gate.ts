/**
 * DelegationGate — A2A 协作委派闸门（2026-07-agent-to-agent-collab-design §4.1 机制 3 / §4.2）
 *
 * 纯代码零 LLM：recordResult 的 DELEGATE 分支在创建子 WorkUnit 前调用。
 * 循环是输入校验问题（创建时刻拦截），运行时不需要兜底。
 *
 * 校验项（任一不满足即拒绝，附人类可读原因）：
 *  1. 目标 profile 存在、active、且是父 WU 频道成员（members 为空 → 允许任意 active profile，
 *     与 message-routing 的过渡期口径一致）；
 *  2. 目标 ≠ 派出方（禁止自派生）；
 *  3. 深度：父 collab.depth（根=0）+ 1 ≤ MAX_DEPTH（P1 = 1，STUDIO_COLLAB_MAX_DEPTH 覆盖）；
 *  4. 宽度：父 collab.delegationCount < 3；
 *  5. 树规模：共享 collab.rootId 的 WU 数（含根）< 8；
 *  6. 环：目标 profile id 不在父 collab.chain 中（A→B→A 在 B 回派时被拦）；
 *  7. 重复：同（父 WU, 目标 profile）不存在未完结（非 done/closed）子 WU；
 *  8. 预算：checkTreeBudget() —— P1 留桩（TODO §4.3 P2 接通）。
 */
import * as os from 'os';
import * as path from 'path';
import { FileStore, logger, parseChannels, type AgentProfileData } from '@dommaker/studio-shared';
import type { WorkUnitData, WorkUnitMetadata } from './workunit.service.js';
import { parseWuMetadata } from './wu-metadata.js';
import { resolveStudioLogFile } from '../../utils/studio-log-path.js';
import { syncTokenLedger } from '../../utils/token-ledger.js';

/** 协作元数据（WorkUnitMetadata.collab 的具象类型） */
export type CollabMeta = NonNullable<WorkUnitMetadata['collab']>;

/** §4.2 每父 WU 委派次数上限（宽度） */
export const MAX_DELEGATIONS_PER_PARENT = 3;
/** §4.2 协作树总 WU 数上限（含根） */
export const MAX_TREE_SIZE = 8;

/** §4.2 深度上限：P2 = 2（根->子->孙三层），env STUDIO_COLLAB_MAX_DEPTH 覆盖（可配置 1–3） */
export function resolveMaxDepth(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.STUDIO_COLLAB_MAX_DEPTH);
  return Number.isInteger(raw) && raw >= 1 ? raw : 2;
}

/** 从 metadata JSON 串容错解析 collab（损坏/缺失 → null） */
export function readCollab(metadataRaw: string | null | undefined): CollabMeta | null {
  const c = parseWuMetadata(metadataRaw).collab;
  if (!c || typeof c.rootId !== 'string' || typeof c.depth !== 'number' || !Array.isArray(c.chain)) return null;
  return c;
}

/**
 * 父 WU 的 collab 口径：无 collab（尚未委派过的根/普通 WU）按
 * `{ rootId: 自身 id, depth: 0, chain: [派出方 profileId], delegationCount: 0 }` 视之。
 */
export function effectiveParentCollab(parent: WorkUnitData, delegatorProfileId: string): CollabMeta {
  return readCollab(parent.metadata) ?? {
    rootId: parent.id,
    depth: 0,
    chain: [delegatorProfileId],
    delegationCount: 0,
  };
}

export interface DelegationCheckInput {
  fileStore: FileStore;
  /** 父 WU（DELEGATE 所在的当前 WU） */
  parent: WorkUnitData;
  /** 派出方 profile（当前 loop 的角色） */
  delegator: AgentProfileData;
  /** DELEGATE 协议中的目标 profile 名 */
  targetName: string;
}

export interface DelegationCheckResult {
  pass: boolean;
  /** 拒绝原因（人类可读，进入 NEED_INPUT 卡片） */
  reason?: string;
  /** 通过时解析出的目标 profile */
  target?: AgentProfileData;
}

/**
 * TODO(§4.3 P2): 树级预算闸门 —— 按 collab.rootId 聚合 studio-events.jsonl 的
 * workunit:tokens（executionTokens），`树已耗 + 子 WU 预估 ≤ TREE_TOKEN_BUDGET(400K)`。
 * P1 留桩恒通过。
 */
/** §4.3 树级 token 预算上限 */
export const TREE_TOKEN_BUDGET = 400_000;

const STUDIO_EVENTS_JSONL = resolveStudioLogFile('studio-events.jsonl');

/**
 * §4.3 P2 树级预算闸门：树已耗 ≤ TREE_TOKEN_BUDGET(400K)。
 * 子 WU 预估取 0（TODO 后续基于历史均值）。
 * #320：树已耗改读 token 账本（per-WU 累计，O(树内 WU 数)），不再每次委派全扫
 * studio-events.jsonl 逐行 parse payload；账本落后由 syncTokenLedger 增量补扫自愈。
 * 兜底语义不变：事件文件不存在/同步失败 -> treeTotal=0，pass。
 */
export async function checkTreeBudget(
  rootId: string,
  fileStore: FileStore,
): Promise<{ pass: boolean; reason?: string; treeTotal: number }> {
  const snapshots = await fileStore.getIndex();
  const treeWuIds = new Set<string>([rootId]);
  for (const s of snapshots) {
    const collab = readCollab(s.metadata);
    if (collab?.rootId === rootId) treeWuIds.add(s.id);
  }

  let treeTotal = 0;
  try {
    const ledger = await syncTokenLedger(STUDIO_EVENTS_JSONL);
    for (const wuId of treeWuIds) {
      treeTotal += ledger.byWorkUnit[wuId]?.executionTokens ?? 0;
    }
  } catch (err) {
    // 同步失败 -> treeTotal=0，pass（与原全扫实现的读失败兜底一致）；
    // #320 review：账本锁超时等新失败路径须留痕，不静默
    logger.warn('[DelegationGate] token 账本同步失败，树预算按 0 放行', { error: String(err) });
  }

  if (treeTotal > TREE_TOKEN_BUDGET) {
    return {
      pass: false,
      reason: `协作树预算超限（已耗 ${treeTotal} / 上限 ${TREE_TOKEN_BUDGET}）`,
      treeTotal,
    };
  }
  return { pass: true, treeTotal };
}

/** 委派闸门主入口：按序校验，首个失败项即返回 */
export async function checkDelegation(input: DelegationCheckInput): Promise<DelegationCheckResult> {
  const { fileStore, parent, delegator, targetName } = input;

  // 1. 目标 profile 存在且 active
  const activeProfiles = await fileStore.listProfiles({ status: 'active' });
  const target = activeProfiles.find(p => p.name === targetName) ?? null;
  if (!target) {
    return { pass: false, reason: `目标 @${targetName} 不存在或未激活` };
  }

  // 1b. 频道成员约束（members 为空 → 过渡期放行任意 active profile，同 message-routing）
  if (parent.channelId) {
    const channel = await fileStore.getChannel(parent.channelId);
    const memberIds = parseChannels(channel?.members);
    if (memberIds.length > 0 && !memberIds.includes(target.id)) {
      return { pass: false, reason: `目标 @${targetName} 不是本频道成员` };
    }
  }

  // 2. 禁止自派生
  if (target.id === delegator.id) {
    return { pass: false, reason: '不能委派给自己' };
  }

  const parentCollab = effectiveParentCollab(parent, delegator.id);

  // 3. 深度上限
  const maxDepth = resolveMaxDepth();
  if (parentCollab.depth + 1 > maxDepth) {
    return { pass: false, reason: `超过委派深度上限（${maxDepth}）` };
  }

  // 4. 宽度上限（每父委派次数）
  if ((parentCollab.delegationCount ?? 0) >= MAX_DELEGATIONS_PER_PARENT) {
    return { pass: false, reason: `本任务委派次数已达上限（${MAX_DELEGATIONS_PER_PARENT}）` };
  }

  const snapshots = await fileStore.getIndex();

  // 5. 树规模上限（按 rootId 计数，含根自身）
  const treeSize = snapshots.filter(s =>
    s.id === parentCollab.rootId || readCollab(s.metadata)?.rootId === parentCollab.rootId
  ).length;
  if (treeSize >= MAX_TREE_SIZE) {
    return { pass: false, reason: `协作树规模已达上限（${MAX_TREE_SIZE}）` };
  }

  // 6. 环检测（谱系 chain 为 profile id 序列）
  if (parentCollab.chain.includes(target.id)) {
    return { pass: false, reason: `目标 @${targetName} 已在委派链中（防止循环委派）` };
  }

  // 7. 重复委派：同（父, 目标）存在未完结子 WU
  //    注：claim 后 assigneeId 被改写为 instance id（§1.2-b），故同时比对 collab.chain 末位（profile id）
  const duplicate = snapshots.some(s => {
    if (s.parentId !== parent.id) return false;
    if (s.status === 'done' || s.status === 'closed') return false;
    if (s.assigneeId === target.id) return true;
    const childChain = readCollab(s.metadata)?.chain;
    return Array.isArray(childChain) && childChain[childChain.length - 1] === target.id;
  });
  if (duplicate) {
    return { pass: false, reason: `已存在委派给 @${targetName} 的未完结子任务` };
  }

  // 8. 预算：按 rootId 聚合 studio-events.jsonl 的 executionTokens
  const budget = await checkTreeBudget(parentCollab.rootId, fileStore);
  if (!budget.pass) {
    return { pass: false, reason: budget.reason ?? '协作树预算超限' };
  }

  return { pass: true, target };
}
