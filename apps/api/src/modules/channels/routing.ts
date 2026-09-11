/**
 * #466: 频道级「阶段→角色」路由表 —— 单一解析/校验事实源。
 *
 * 背景（票体第一性分析）：模型选择已在 role.provider，缺的只是路由——自动派生单
 * 建单时全部 unassigned 回池涌现，没有机制表达「哪种活给哪个角色」。路由复用既有
 * 指名硬约束（assigneeId，agent-loop observe 排他邮箱），零新增认领机制。
 *
 * 语义（票体定稿）：
 *  - 未配置的阶段 → profileId=null（回池涌现，向后兼容）；
 *  - 配置了且角色 active 且为频道成员 → profileId=该角色（指名即硬约束）；
 *  - 配置了但角色被移出频道/inactive/已删除 → profileId=null + fallback 原因，
 *    由调用方回池涌现并发频道提醒（文案由 routingFallbackText 统一）。
 *  - 成员判定：channel.members 唯一事实源；members 空（历史频道未回填）回退
 *    profile.channels 过渡口径（agent-loop loadChannelMembers 同款）。
 *
 * 消费方：publish 建 plan 单（plan 档）、analysis-handoff TASK 拆派工与
 * workunit feature 展开（implement 档）、review-dispatcher 建评审单（review 档）。
 */
import { parseChannels, type ChannelData, type FileStore } from '@dommaker/studio-shared';

export const ROUTING_STAGES = ['plan', 'implement', 'review'] as const;
export type RoutingStage = (typeof ROUTING_STAGES)[number];
export type ChannelRouting = Partial<Record<RoutingStage, string | null>>;

/** 阶段人读标签（提醒文案用） */
export const ROUTING_STAGE_LABELS: Record<RoutingStage, string> = {
  plan: '规划',
  implement: '执行',
  review: '评审',
};

export type RoutingFallbackReason = 'not-found' | 'inactive' | 'not-member';

export interface StageRoutingResolution {
  /** 可落 assigneeId 的 profile id；null = 回池涌现 */
  profileId: string | null;
  /** 配置了但不可用时的回退原因（未配置时 undefined） */
  fallback?: RoutingFallbackReason;
  /** 配置角色的 name（提醒文案用；profile 已删除时缺省） */
  profileName?: string;
}

/** 解析频道某阶段的路由指名。任何失败都返回 profileId=null（回池涌现），不抛错 */
export async function resolveStageRouting(
  fileStore: FileStore,
  channelId: string,
  stage: RoutingStage,
): Promise<StageRoutingResolution> {
  const channel = await fileStore.getChannel(channelId).catch(() => null);
  const configured = channel?.routing?.[stage];
  if (!channel || !configured) return { profileId: null };

  const profile = await fileStore.getProfile(configured).catch(() => null);
  if (!profile) return { profileId: null, fallback: 'not-found' };
  if (profile.status !== 'active') {
    return { profileId: null, fallback: 'inactive', profileName: profile.name };
  }
  // 成员边界：members 非空 = 唯一事实源；空（历史频道）回退 profile.channels
  const members = parseChannels(channel.members);
  const isMember = members.length > 0
    ? members.includes(profile.id)
    : parseChannels(profile.channels).includes(channelId);
  if (!isMember) {
    return { profileId: null, fallback: 'not-member', profileName: profile.name };
  }
  return { profileId: profile.id, profileName: profile.name };
}

const FALLBACK_TEXT: Record<RoutingFallbackReason, string> = {
  'not-found': '角色已删除',
  'inactive': '角色已停用',
  'not-member': '角色已移出频道',
};

/** 回退提醒文案（频道出声统一口径）；仅在 resolution.fallback 存在时调用 */
export function routingFallbackText(stage: RoutingStage, resolution: StageRoutingResolution): string {
  const name = resolution.profileName ?? '（已删除）';
  const reason = FALLBACK_TEXT[resolution.fallback ?? 'not-found'];
  return `工单路由提醒：本频道「${ROUTING_STAGE_LABELS[stage]}」阶段路由到 @${name}，但${reason}，本单已回池涌现（频道成员自动认领）——请到频道设置调整路由表`;
}

/**
 * #497: fallback 提醒冷却窗——同频道同档同原因在窗内只出声一次。
 * 悬空指名在配置修复前会持续触发派生，不去重则提醒无限重复刷屏。
 * 进程内 Map（重启即重置）：提醒是配置修复信号，重启后补一条可接受，不漏路由回退本身。
 */
export const FALLBACK_REMINDER_COOLDOWN_MS = 60 * 60 * 1000;

const fallbackReminderSentAt = new Map<string, number>();

/**
 * #497: fallback 提醒冷却闸。返回 true = 放行并登记本次发送时刻（调用方随后
 * best-effort 发送，发送失败不补偿——漏一条优于刷屏）；false = 冷却窗内，跳过出声。
 */
export function shouldEmitFallbackReminder(
  channelId: string,
  stage: RoutingStage,
  resolution: StageRoutingResolution,
  now: number = Date.now(),
): boolean {
  const key = `${channelId}:${stage}:${resolution.fallback ?? 'none'}`;
  const last = fallbackReminderSentAt.get(key);
  if (last !== undefined && now - last < FALLBACK_REMINDER_COOLDOWN_MS) return false;
  fallbackReminderSentAt.set(key, now);
  return true;
}

/** 测试钩子：清空冷却表 */
export function resetFallbackReminderCooldown(): void {
  fallbackReminderSentAt.clear();
}

/**
 * #497: members 移出的指名漂移检查——被移出角色仍被 routing 档/入口角色指名时
 * 产出人读 warning（响应附带，不阻断；与 defaultProfileId/routing 校验只查存在性的严格度对齐）。
 */
export function buildMemberRemovalWarning(
  channel: Pick<ChannelData, 'routing' | 'defaultProfileId'>,
  removedIds: string[],
): string | undefined {
  if (removedIds.length === 0) return undefined;
  const stages = ROUTING_STAGES.filter(s => {
    const v = channel.routing?.[s];
    return v != null && removedIds.includes(v);
  });
  const namedDefault = channel.defaultProfileId != null && removedIds.includes(channel.defaultProfileId);
  if (stages.length === 0 && !namedDefault) return undefined;
  const parts: string[] = [];
  if (stages.length > 0) parts.push(`「${stages.map(s => ROUTING_STAGE_LABELS[s]).join('、')}」阶段路由`);
  if (namedDefault) parts.push('入口角色');
  return `成员移出提醒：被移出的角色仍被指名为本频道${parts.join('与')}，相关派单将回池涌现——请到频道设置调整配置`;
}

/**
 * PATCH/POST 入口校验（defaultProfileId 先例：只校验 active profile 存在性，
 * 不强制频道成员——成员边界在路由时判定）。
 *  - undefined → ok 无 value（跳过更新）
 *  - 非对象/数组/未知阶段键 → 拒绝
 *  - 值 '' / null → 清除该档（归一化为 null）
 *  - 值非空字符串 → 必须是已存在的 active profile id
 */
export async function validateRouting(
  fs: FileStore,
  value: unknown,
): Promise<{ ok: boolean; value?: ChannelRouting; error?: string }> {
  if (value === undefined) return { ok: true };
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, error: 'routing must be an object: { plan?, implement?, review? }' };
  }
  const result: ChannelRouting = {};
  const activeIds = new Set((await fs.listProfiles({ status: 'active' })).map(p => p.id));
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!(ROUTING_STAGES as readonly string[]).includes(key)) {
      return { ok: false, error: `routing 未知阶段键: ${key}（仅支持 plan/implement/review）` };
    }
    if (raw === '' || raw === null || raw === undefined) {
      result[key as RoutingStage] = null;
      continue;
    }
    if (typeof raw !== 'string') {
      return { ok: false, error: `routing.${key} must be a profile id string` };
    }
    if (!activeIds.has(raw)) {
      return { ok: false, error: `routing.${key}: AgentProfile not found or not active: ${raw}` };
    }
    result[key as RoutingStage] = raw;
  }
  return { ok: true, value: result };
}
