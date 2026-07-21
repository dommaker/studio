/**
 * §9.5 成员关系统一 — 迁移：把各 profile.channels 合并进对应 channel.members。
 *
 * channel.members 为成员关系唯一事实源；profile.channels 字段过渡期保留
 * （deprecated，只读不删）。幂等：重复执行不会产生重复 members。
 */
import { logger, FileStore, parseChannels } from '@dommaker/studio-shared';

export interface MembersMigrationResult {
  /** 本次新并入 members 的 (profile, channel) 关系数 */
  merged: number;
}

export async function migrateProfileChannelsToMembers(
  fileStore: FileStore = new FileStore(),
): Promise<MembersMigrationResult> {
  const [profiles, channels] = await Promise.all([
    fileStore.listProfiles(),
    fileStore.listChannels(),
  ]);
  const channelById = new Map(channels.map(ch => [ch.id, ch]));

  let merged = 0;
  for (const profile of profiles) {
    for (const channelId of parseChannels(profile.channels)) {
      const channel = channelById.get(channelId);
      if (!channel) continue; // 频道已删除 — 跳过
      const members = parseChannels(channel.members);
      if (members.includes(profile.id)) continue; // 幂等：已存在不重复加
      members.push(profile.id);
      channel.members = JSON.stringify(members); // 同步内存副本，保证单次运行内幂等
      await fileStore.updateChannel(channel.id, { members: channel.members });
      merged++;
      logger.info('[MembersMigration] merged profile into channel members', {
        profileId: profile.id,
        profileName: profile.name,
        channelId,
        channelName: channel.name,
      });
    }
  }
  if (merged > 0) {
    logger.info('[MembersMigration] profile.channels → channel.members done', { merged });
  }
  return { merged };
}
