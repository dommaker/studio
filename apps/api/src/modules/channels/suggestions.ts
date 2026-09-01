/**
 * #443（spec #441 情境引导 02）：频道建议推导骨架 —— 只读状态说明（status 形态）端到端。
 *
 * 派生端点 GET /channels/:id/suggestions 的数据源；不落库，每次按当前事实现算。
 * 推导输入 = 自动化的同一批事实：
 *   - 频道 WU 快照（FileStore.getIndex：review 子工单存在性/租约活性、updatedAt）
 *   - loop 活跃度：复用既有心跳聚合 summarizeRoleStates（INSTANCE_ALIVE_TIMEOUT_MS 单源，不另设）
 *   - 频道 members（parseChannels）
 * 状态列口径复用 shared 包 deriveDisplayState；「频道当前工单」拣选（原前端 wuSuggestions
 * pickCurrentWu）随本模块后端化（前端本地副本由 #447 删除，口径单源在本模块）。
 *
 * fail-closed：每条建议带前置条件，不满足/拿不准不出。本票只交付 status 形态
 * （自动评审在途的只读说明）；action 形态见 #444/#445，prompt 形态后端化见 #446。
 * 顶层容错：任何一步失败 → 空结果 + warn，派生绝不抛出（同 current-pmo 原则）。
 */
import { logger, parseChannels, deriveDisplayState, FileStore, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { summarizeRoleStates } from '../agents/agent-instance.service.js';
import { DECISION_SPEC_TYPES } from '../workunit/workunit.types.js';
import { parseWuMetadata } from '../workunit/wu-metadata.js';

/**
 * 宽限期阈值集中配置（#441 决议：断链/无接管判定带宽限期，阈值集中一处，
 * 默认值对照既有节奏——claim 轮询 15s、对账扫描 5min、waiting 提醒 30min 档——不发明新量级）。
 * loop 活跃窗口不在此列：唯一来源是 agent-instance.service 的 INSTANCE_ALIVE_TIMEOUT_MS。
 */
export const SUGGESTION_TIMING = {
  /** 评审派单在飞宽限：父 WU 转入 in_review 后该窗口内未见子单仍视为「自动化在途」（对齐对账扫描 5min 周期档） */
  reviewDispatchInFlightGraceMs: 5 * 60 * 1000,
} as const;

/** 建议三形态（#441）：status 只读说明 / action 确定性动作 / prompt 预填建议 */
export type ChannelSuggestionKind = 'status' | 'action' | 'prompt';

export interface ChannelSuggestion {
  /** 模板锚：前端按 id 选文案模板渲染（后端不出自由文案，只给结构化参数） */
  id: string;
  kind: ChannelSuggestionKind;
  /** 文案模板参数（wuId/wuTitle 等工单上下文） */
  params: Record<string, string>;
}

export interface ChannelSuggestionsResult {
  currentWuId: string | null;
  suggestions: ChannelSuggestion[];
}

export interface ChannelSuggestionsDeps {
  fileStore?: FileStore;
  /** 测试注入：推导「现在」时刻（宽限/租约判定锚点） */
  now?: Date;
}

const EMPTY: ChannelSuggestionsResult = { currentWuId: null, suggestions: [] };

/** 不可自动评审的 WU 类型（同 ReviewDispatcher 路径 A / dispatch-reconciliation 口径） */
function isAutoReviewable(wu: WorkUnitSnapshot): boolean {
  return wu.type !== 'review' && wu.type !== 'analysis' && !DECISION_SPEC_TYPES.has(wu.type);
}

/**
 * 频道当前 WU = 非终态（派生列非 done/closed）中 updatedAt 最新者；全终态回退最新者；空 → null。
 * 终态判定走 deriveDisplayState 派生列（done 缺 l3 = in_review 仍算非终态），不读裸 status。
 * （口径与前端 #440 pickCurrentWu 一致，本函数为后端单源。）
 *
 * 引导语义修正（#443）：review 子单是自动化的内部执行单元，不作引导的「当前工单」——
 * 否则父单一进 in_review 子单即建、updatedAt 恒新，当前工单永远是子单，
 * 「等待自动评审」状态说明永远不触发（前端静态版即有此盲区）。故拣选时排除
 * review 子单；频道内只剩 review 子单时回退全集口径（不编造）。
 */
function pickCurrentWuSnapshot(wus: WorkUnitSnapshot[]): WorkUnitSnapshot | null {
  if (wus.length === 0) return null;
  const byUpdatedDesc = (list: WorkUnitSnapshot[]) =>
    [...list].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const terminal = (w: WorkUnitSnapshot) => {
    const c = deriveDisplayState({ status: w.status, metadata: w.metadata }).column;
    return c === 'done' || c === 'closed';
  };
  const isReviewChild = (w: WorkUnitSnapshot) => w.type === 'review' && w.parentId !== null;
  const mainline = wus.filter(w => !isReviewChild(w));
  const candidates = mainline.length > 0 ? mainline : wus;
  const byUpdated = byUpdatedDesc(candidates);
  return byUpdated.find(w => !terminal(w)) ?? byUpdated[0];
}

/** 未完结 review 子单（同 dispatch-reconciliation / #442 判据：parentId 命中 + type=review + 非 done/closed） */
function findUnfinishedReviewChild(wus: WorkUnitSnapshot[], parentId: string): WorkUnitSnapshot | null {
  return wus.find(s =>
    s.parentId === parentId && s.type === 'review' && s.status !== 'done' && s.status !== 'closed',
  ) ?? null;
}

/** 子单租约活性：claimed 且 timeoutAt 未到期 = 持有方 loop 在心跳（30s/跳，5min TTL） */
function leaseAlive(wu: WorkUnitSnapshot, now: Date): boolean {
  if (!wu.claimedAt || !wu.timeoutAt) return false;
  const t = Date.parse(wu.timeoutAt);
  return Number.isFinite(t) && t > now.getTime();
}

/** 频道成员 loop 在线判定：复用既有心跳聚合（5min 窗口单源 INSTANCE_ALIVE_TIMEOUT_MS） */
async function hasOnlineMemberLoop(fileStore: FileStore, memberIds: string[]): Promise<boolean> {
  if (memberIds.length === 0) return false;
  const { onlineRoleIds } = await summarizeRoleStates(fileStore, memberIds);
  return onlineRoleIds.size > 0;
}

/**
 * 推导频道建议。fail-closed：前置条件不满足/事实缺失/读取失败 → 空结果。
 */
export async function deriveChannelSuggestions(
  channelId: string,
  deps: ChannelSuggestionsDeps = {},
): Promise<ChannelSuggestionsResult> {
  const fileStore = deps.fileStore ?? new FileStore();
  const now = deps.now ?? new Date();
  try {
    const channel = await fileStore.getChannel(channelId);
    if (!channel) return EMPTY;

    const channelWus = (await fileStore.getIndex()).filter(s => s.channelId === channelId);
    const current = pickCurrentWuSnapshot(channelWus);
    if (!current) return EMPTY;

    const { column } = deriveDisplayState({ status: current.status, metadata: current.metadata });
    // 本票只交付「自动评审在途」一条 status 形态；其余列不出片
    if (column !== 'in_review' || !isAutoReviewable(current)) {
      return { currentWuId: current.id, suggestions: [] };
    }

    const child = findUnfinishedReviewChild(channelWus, current.id);
    const memberIds = parseChannels(channel.members);
    const online = await hasOnlineMemberLoop(fileStore, memberIds);

    // 自动化在途 = 有未完结子单且（子单租约活 或 有在线 loop 会认领）
    //           或 无子单但转入在宽限内且有在线 loop（路径 A 派单在飞）
    const inFlight = child
      ? leaseAlive(child, now) || online
      : online && now.getTime() - Date.parse(current.updatedAt) < SUGGESTION_TIMING.reviewDispatchInFlightGraceMs;
    if (!inFlight) return { currentWuId: current.id, suggestions: [] }; // 无接管/断链：fail-closed 不出

    const meta = parseWuMetadata(current.metadata);
    return {
      currentWuId: current.id,
      suggestions: [{
        id: 'auto-review-in-flight',
        kind: 'status',
        params: { wuId: current.id, wuTitle: meta.title ?? current.scope ?? current.id },
      }],
    };
  } catch (err) {
    logger.warn('[ChannelSuggestions] derive failed (fail-closed → empty)', { channelId, error: String(err) });
    return EMPTY;
  }
}
