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
 * fail-closed：每条建议带前置条件，不满足/拿不准不出。本模块交付三种形态：
 * status（自动评审在途的只读说明，#443）与 action（断链「补派评审」直调
 * dispatch-review，#444；无人认领「认领」直调 claim 端点认领即发声原语，#445）；
 * prompt（#446）：发给 agent 的自然语言任务——「诊断阻塞」（blocked 且无
 * waitingForInput 且无 loop 在处理）与「转写审查清单」（前置门禁窗口：评审未派发），
 * 预填指令本体由 text 字段承载，点击预填进输入框、人可编辑后发送，走既有 @mention
 * 消息路由（不建确定性接口）。
 * 顶层容错：任何一步失败 → 空结果 + warn，派生绝不抛出（同 current-pmo 原则）。
 */
import { logger, parseChannels, deriveDisplayState, FileStore, type WorkUnitSnapshot } from '@dommaker/studio-shared';
import { summarizeRoleStates } from '../agents/agent-instance.service.js';
import { MANUAL_GATE_TYPES } from '../workunit/workunit.types.js';
import { parseWuMetadata } from '../workunit/wu-metadata.js';
import { summarizeBlockReason } from '../workunit/blocked-cta.js';

/**
 * 宽限期阈值集中配置（#441 决议：断链/无接管判定带宽限期，阈值集中一处，
 * 默认值对照既有节奏——claim 轮询 15s、对账扫描 5min、waiting 提醒 30min 档——不发明新量级）。
 * loop 活跃窗口不在此列：唯一来源是 agent-instance.service 的 INSTANCE_ALIVE_TIMEOUT_MS。
 */
export const SUGGESTION_TIMING = {
  /** 评审派单在飞宽限：父 WU 转入 in_review 后该窗口内未见子单仍视为「自动化在途」（对齐对账扫描 5min 周期档） */
  reviewDispatchInFlightGraceMs: 5 * 60 * 1000,
  /** 无人认领宽限（#445）：WU unassigned 且有在线成员 loop 时，该窗口内不出认领片
   *  （claim 轮询 15s 节奏下在线 loop 大概率已涌现认领；对齐对账扫描 5min 档，不发明新量级） */
  unassignedClaimGraceMs: 5 * 60 * 1000,
  /** currentWu 拣选粘性窗口（#487）：现任非终态时，挑战者 updatedAt 须领先现任超过该窗口
   *  才切换——loop 每步 metadata 簿记都 bump updatedAt，多单并行交替簿写不应让
   *  阶段条/引导片来回跳。对齐对账扫描 5min 档，不发明新量级。 */
  currentWuStickyMs: 5 * 60 * 1000,
} as const;

/** 建议三形态（#441）：status 只读说明 / action 确定性动作 / prompt 预填建议 */
export type ChannelSuggestionKind = 'status' | 'action' | 'prompt';

export interface ChannelSuggestion {
  /** 模板锚：前端按 id 选文案模板渲染（后端不出自由展示文案，只给结构化参数） */
  id: string;
  kind: ChannelSuggestionKind;
  /** 文案模板参数（wuId/wuTitle 等工单上下文） */
  params: Record<string, string>;
  /**
   * prompt 形态专用（#446）：预填进输入框的指令本体（发给 agent 的自然语言任务）。
   * 由后端承载 = 单一正本，契约测试在本仓后端断言「经 @mention 路由可解析出目标角色」
   * （前端模板注册表只渲染展示文案 label/hint，不持有指令本体）。
   */
  text?: string;
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

/** 不可自动评审的 WU 类型（同 ReviewDispatcher 路径 A / dispatch-reconciliation 口径；#471 含 plan） */
function isAutoReviewable(wu: WorkUnitSnapshot): boolean {
  return wu.type !== 'review' && !MANUAL_GATE_TYPES.has(wu.type);
}

/**
 * currentWu 现任记忆（#487）：进程内 per-channel 粘性，不落库——派生仍是纯推导，
 * 进程重启即按当前事实重选（与「不落库每次现算」语义一致，粘性只是抗抖动的滞后）。
 * 无状态的阈值规则无法区分「现任自己簿写 bump」与「挑战者超车」（对称规则两者同形），
 * 故粘性必须记忆现任；进程内 Map 是最小实现。key = channelId，value = 现任 wuId；
 * 现任从候选集消失（换频道数据/终态让位）时自然被覆盖，无需清理。
 */
const currentWuIncumbent = new Map<string, string>();

/**
 * 频道当前 WU = 非终态（派生列非 done/closed）中 updatedAt 最新者；全终态回退最新者；空 → null。
 * 终态判定走 deriveDisplayState 派生列（done 缺 l3 = in_review 仍算非终态），不读裸 status。
 * （口径与前端 #440 pickCurrentWu 一致，本函数为后端单源。）
 *
 * 引导语义修正（#443）：review 子单是自动化的内部执行单元，不作引导的「当前工单」——
 * 否则父单一进 in_review 子单即建、updatedAt 恒新，当前工单永远是子单，
 * 「等待自动评审」状态说明永远不触发（前端静态版即有此盲区）。故拣选时排除
 * review 子单；频道内只剩 review 子单时回退全集口径（不编造）。
 *
 * 粘性（#487）：现任非终态且仍在候选集时，仅当挑战者 updatedAt 领先现任超过
 * SUGGESTION_TIMING.currentWuStickyMs 才切换（现任长时间静默 = 粘性解除）；
 * 现任终态/消失立即让位给最新候选。
 */
function pickCurrentWuSnapshot(wus: WorkUnitSnapshot[], channelId: string): WorkUnitSnapshot | null {
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
  const fresh = byUpdated.find(w => !terminal(w)) ?? byUpdated[0];

  const incumbentId = currentWuIncumbent.get(channelId);
  const incumbent = incumbentId ? candidates.find(w => w.id === incumbentId) : undefined;
  let picked = fresh;
  if (incumbent && !terminal(incumbent)) {
    // 现任仍活跃：挑战者（fresh = 非终态最新者）领先未超窗口 → 保持现任抗抖动；
    // 领先超窗口 = 现任已长时间静默 → 切换。fresh 即现任时 leadMs=0，天然保持。
    const leadMs = Date.parse(fresh.updatedAt) - Date.parse(incumbent.updatedAt);
    if (leadMs <= SUGGESTION_TIMING.currentWuStickyMs) picked = incumbent;
  }
  currentWuIncumbent.set(channelId, picked.id);
  return picked;
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

/**
 * blockReason → 片上展示用摘要（#446）：summarizeBlockReason 截断 120 字符后
 * 剥机器类型前缀（timeout:/stuck:/verify-failed/need-input: 等）——频道消息保留前缀
 * 便于检索，引导片文案说人话（spec 用户故事 9）。空前缀剥光 → 返回空（不编造原因）。
 */
function displayBlockReason(blockReason?: string): string {
  const summarized = summarizeBlockReason(blockReason);
  return summarized.replace(/^[a-z][a-z0-9-]*:\s*/i, '').trim();
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
    const current = pickCurrentWuSnapshot(channelWus, channelId);
    const memberIds = parseChannels(channel.members);
    if (!current) {
      // #465（首用路径断点）：空转频道（无当前工单）且成员为空 → 出只读提示片。
      // 新装三默认频道正是此态——角色不进频道等于不存在（mention 以 members 为界、
      // loop 认领同口径）。有工单在跑的频道由既有引导片覆盖，不叠加本片。
      if (memberIds.length === 0) {
        return { currentWuId: null, suggestions: [{ id: 'channel-no-members', kind: 'status', params: {} }] };
      }
      return EMPTY;
    }

    const meta = parseWuMetadata(current.metadata);
    const wuTitle = meta.title ?? current.scope ?? current.id;

    // #445（spec #441 动作形态第二种）：当前工单 unassigned → 「认领」动作片，
    // 点击经确认直调 claim 端点（认领即发声原语，与 loop 自动认领同一路径）。
    // 出片守卫与端点同口径：端点唯一确定性拒绝 = status !== 'unassigned'（409），故只看裸 status。
    // 双向：有在线成员 loop 且未超宽限 → 不出（涌现认领大概率在途，不催人工）；
    //       无在线 loop（无人接管）或已超宽限（loop 迟迟未认领）→ 出。
    // 生效即消失：claim 成功 → active，前置条件转假。
    if (current.status === 'unassigned') {
      const online = await hasOnlineMemberLoop(fileStore, memberIds);
      const ageMs = now.getTime() - Date.parse(current.updatedAt);
      if (online && ageMs < SUGGESTION_TIMING.unassignedClaimGraceMs) {
        return { currentWuId: current.id, suggestions: [] };
      }
      return {
        currentWuId: current.id,
        suggestions: [{
          id: 'claim-wu',
          kind: 'action',
          params: { wuId: current.id, wuTitle },
        }],
      };
    }

    const { column, evidence } = deriveDisplayState({ status: current.status, metadata: current.metadata });

    // #446（spec #441 prompt 形态第一种）：blocked → 「诊断阻塞」prompt 片，
    // 点击预填进输入框、人可编辑后发送，走既有 @mention 消息路由（不建确定性接口）。
    // 双向守卫：waitingForInput 人闸挂起不出（NeedInputOptions 内嵌回复覆盖，不重复出片）；
    // 当前 WU 租约仍活 = loop 在处理，不出（不催人工）。blocked WU 不会被 loop 自动拾起
    // （复活靠回复/显式 resume），故「在处理」只看本 WU 租约，不看频道在线 loop。
    if (column === 'blocked') {
      if (meta.waitingForInput) return { currentWuId: current.id, suggestions: [] };
      if (leaseAlive(current, now)) return { currentWuId: current.id, suggestions: [] };
      const blockReason = displayBlockReason(meta.blockReason);
      return {
        currentWuId: current.id,
        suggestions: [{
          id: 'diagnose-blocked',
          kind: 'prompt',
          params: { wuId: current.id, wuTitle, ...(blockReason ? { blockReason } : {}) },
          text: `@developer 诊断《${wuTitle}》的阻塞原因并给出修复方案`,
        }],
      };
    }

    // 自动评审在途（status）/ 断链补派（action）/ 前置门禁转写清单（prompt）都只挂在 in_review 列；其余列不出片
    if (column !== 'in_review' || !isAutoReviewable(current)) {
      return { currentWuId: current.id, suggestions: [] };
    }

    const child = findUnfinishedReviewChild(channelWus, current.id);
    const ageMs = now.getTime() - Date.parse(current.updatedAt);

    // #444（spec #441 动作形态第一种）：断链 = 无未完结 review 子单且转入已超宽限
    // （自动化该派未派）→ 出「补派评审」动作片，前端点击经确认后直调 dispatch-review
    // 端点（与 ReviewDispatcher 自动派发同原语 dispatchReviewNow）。fail-closed：
    //   - l2 已达成不出（端点必拒——不出点了必失败的动作）；
    //   - 子单存在但僵死（租约过期无接管）不出——补派会被同父唯一性 409，非本动作可修。
    if (!child && ageMs >= SUGGESTION_TIMING.reviewDispatchInFlightGraceMs) {
      if (evidence.l2) return { currentWuId: current.id, suggestions: [] };
      return {
        currentWuId: current.id,
        suggestions: [{
          id: 'redispatch-review',
          kind: 'action',
          params: { wuId: current.id, wuTitle },
        }],
      };
    }

    // #446（spec #441 prompt 形态第二种）：前置门禁窗口 = 无未完结子单且未超宽限
    // （评审未派发）→ 出可选「转写审查清单」prompt 片（文案标注「可选」）；
    // 评审在途（有未完结子单）不出，超宽限断链不出（上方动作分支的位置），
    // l2 已达成不出（评审结论已存在，无可转写对象——同动作片 fail-closed 口径）。
    // 有在线 loop 时与「等待自动评审」状态片并存：自动化照常推进，人可选先转写清单；
    // 无在线 loop 时状态片不出，但窗口内仍出清单片（@mention 建单后 loop 上线即认领）。
    if (!child) {
      if (evidence.l2) return { currentWuId: current.id, suggestions: [] };
      const checklistChip: ChannelSuggestion = {
        id: 'transcribe-review-checklist',
        kind: 'prompt',
        params: { wuId: current.id, wuTitle },
        text: `@reviewer 把《${wuTitle}》的验收标准转写成审查清单`,
      };
      const online = await hasOnlineMemberLoop(fileStore, memberIds);
      if (!online) return { currentWuId: current.id, suggestions: [checklistChip] }; // 派单在飞无人接：fail-closed 不出状态片
      return {
        currentWuId: current.id,
        suggestions: [
          { id: 'auto-review-in-flight', kind: 'status', params: { wuId: current.id, wuTitle } },
          checklistChip,
        ],
      };
    }

    const online = await hasOnlineMemberLoop(fileStore, memberIds);

    // 自动化在途 = 有未完结子单且（子单租约活 或 有在线 loop 会认领）
    const inFlight = leaseAlive(child, now) || online;
    if (!inFlight) return { currentWuId: current.id, suggestions: [] }; // 无接管/拿不准：fail-closed 不出

    return {
      currentWuId: current.id,
      suggestions: [{
        id: 'auto-review-in-flight',
        kind: 'status',
        params: { wuId: current.id, wuTitle },
      }],
    };
  } catch (err) {
    logger.warn('[ChannelSuggestions] derive failed (fail-closed → empty)', { channelId, error: String(err) });
    return EMPTY;
  }
}
