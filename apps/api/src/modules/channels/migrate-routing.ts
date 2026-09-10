/**
 * #466: defaultPipeline 吞并迁移 —— 存量频道配置自动并入路由表。
 *
 * defaultPipeline（AC-6.1，AgentProfile name 数组，只展开第一跳）由 routing.implement
 * （profile id）取代。启动时对存量频道做一次性吞并：
 *  - routing 未配置（undefined）且 defaultPipeline 非空 → 首跳 name 解析为 active
 *    profile id 落 routing.implement，并移除 defaultPipeline 字段；
 *  - routing 已配置 → 不动（不覆盖人工新配置）；
 *  - 首跳 name 无法解析为 active profile → 死配置（展开本就 warn + no-op）吞并移除，记 warn。
 * 幂等：重复执行零变更。
 */
import { logger, FileStore } from '@dommaker/studio-shared';

export interface RoutingMigrationResult {
  /** 本次吞并进 routing.implement 的频道数 */
  migrated: number;
  /** 首跳无法解析、按死配置移除 defaultPipeline 的频道数 */
  dropped: number;
}

/** 存量数据形态（defaultPipeline 已从 ChannelData 退役，仅迁移读旧字段） */
type LegacyChannelShape = { defaultPipeline?: string[] };

export async function migrateDefaultPipelineToRouting(
  fileStore: FileStore = new FileStore(),
): Promise<RoutingMigrationResult> {
  const [channels, activeProfiles] = await Promise.all([
    fileStore.listChannels(),
    fileStore.listProfiles({ status: 'active' }),
  ]);
  const activeIdByName = new Map(activeProfiles.map(p => [p.name, p.id]));

  let migrated = 0;
  let dropped = 0;
  for (const channel of channels) {
    const legacy = (channel as typeof channel & LegacyChannelShape).defaultPipeline;
    if (channel.routing !== undefined || !legacy || legacy.length === 0) continue;

    const firstId = activeIdByName.get(legacy[0]);
    // updateDirEntity 浅合并 + JSON.stringify 丢弃 undefined —— 显式 undefined 即删旧字段
    await fileStore.updateChannel(channel.id, {
      ...(firstId ? { routing: { implement: firstId } } : {}),
      defaultPipeline: undefined,
    } as Partial<import('@dommaker/studio-shared').ChannelData>);
    if (firstId) {
      migrated++;
      logger.info('[RoutingMigration] defaultPipeline → routing.implement', {
        channelId: channel.id,
        channelName: channel.name,
        profileName: legacy[0],
        profileId: firstId,
      });
    } else {
      dropped++;
      logger.warn('[RoutingMigration] defaultPipeline 首跳无法解析为 active profile，按死配置移除', {
        channelId: channel.id,
        channelName: channel.name,
        profileName: legacy[0],
      });
    }
  }
  if (migrated > 0 || dropped > 0) {
    logger.info('[RoutingMigration] defaultPipeline → routing done', { migrated, dropped });
  }
  return { migrated, dropped };
}
