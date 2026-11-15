// ── 冷启动异步任务（全部 fire-and-forget，不阻塞启动）──
// P2-a：自 apps/api/src/index.ts 拆出。startWarmupTasks 在 registerRoutes 之前调用，
// startPostRoutesWarmup 在 registerRoutes 之后调用——与原 index.ts 的相对位置一致。
// P2-c：同一 barrel 的多个动态 import 合并为单次——除少一次重复模块求值外，
// 也消除 vitest 对同模块并发动态 import 的 mock 竞态（测试可复现：一链拿 mock 一链拿真模块）。
// #686：表驱动 + mountSoftSteps 单循环，加载/挂载失败只 warn（纪律固化在 soft-steps.ts）；
// 新增冷启动任务 = 表里加一行。

import { getStore } from '../core/store.js';
import { mountSoftSteps, type SoftStep } from './soft-steps.js';
import { logger } from '@dommaker/studio-shared/node';

const WARMUP_TASKS: readonly SoftStep[] = [
  {
    // knowledge 域冷启动任务组（同一 barrel 单次 import，各任务独立 catch 互不阻断）：
    // GAP-16 消费链完整性验证 / RKB Resolution Seed / G-002 规则扫描 / G-003 环境快照
    name: 'knowledge',
    run: async () => {
      const { verifyConsumptionChain, resolutionService, ruleScanner, getEnvSnapper } = await import('../modules/knowledge/index.js');
      verifyConsumptionChain().catch(err => logger.warn('[ConsumptionChain] verify failed', { error: String(err) }));
      resolutionService.ensureSeedResolutions().catch(err => logger.warn('[RKB] Seed failed', { error: String(err) }));
      ruleScanner.fullScan().catch(err => logger.warn('[RuleScanner] Cold start scan failed', { error: String(err) }));
      getEnvSnapper().startPeriodicSnapshots();
    },
  },
  {
    // 真实 session:end 落盘触发 + 启动恢复；完成标记就是持久化的 session:summary 事件。
    name: 'session-summary',
    run: async () => {
      const { initSessionSummaryGenerator } = await import('../modules/events/index.js');
      initSessionSummaryGenerator();
    },
  },
  {
    // P1b 知识冷启动导入（P2-d 刀7：knowledgeCurator 随知识维护 Agent 迁 agent-knowledge）
    name: 'agent-knowledge',
    run: async () => {
      const { getKnowledgeCurator } = await import('../modules/agent-knowledge/index.js');
      getKnowledgeCurator().coldStartAll().catch(() => { /* non-blocking */ });
    },
  },
  {
    // #173（#60 决策 Q3b / spec 批次 C4）：事件保留轮转——信号热 30 天 → 月度 gzip 冷包
    // 永久保留；噪声（level=debug：knowledge:*/tool:call）7 天滚动删除。启动后跑一次 + 每 24h。
    name: 'studio-events-rotation',
    run: async () => {
      const { rotateStudioEvents } = await import('./studio-events-rotation.js');
      const runRotation = () => rotateStudioEvents()
        .catch(err => logger.warn('[StudioEvents] Retention rotation failed', { error: String(err) }));
      setTimeout(runRotation, 15_000);
      setInterval(runRotation, 24 * 60 * 60 * 1000);
    },
  },
  {
    // #213：其余 jsonl 日志保留轮转（incidents 信号热 30 天→月 gzip、audit 审计热 90 天→月
    // gzip、notifications 噪声 7 天滚删）+ 遗留 tasks-*.jsonl / 残留 incidents 一次性归档后
    // 删除。与 #173 同一节奏：启动后跑一次 + 每 24h。
    name: 'studio-log-rotation',
    run: async () => {
      const { rotateStudioLogFiles, archiveLegacyStudioLogs } = await import('./studio-log-rotation.js');
      const runLogRotation = () => rotateStudioLogFiles()
        .then(() => archiveLegacyStudioLogs())
        .catch(err => logger.warn('[StudioLogRotation] Rotation failed', { error: String(err) }));
      setTimeout(runLogRotation, 20_000);
      setInterval(runLogRotation, 24 * 60 * 60 * 1000);
    },
  },
  {
    // #327：频道消息按 WU 生命周期归档——超龄活消息从热文件搬入冷文件
    // （FileStore.archiveChannelMessages，详见 studio-shared CONTEXT.md）。
    // 与 #173/#213 同一挂载机制：启动后跑一次 + 每 24h，独立 interval 句柄。
    name: 'message-archive',
    run: async () => {
      const archiveStore = getStore();
      const runMessageArchive = () => archiveStore.archiveChannelMessages()
        .then(({ archivedMessages }) => {
          if (archivedMessages > 0) {
            logger.info('[MessageArchive] Sweep archived aged messages', { archivedMessages });
          }
        })
        .catch(err => logger.warn('[MessageArchive] Sweep failed', { error: String(err) }));
      setTimeout(runMessageArchive, 25_000);
      setInterval(runMessageArchive, 24 * 60 * 60 * 1000);
    },
  },
];

const POST_ROUTES_WARMUP: readonly SoftStep[] = [
  {
    // AS-020 P2-04: VPS 本地 Workspace 注册（异步，不阻塞启动）
    name: 'local-workspace',
    run: async () => {
      const { ensureLocalWorkspace } = await import('../modules/workspaces/index.js');
      ensureLocalWorkspace().catch(err => logger.warn('[LocalWorkspace] Registration failed', { error: String(err) }));
    },
  },
];

export function startWarmupTasks(): void {
  mountSoftSteps(WARMUP_TASKS);
}

export function startPostRoutesWarmup(): void {
  mountSoftSteps(POST_ROUTES_WARMUP);
}
