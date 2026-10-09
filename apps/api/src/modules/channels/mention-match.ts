/**
 * @mention 检测与匹配（自 message-routing.ts 拆出，#688）——纯函数，无 IO。
 *
 * 口径：
 * - §9.5：mention 匹配以 channel.members 为界——只能 @ 到本频道成员；
 *   members 为空（历史频道未回填）时回退全量 active profile 匹配。
 * - #632：系统角色（studio）不参与精确匹配与前缀兜底——@studio 按未匹配走
 *   「转自动认领」提示。
 * - #496：手打中文连写兜底——token 整体精确匹配失败时，对成员名做最长前缀匹配
 *   （@开发你好 → 命中成员「开发」）；多成员互为前缀取最长，等长歧义回退未匹配。
 *
 * 决策 11: 路由层不认识 skill——`+skill名` token 保留在 scope 原文，
 * 由 agent-loop step 时经 parseSkillHintsFromScope 解析（skill-selector.ts）。
 */
import { parseChannels, type AgentProfileData, type ChannelData } from '@dommaker/studio-shared';
import { STUDIO_ROLE_NAME, isSystemRole } from '../../core/system-role.js';

/** 匹配所需的最小 profile 形状（调用侧传完整 AgentProfileData 亦可）。 */
export type MentionProfileLike = Pick<AgentProfileData, 'id' | 'name'> & { kind?: AgentProfileData['kind'] };

export interface MentionMatch<T extends MentionProfileLike = MentionProfileLike> {
  /** 命中的成员 profile；未匹配（含等长歧义回退）为 null。 */
  agent: T | null;
  /** #496 前缀兜底命中的成员正名；精确匹配/未匹配为 null。 */
  prefixMatchName: string | null;
}

/**
 * Detect @mention in message content.
 * Returns the first matched name, or null if no @mention found.
 */
export function detectMention(content: string): string | null {
  // \w 只等价于 [A-Za-z0-9_]，中文等 Unicode 名字匹配不到 — 用 \p{L}/\p{N} 放宽
  const match = content.match(/@([\p{L}\p{N}_-]+)/u);
  return match ? match[1] : null;
}

/**
 * mentionName → 成员 profile 匹配（精确优先，#496 最长前缀兜底）。
 * channel 缺省或 members 为空 → 回退全量匹配（历史频道未回填口径）。
 */
export function matchMentionAgent<T extends MentionProfileLike>(
  profiles: T[],
  mentionName: string,
  channel: Pick<ChannelData, 'members'> | null | undefined,
): MentionMatch<T> {
  const memberIds = parseChannels(channel?.members);
  const inScope = (p: T) => memberIds.length === 0 || memberIds.includes(p.id);
  // #632：系统角色（studio）不参与精确匹配——@studio 永不建指向 studio 的 WU，
  // 按未匹配 mention 走「转自动认领」提示（defaultProfileId 转派分支已随 #632 退役）
  let agent = profiles.find(p => p.name === mentionName && inScope(p) && !isSystemRole(p)) ?? null;
  let prefixMatchName: string | null = null;
  // #496: 手打中文连写兜底——token 整体精确匹配失败时，对成员名做最长前缀匹配
  // （@开发你好 → 命中成员「开发」）。多成员互为前缀取最长；等长歧义（同名 profile
  // 并列最长）回退现状（未匹配 → #464 转自动认领提示）。studio 系统角色不参与前缀兜底。
  if (!agent && mentionName !== STUDIO_ROLE_NAME) {
    const candidates = profiles.filter(
      p => inScope(p) && !isSystemRole(p) && p.name.length > 0 && mentionName.startsWith(p.name),
    );
    if (candidates.length > 0) {
      const maxLen = Math.max(...candidates.map(p => p.name.length));
      const longest = candidates.filter(p => p.name.length === maxLen);
      if (longest.length === 1) {
        agent = longest[0];
        prefixMatchName = longest[0].name;
      }
    }
  }
  return { agent, prefixMatchName };
}

/**
 * 从消息正文剥离 @mention token 得到 scope。
 * #496: 前缀兜底命中时只剥 `@成员名`（保留连写剩余文本作为 scope，如 @开发你好 → 你好）；
 * 精确匹配/未匹配维持剥整个 @token。成员名字符集 ⊂ [\p{L}\p{N}_-]，内联进正则安全。
 */
export function stripMentionScope(content: string, prefixMatchName: string | null): string {
  return prefixMatchName
    ? content.replace(new RegExp(`@${prefixMatchName}\\s*`, 'u'), '')
    : content.replace(/@[\p{L}\p{N}_-]+\s*/u, '');
}
