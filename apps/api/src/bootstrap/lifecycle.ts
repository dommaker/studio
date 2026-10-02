// ── HTTP 服务生命周期：错误兜底 + listen + 优雅关闭 ──
// P2-a：自 apps/api/src/index.ts 拆出。优雅关闭保持原逆序清理语义：
// unmount AgentLoop → 杀在飞 CLI 进程组 → 杀 cloudflared → 停进化调度
// → monitor.stop → auditor.stop → server.close → 5s 强制 exit 兜底。
import { createServer, type Server } from 'http';
import type { Express } from 'express';
import { logger } from '@dommaker/studio-shared';
import { stopEvolutionScheduler } from '../modules/knowledge/index.js';
import { monitorService } from '../modules/agent-monitor/index.js';
import { auditorService } from '../modules/agent-auditor/index.js';
import { handleServerListenError } from '../utils/listen-error.js';
import { stopTunnel } from './tunnel.js';

export function createHttpServer(app: Express): Server {
  return createServer(app);
}

export function installErrorHandlers(app: Express): void {
  // Express 5 原生兜 async route 异常（promise rejection → error handler），
  // 原 Express 4 的 Layer.handle_request monkey-patch 已随升级删除。
  process.on('unhandledRejection', (reason: any) => {
    logger.error('Unhandled rejection (logged, not restarting HTTP)', { message: reason?.message, stack: reason?.stack });
  });
  process.on('uncaughtException', (err: Error) => {
    logger.error('Uncaught exception — shutting down', { message: err.message, stack: err.stack });
    process.exit(1);
  });
  app.use((err: any, _req: any, res: any, _next: any) => {
    logger.error('Express error', { message: err?.message });
    if (!res.headersSent) res.status(500).json({ success: false, error: 'Internal error' });
  });
}

export function listen(server: Server, opts: { port: string | number; host: string }): void {
  // 启动服务器
  // #573 端口双口径收口（契约 §7）：端口由 port-probe 启动前单口径解析，
  // listen 时再撞 EADDRINUSE = 竞态 → 拒启，删除原 3s 无限重试
  server.on('error', (err: any) => {
    handleServerListenError(err, { port: opts.port, host: opts.host, logger });
  });
  logger.info('Attempting server.listen...');
  server.listen(Number(opts.port), opts.host, () => {
    logger.info(`Server running on ${opts.host}:${opts.port}`);
    logger.info(`API: http://localhost:${opts.port}/api/v1`);
  });
}

export function registerShutdown(server: Server): void {
  // 优雅关闭
  const shutdown = async () => {
    // F1: unmount all AgentLoops
    try {
      const { agentLoopRegistry } = await import('../modules/agent-loop/index.js');
      agentLoopRegistry.unmountAll();
    } catch {}

    // #179（#66 决议 2）：SIGTERM 杀全部在飞 CLI 进程组（不等 step 落盘，
    // 5s 强制 exit 纪律不变；在飞 WU 由 #63 租约到期回收）
    try {
      const { agentRunner } = await import('@dommaker/studio-agent');
      const killed = await agentRunner.stopAllProcessGroups();
      if (killed > 0) logger.info(`[Shutdown] SIGTERM sent to ${killed} in-flight CLI process group(s)`);
    } catch {}

    stopTunnel();
    stopEvolutionScheduler();
    monitorService.stop();
    auditorService.stop();
    server.close(() => process.exit(0));
    // Fallback: force exit if server.close() hangs (lingering connections/handles)
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on('SIGTERM', async () => { logger.info('SIGTERM received'); await shutdown(); });
  process.on('SIGINT', async () => { logger.info('SIGINT received'); await shutdown(); });
}
