// ── 冷启动异步任务（全部 fire-and-forget，不阻塞启动）──
// P2-a：自 apps/api/src/index.ts 拆出。startWarmupTasks 在 registerRoutes 之前调用，
// startPostRoutesWarmup 在 registerRoutes 之后调用——与原 index.ts 的相对位置一致。
import { logger } from '@dommaker/studio-shared';

export function startWarmupTasks(): void {
  // GAP-16: 验证消费事件链完整性（异步，不阻塞启动）
  import('../modules/knowledge/knowledge-singletons.js').then(({ verifyConsumptionChain }) => {
    verifyConsumptionChain().catch(() => { /* non-blocking */ });
  });

  // RKB: 预置已知 Resolution Seed（幂等，异步不阻塞启动）
  import('../modules/knowledge/resolution.service.js').then(({ resolutionService }) => {
    resolutionService.ensureSeedResolutions().catch(err => logger.warn('[RKB] Seed failed', { error: String(err) }));
  });

  // SessionSummary: 提取上次会话以来的知识（非 Goal 维度）
  import('../modules/agents/session-summary.service.js').then(({ sessionSummaryService }) => {
    // 启动时跑一次
    setTimeout(() => sessionSummaryService.summarize(), 3000);
    // 每 6 小时增量跑一次（daemon 长期运行不丢分析）
    setInterval(() => sessionSummaryService.summarize(), 6 * 60 * 60 * 1000);
  }).catch(err => logger.warn('[SessionSummary] Import failed', { error: String(err) }));

  // #173（#60 决策 Q3b / spec 批次 C4）：事件保留轮转——信号热 30 天 → 月度 gzip 冷包
  // 永久保留；噪声（level=debug：knowledge:*/tool:call）7 天滚动删除。启动后跑一次 + 每 24h。
  import('../utils/studio-events-rotation.js').then(({ rotateStudioEvents }) => {
    const runRotation = () => rotateStudioEvents()
      .catch(err => logger.warn('[StudioEvents] Retention rotation failed', { error: String(err) }));
    setTimeout(runRotation, 15_000);
    setInterval(runRotation, 24 * 60 * 60 * 1000);
  }).catch(err => logger.warn('[StudioEvents] Rotation import failed', { error: String(err) }));

  // #213：其余 jsonl 日志保留轮转（incidents 信号热 30 天→月 gzip、audit 审计热 90 天→月
  // gzip、notifications 噪声 7 天滚删）+ 遗留 tasks-*.jsonl / 残留 incidents 一次性归档后
  // 删除。与 #173 同一节奏：启动后跑一次 + 每 24h。
  import('../utils/studio-log-rotation.js').then(({ rotateStudioLogFiles, archiveLegacyStudioLogs }) => {
    const runLogRotation = () => rotateStudioLogFiles()
      .then(() => archiveLegacyStudioLogs())
      .catch(err => logger.warn('[StudioLogRotation] Rotation failed', { error: String(err) }));
    setTimeout(runLogRotation, 20_000);
    setInterval(runLogRotation, 24 * 60 * 60 * 1000);
  }).catch(err => logger.warn('[StudioLogRotation] Rotation import failed', { error: String(err) }));

  // #327：频道消息按 WU 生命周期归档——超龄活消息从热文件搬入冷文件
  // （FileStore.archiveChannelMessages，详见 studio-shared CONTEXT.md）。
  // 与 #173/#213 同一挂载机制：启动后跑一次 + 每 24h，独立 interval 句柄。
  import('@dommaker/studio-shared').then(({ FileStore }) => {
    const archiveStore = new FileStore();
    const runMessageArchive = () => archiveStore.archiveChannelMessages()
      .then(({ archivedMessages }) => {
        if (archivedMessages > 0) {
          logger.info('[MessageArchive] Sweep archived aged messages', { archivedMessages });
        }
      })
      .catch(err => logger.warn('[MessageArchive] Sweep failed', { error: String(err) }));
    setTimeout(runMessageArchive, 25_000);
    setInterval(runMessageArchive, 24 * 60 * 60 * 1000);
  }).catch(err => logger.warn('[MessageArchive] Import failed', { error: String(err) }));

  // G-002: 冷启动业务规则扫描（异步，不阻塞启动）
  import('../modules/knowledge/rule-scanner.js').then(({ ruleScanner }) => {
    ruleScanner.fullScan().catch(err => logger.warn('[RuleScanner] Cold start scan failed', { error: String(err) }));
  });

  // G-003: 环境快照 + 定时 24h
  import('../modules/knowledge/env-snapper.js').then(({ envSnapper }) => {
    envSnapper.startPeriodicSnapshots();
  });

  // G-004: 决策链提取（KK 提取时自动触发，见 knowledge-curator.service.ts）

  // P1b: 冷启动知识导入（异步，不阻塞启动）
  import('../modules/agents/knowledge/knowledge-curator.service.js').then(({ knowledgeCurator }) => {
    knowledgeCurator.coldStartAll().catch(() => { /* non-blocking */ });
  });
}

export function startPostRoutesWarmup(): void {
  // §9.5: 迁移 profile.channels → channel.members（幂等，异步不阻塞启动）
  import('../modules/channels/migrate-members.js').then(({ migrateProfileChannelsToMembers }) => {
    migrateProfileChannelsToMembers().catch(err => logger.warn('[MembersMigration] failed', { error: String(err) }));
  }).catch(err => logger.warn('[MembersMigration] import failed', { error: String(err) }));

  // AS-020 P2-04: VPS 本地 Workspace 注册（异步，不阻塞启动）
  import('../modules/workspaces/local-workspace.js').then(({ ensureLocalWorkspace }) => {
    ensureLocalWorkspace().catch(err => logger.warn('[LocalWorkspace] Registration failed', { error: String(err) }));
  }).catch(err => logger.warn('[LocalWorkspace] Import failed', { error: String(err) }));
}
