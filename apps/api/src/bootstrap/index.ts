// ── 启动编排装配入口 ──
// P2-a：自 apps/api/src/index.ts（590 行）拆出。步骤语义：
//   - 数据区迁移失败 = 拒启（MigrationError → 本层 catch → process.exit(1)）；
//   - reconcile / seed / warmup / bridges / agent-loop 等失败只 log 不阻断；
//   - 迁移必须先于 reconcile（迁移后的布局才是对账正本）；
//   - warmup 分两段：registerRoutes 前 / 后，保持原相对位置；
//   - 2026-10-03 冷启动修复：listen 前移到 registerRoutes 之后（端口可服务/全量就绪
//     两口径分离，详见 performance-baseline.md §6.1），核心服务/agent loop/channels
//     等后台初始化在 listen 之后继续；
//   - 优雅关闭的逆序清理由 lifecycle.registerShutdown 承载。
import { bootstrapHarness } from '@dommaker/studio-shared';
import { app, registerRoutes } from '../app.js';
import { initStore } from '../core/store.js';
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
import { markReady } from './readiness.js';
import { logger } from '@dommaker/studio-shared/node';

export async function bootstrap(): Promise<void> {
  initConfig();
  // P2-b：钉定进程级 FileStore（core/store.ts）——必须先于一切消费（迁移/路由/service），
  // 此后 apps/api 与 packages 共享同一实例；消费方一律函数内 getStore()，禁 import 期捕获。
  initStore();
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

    // ── 端口可服务点（2026-10-03 冷启动修复：listen 前移）──
    // 路由注册完成后即可对外服务：/health 等已挂路由不依赖下方后台服务。
    // 原顺序 listen 排在初始化链尾，「端口可服务 ≈ 全量就绪」单口径，
    // 链上任何慢初始化（CLI 扫描/服务挂载）都直接推迟健康检查可用时间。
    // 两口径分离后：端口可服务 = tsx 转译 + 路由注册；全量就绪 = 下方各步完成。
    installErrorHandlers(app);
    listen(server, { port: getPort(), host: getHost() });
    startTunnelIfEnabled(getPort());
    registerShutdown(server);

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

    // ── 全量就绪点：/readyz 由此翻 200（listen 前移后 deploy 健康检查以 readiness 为准）──
    markReady();
    logger.info('Bootstrap fully ready (/readyz now 200)');
  } catch (error) {
    logger.error('Failed to start server', { error: String(error) });
    console.error('Full error:', error);
    process.exit(1);
  }
}
