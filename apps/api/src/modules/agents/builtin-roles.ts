/**
 * B4a 内置角色 seed（决策 D7/D8）— pm / dev / reviewer
 *
 * 启动时幂等确保三个内置 AgentProfile 存在且可用：
 * - 已存在不覆盖（用户可改 description/provider，seed 只补缺失）；
 * - status 被用户改 inactive 就尊重（内置角色可禁用，不自动复活）。
 *
 * description 末尾的英文关键词是 acceptedTypes 来源
 * （agent-loop.ts parseAcceptedTypes / skill-selector.ts TYPE_KEYWORDS
 * 按 description 子串解析 task/bug/feature/refactor/test/docs/review/analysis）。
 * reviewer 的 description 必须含 'reviewer' 字样 ——
 * ReviewDispatcher.findReviewerInChannel 按 description 含 reviewer 匹配。
 *
 * 与 ensureStudioProfile 同：直接 fileStore.createProfile，不发
 * agent-profile.created 事件（非用户创建；启动批量 mount 会接管）。
 */
import { randomUUID } from 'crypto';
import { logger, FileStore, parseChannels, type AgentProfileData } from '@dommaker/studio-shared';

export interface BuiltinRoleSpec {
  name: string;
  description: string;
}

/** @studio 改派目标（决策 D7）：用户 @studio 的消息路由给 pm */
export const PM_ROLE_NAME = 'pm';

export const BUILTIN_ROLES: readonly BuiltinRoleSpec[] = [
  { name: 'pm', description: '需求澄清、设计、拆解。analysis feature task' },
  { name: 'dev', description: '代码实现与修复。task bug feature refactor' },
  // 'reviewer' 字样是 ReviewDispatcher 的匹配锚点，删不得
  { name: 'reviewer', description: '独立评审（reviewer）：SDD 文档与代码 diff。review analysis' },
] as const;

/**
 * 幂等 seed：确保 pm/dev/reviewer 三个内置角色存在。
 * 已存在（含被用户禁用/改描述/改 provider）的原样保留。
 */
export async function ensureBuiltinRoles(fileStore: FileStore): Promise<AgentProfileData[]> {
  const all = await fileStore.listProfiles();
  const result: AgentProfileData[] = [];
  for (const spec of BUILTIN_ROLES) {
    const existing = all.find(p => p.name === spec.name);
    if (existing) {
      result.push(existing);
      continue;
    }
    const now = new Date().toISOString();
    const data: AgentProfileData = {
      id: randomUUID(),
      name: spec.name,
      description: spec.description,
      channels: '[]',
      provider: null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    await fileStore.createProfile(data);
    all.push(data); // 同步内存副本，保证单次运行内幂等
    logger.info('[BuiltinRoles] Seeded builtin role', { name: spec.name });
    result.push(data);
  }
  return result;
}

/**
 * 把三个内置角色加入指定频道 members（幂等：已是成员不重复加）。
 * 返回新增的 member 数。角色不存在（如全被删）时跳过该角色。
 */
export async function ensureBuiltinRoleMembers(
  fileStore: FileStore,
  channelId: string,
): Promise<number> {
  const channel = await fileStore.getChannel(channelId);
  if (!channel) return 0;

  const all = await fileStore.listProfiles();
  const memberIds = parseChannels(channel.members);
  let added = 0;
  for (const spec of BUILTIN_ROLES) {
    const role = all.find(p => p.name === spec.name);
    if (!role || memberIds.includes(role.id)) continue;
    memberIds.push(role.id);
    added++;
  }
  if (added > 0) {
    await fileStore.updateChannel(channelId, { members: JSON.stringify(memberIds) });
    logger.info('[BuiltinRoles] Added builtin roles to channel members', { channelId, added });
  }
  return added;
}

/**
 * 一次性迁移（启动时幂等执行）：对已绑定工程（config 有 defaultWorkspaceId）
 * 的存量频道补三个内置角色成员。
 */
export async function migrateBuiltinRolesToProjectChannels(
  fileStore: FileStore = new FileStore(),
): Promise<{ channelsUpdated: number; membersAdded: number }> {
  const channels = await fileStore.listChannels();
  let channelsUpdated = 0;
  let membersAdded = 0;
  for (const channel of channels) {
    if (!channel.defaultWorkspaceId) continue;
    const added = await ensureBuiltinRoleMembers(fileStore, channel.id);
    if (added > 0) {
      channelsUpdated++;
      membersAdded += added;
    }
  }
  if (channelsUpdated > 0) {
    logger.info('[BuiltinRoles] Migration done: builtin roles → project channels', {
      channelsUpdated,
      membersAdded,
    });
  }
  return { channelsUpdated, membersAdded };
}
