// ── 启动编排装配入口 ──
// P2-a：自 apps/api/src/index.ts（590 行）拆出，步骤顺序与原 start() 逐行一致，
// 语义零漂移：
//   - 数据区迁移失败 = 拒启（MigrationError → 本层 catch → process.exit(1)）；
//   - reconcile / seed / warmup / bridges / agent-loop 等失败只 log 不阻断；
//   - 迁移必须先于 reconcile（迁移后的布局才是对账正本）；
//   - warmup 分两段：registerRoutes 前 / 后，保持原相对位置；
//   - 优雅关闭的逆序清理由 lifecycle.registerShutdown 承载。
import { logger, bootstrapHarness } from '@dommaker/studio-shared';
import { app, registerRoutes } from '../app.js';
import { initConfig, getPort, getHost } from './config.js';
import { runDataMigrations, reconcileWorkUnitIndex } from './migrations.js';
import { seedBuiltinSkillsStep } from './seed.js';
import { startWarmupTasks, startPostRoutesWarmup } from './warmup.js';
import { startCoreServices } from './services.js';
import { startAgentLoops, sweepEmptyAgentDirs } from './agent-loop.js';
import { initChannels } from './channels.js';
import { registerScanHandlers } from './handlers.js';
import { createHttpServer, installErrorHandlers, listen, registerShutdown } from './lifecycle.js';
import { startTunnelIfEnabled } from './tunnel.js';

export async function bootstrap(): Promise<void> {
  initConfig();
  try {
    await runDataMigrations();
    await reconcileWorkUnitIndex();
    await seedBuiltinSkillsStep();

    // 初始化 harness 运行时（加载 .harness/config.yml 注入 ConstraintChecker）
    await bootstrapHarness();

    startWarmupTasks();

    // 注册路由
    await registerRoutes();
    logger.info('Routes registered');

    startPostRoutesWarmup();

    // 创建 HTTP 服务器
    const server = createHttpServer(app);

    // ── 核心服务 ──
    await startCoreServices();

    // ── AS-026: AgentLoop per AgentProfile（含事件订阅 bridges）──
    await startAgentLoops();

    // ── Channel 初始化（Goal 管线需要）──
    await initChannels();

    // ── #363: 存量空实例目录一次性清扫 ──
    await sweepEmptyAgentDirs();

    // ── Trigger EXECUTE handler 注册 ──
    await registerScanHandlers();

    installErrorHandlers(app);
    listen(server, { port: getPort(), host: getHost() });
    startTunnelIfEnabled(getPort());
    registerShutdown(server);
  } catch (error) {
    logger.error('Failed to start server', { error: String(error) });
    console.error('Full error:', error);
    process.exit(1);
  }
}
