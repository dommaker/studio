// Pipeline Studio - 主入口
import 'dotenv/config';
import { createServer } from 'http';
import { app, registerRoutes } from './app.js';
// WebSocket server removed (B0-003: migrated to SSE). See modules/events/sse.routes.ts
import { logger } from '@dommaker/studio-shared';
import { connectDatabase } from './core/database.js';
import { taskWorker, taskQueue } from '@dommaker/studio-task';
import { modelGateway } from '@dommaker/studio-shared';
import { llmConfigService } from './modules/llm/config.service.js';
import { startTimeoutChecker, stopTimeoutChecker } from '@dommaker/studio-meeting';
import { initDiscussionEventHandlers } from '@dommaker/studio-meeting/events/discussion-event-handlers';  // 🆕 DD-007
import { startHealthMonitor, stopHealthMonitor } from '@dommaker/studio-monitor';
import { agentRouter } from './modules/agents/agent-router.js';
import { startEvolutionScheduler, stopEvolutionScheduler } from './modules/knowledge/evolution-scheduler.js';
import { goalScheduler } from './modules/goals/goal-scheduler.js';
import { agentEventListener } from './modules/goals/agent-event-listener.js';
import { startRequirementsSubscriber } from './modules/meetings/requirements-handler.js';
import { startAuditSubscriber, stopAuditSubscriber } from './modules/audit/audit-subscriber.js';
import { monitorAgent } from './modules/agents/monitor-agent.service.js';
import { auditorAgent } from './modules/agents/auditor-agent.service.js';
import { daemon } from './daemon/studio-daemon.js';
import { spawn, type ChildProcess } from 'child_process';
import { bootstrapHarness } from '@dommaker/studio-shared';

const PORT = process.env.PORT || 3001;

async function start() {
  try {
    // 连接数据库
    await connectDatabase();
    logger.info('Database connected');

    // 初始化模型网关
    modelGateway.loadFromEnv();
    // 从 DB 加载加密配置（优先级高于 env）
    try {
      const dbCount = await llmConfigService.syncToGateway();
      logger.info('Model gateway initialized', {
        providers: modelGateway.getProviders().map(p => `${p.name}(${p.model})`),
        dbConfigs: dbCount,
        available: modelGateway.isAvailable(),
      });
    } catch (err) {
      logger.warn('Failed to sync DB configs to gateway, using env only', { error: String(err) });
    }

    // 初始化 harness 运行时（加载 .harness/config.yml 注入 ConstraintChecker）
    await bootstrapHarness();

    // G-002: 冷启动业务规则扫描（异步，不阻塞启动）
    import('./modules/knowledge/rule-scanner.js').then(({ ruleScanner }) => {
      ruleScanner.fullScan().catch(err => logger.warn('[RuleScanner] Cold start scan failed', { error: String(err) }));
    });

    // G-003: 环境快照 + 定时 24h
    import('./modules/knowledge/env-snapper.js').then(({ envSnapper }) => {
      envSnapper.startPeriodicSnapshots();
    });

    // G-004: 决策链提取（监听 meeting.ended 事件）
    import('./modules/knowledge/decision-chain-extractor.js').then(({ decisionChainExtractor }) => {
      decisionChainExtractor.startListening();
    });

    // ⑨: 初始化 trace 管道（Goal 完成后自动分析 trace 数据）
    const { initTracePipeline } = await import('./modules/monitoring/init-trace.js');
    await initTracePipeline();

    // 注册路由
    await registerRoutes();
    logger.info('Routes registered');

    // 创建 HTTP 服务器
    const server = createServer(app);

    // ── Goal 管线核心服务 ──
    goalScheduler.start();
    agentEventListener.start();
    monitorAgent.start();
    auditorAgent.start();
    daemon.start();
    startAuditSubscriber();
    agentRouter.startScheduler(15000);
    try { startEvolutionScheduler(); } catch { logger.warn('Evolution scheduler unavailable'); }

    // ── Channel 初始化（Goal 管线需要）──
    await import('./modules/channels/channel-init.js').then(({ ensureDefaultChannels }) =>
      ensureDefaultChannels()
    ).catch(e => logger.warn('Channel init unavailable', { error: String(e) }));

    // ── 已摘除的 meeting 路径服务 ──
    // startTimeoutChecker, startRequirementsSubscriber,
    // initDiscussionEventHandlers, startHealthMonitor, taskWorker
    // 旧 meeting/discussion 架构已废弃，Goal 管线不需要
    // 需要时回退此 commit

    // Express 4 不自动捕获 async route 异常 → monkey-patch Layer.handle_request
    // (express-async-errors 的等价实现，避免新增依赖)
    try {
      const Layer = require('express/lib/router/layer');
      const origHandle = Layer.prototype.handle_request;
      Layer.prototype.handle_request = function (req: any, res: any, next: any) {
        const fn = this.handle;
        if (fn instanceof Promise || fn?.constructor?.name === 'AsyncFunction') {
          Promise.resolve(fn(req, res, next)).catch(next);
        } else {
          origHandle.call(this, req, res, next);
        }
      };
    } catch (e) {
      logger.warn('express-async-errors patch failed, async route errors may crash HTTP');
    }

    process.on('unhandledRejection', (reason: any) => {
      logger.error('Unhandled rejection, restarting HTTP', { message: reason?.message });
      try { server.close(); server.listen(PORT, () => logger.info('HTTP recovered')); } catch (e) { logger.error('Failed to restart HTTP server', { error: String(e) }); }
    });
    app.use((err: any, _req: any, res: any, _next: any) => {
      logger.error('Express error', { message: err?.message });
      if (!res.headersSent) res.status(500).json({ success: false, error: 'Internal error' });
    });

    // 启动服务器
    server.on('error', (err: any) => {
      if (err?.code === 'EADDRINUSE') {
        logger.warn(`Port ${PORT} in use, retrying in 3s...`);
        setTimeout(() => { server.close(); server.listen(PORT); }, 3000);
      } else {
        logger.error('Server listen error', { code: err?.code, message: err?.message, port: PORT });
      }
    });
    logger.info('Attempting server.listen...');
    server.listen(PORT, () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`API: http://localhost:${PORT}/api/v1`);
    });

    // Cloudflared Tunnel — 自动重启守护 + URL 变化通知
    let cloudflaredProc: ChildProcess | null = null;
    let lastTunnelUrl = '';
    const TUNNEL_URL_FILE = require('path').join(require('os').homedir(), '.claude', 'tunnel-url');

    const notifyTunnelUrl = async (url: string) => {
      // 写文件，方便随时查看
      try { require('fs').writeFileSync(TUNNEL_URL_FILE, url, 'utf-8'); } catch {}
      // 显著日志
      logger.info('='.repeat(70));
      logger.info(`🔗 DISCORD INTERACTIONS ENDPOINT URL: ${url}/api/v1/discord/interactions`);
      logger.info('='.repeat(70));
      // Discord 通知（复用 discordNotifier）
      try {
        const { discordNotifier } = await import('./utils/discord-notifier.js');
        await discordNotifier.sendText(
          '🔗 Tunnel URL 已更新',
          `新的 Interactions Endpoint URL:\n\`\`\`\n${url}/api/v1/discord/interactions\n\`\`\`\n请到 Discord Developer Portal 更新。`
        );
      } catch (e) {
        logger.error('[Cloudflared] Failed to send Discord tunnel notification', { error: String(e) });
      }
    };

    const startCloudflared = () => {
      try {
        cloudflaredProc = spawn('cloudflared', [
          'tunnel', '--url', `http://localhost:${PORT}`,
          '--no-autoupdate',
        ], { stdio: 'pipe' });
        // 累积 stdout 行来解析 URL
        let stdoutBuf = '';
        cloudflaredProc.stdout?.on('data', (d: Buffer) => {
          stdoutBuf += d.toString();
          const lines = stdoutBuf.split('\n');
          for (const line of lines) {
            if (line.includes('trycloudflare.com')) {
              const m = line.match(/([a-z0-9-]+\.trycloudflare\.com)/);
              if (m) {
                const url = `https://${m[1]}`;
                if (url !== lastTunnelUrl) {
                  lastTunnelUrl = url;
                  notifyTunnelUrl(url);
                }
              }
            }
          }
          // 只保留最后一行未完成的部分
          if (!stdoutBuf.endsWith('\n')) stdoutBuf = lines[lines.length - 1] || '';
          else stdoutBuf = '';
        });
        cloudflaredProc.stderr?.on('data', (d: Buffer) => logger.warn(`[Cloudflared] ${d.toString().trim()}`));
        cloudflaredProc.on('exit', (code, sig) => {
          logger.warn(`[Cloudflared] Exited (code=${code}, sig=${sig}), restarting in 5s...`);
          cloudflaredProc = null;
          setTimeout(startCloudflared, 5000);
        });
      } catch {
        logger.warn('[Cloudflared] Not available, Discord tunnel disabled');
      }
    };
    startCloudflared();

    // 优雅关闭
    const shutdown = async () => {
      if (cloudflaredProc) { cloudflaredProc.kill(); cloudflaredProc = null; }
      agentRouter.stopScheduler();
      stopEvolutionScheduler();
      goalScheduler.stop();
      agentEventListener.stop();
      monitorAgent.stop();
      auditorAgent.stop();
      daemon.stop();
      stopAuditSubscriber();
      // Deprecated meeting services removed from startup — stops are no-ops
      try { stopTimeoutChecker(); } catch {}
      try { await stopHealthMonitor(); } catch {}
      try { await taskWorker.stop(); } catch {}
      try { await taskQueue.close(); } catch {}
      server.close();
    };
    process.on('SIGTERM', async () => { logger.info('SIGTERM received'); await shutdown(); });
    process.on('SIGINT', async () => { logger.info('SIGINT received'); await shutdown(); });
  } catch (error) {
    logger.error({ error }, 'Failed to start server');
    console.error('Full error:', error);
    process.exit(1);
  }
}

start();
