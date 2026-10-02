// ── 数据区迁移 + 启动对账 ──
// P2-a：自 apps/api/src/index.ts 拆出。迁移失败 = 拒启（抛 MigrationError 由
// bootstrap 装配层 catch → process.exit(1)）；对账失败只 log 不阻断。
import { logger } from '@dommaker/studio-shared';
import { studioDir as resolveStudioDir } from '@dommaker/studio-shared/studio-dir';

export async function runDataMigrations(): Promise<void> {
  // FileStore 自动建目录，无需 DB 连接
  logger.info('Storage initialized (FileStore)');

  // #572 / 契约 §5（data-directory-contract.md）：数据区 schema 版本迁移，必须在 reconcileIndex
  // 之前——迁移后的布局才是对账/读写的正本。失败抛 MigrationError（含备份路径+回滚指引），
  // 由外层 catch 兜底 process.exit(1) = 失败拒启，不留半迁移态带病运行。
  const { runMigrations } = await import('@dommaker/studio-shared/migrations');
  const migration = await runMigrations(resolveStudioDir());
  if (migration.applied.length > 0 || migration.skipped.length > 0) {
    logger.info('[Migration] 数据区 schema 迁移完成', {
      fromVersion: migration.fromVersion, toVersion: migration.toVersion,
      applied: migration.applied, skipped: migration.skipped, backupPaths: migration.backupPaths,
    });
  }
}

export async function reconcileWorkUnitIndex(): Promise<void> {
  // #170（决策 #65-3）：启动对账 WorkUnit events vs index —— 不一致即按事件流重建索引
  // 并走告警频道（#62 决议出口：dispatchMonitorAlerts 既有管线，warning 级）。
  // 历史数据可能已分叉，不对账永远不可知；失败不阻断启动。
  try {
    const { FileStore: ReconFileStore } = await import('@dommaker/studio-shared');
    const recon = await new ReconFileStore().reconcileIndex();
    if (recon.rebuilt) {
      logger.warn('[WorkUnit] Startup reconcile: events/index diverged — index rebuilt from events', recon);
      const { dispatchMonitorAlerts } = await import('../modules/agent-monitor/index.js');
      dispatchMonitorAlerts([{
        source: 'wu_index_reconcile',
        level: 'warning',
        message: `WorkUnit 启动对账发现 events/index 分叉，已按事件流重建索引（missing=${recon.missingInIndex} stale=${recon.staleInIndex} diverged=${recon.diverged}，events=${recon.eventCount}）`,
      }]);
    } else {
      logger.info('[WorkUnit] Startup reconcile: events/index consistent', { eventCount: recon.eventCount, indexCount: recon.indexCount });
    }
  } catch (e) { logger.warn('[WorkUnit] Startup reconcile failed (non-blocking)', { error: String(e) }); }
}
