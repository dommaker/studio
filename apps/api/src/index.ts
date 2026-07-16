// Pipeline Studio - 主入口
import 'dotenv/config';

// 固定 KnowledgeStore 路径 — CWD 无关, 与 memory-knowledge-sync hook 共用
process.env.KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR || require('path').resolve(__dirname, '..', '.harness', 'knowledge');

// DATABASE_URL 必须在 @dommaker/studio-prisma 加载前解析为绝对路径
// Prisma 从 CWD 解析 file:./data.db，不同启动目录会读到不同 DB
// ESM import 顺序: app.ts → auth.ts → @dommaker/studio-prisma 在此行之后立即触发
import * as _path from 'path';
if (process.env.DATABASE_URL && process.env.DATABASE_URL.startsWith('file:./')) {
  process.env.DATABASE_URL = `file:${_path.resolve(process.cwd(), process.env.DATABASE_URL.slice(5))}`;
}

import { createServer } from 'http';
import { app, registerRoutes } from './app.js';
// WebSocket server removed (B0-003: migrated to SSE). See modules/events/sse.routes.ts
import { logger } from '@dommaker/studio-shared';
import { connectDatabase } from './core/database.js';
import { taskWorker, taskQueue } from '@dommaker/studio-task';
import { modelGateway } from '@dommaker/studio-shared';
import { llmConfigService } from './modules/llm/config.service.js';
import { startHealthMonitor, stopHealthMonitor } from '@dommaker/studio-monitor';
import { startEvolutionScheduler, stopEvolutionScheduler } from './modules/knowledge/evolution-scheduler.js';
import { startAuditSubscriber, stopAuditSubscriber } from './modules/audit/audit-subscriber.js';
import { monitorAgent } from './modules/agents/monitor-agent.service.js';
import { auditorAgent } from './modules/agents/auditor-agent.service.js';
import { daemon } from './daemon/studio-daemon.js';
import { spawn, type ChildProcess } from 'child_process';
import { bootstrapHarness } from '@dommaker/studio-shared';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const PORT = process.env.PORT || 3001;

// ── 配置加载（无论怎么启动都会执行）──
function loadConfig(): void {
  const configDir = process.env.STUDIO_CONFIG_DIR;
  if (!configDir) {
    // Fallback: ~/.studio/ defaults
    const studioDir = path.join(os.homedir(), '.studio');
    if (!process.env.DATABASE_URL) process.env.DATABASE_URL = `file:${path.join(studioDir, 'data', 'data.db')}`;
    if (!process.env.WORKTREES_DIR) process.env.WORKTREES_DIR = path.join(studioDir, 'worktrees');
    if (!process.env.EVENTS_DIR) process.env.EVENTS_DIR = path.join(studioDir, 'events');
    return;
  }

  // Load .env file from config directory
  const envPath = configDir.endsWith('.env') ? configDir : path.join(configDir, '.env');
  const configRoot = path.dirname(envPath);
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        // Q6修复: file:./data.db 相对路径解析到绝对路径, 避免 Prisma 解析到错误位置
        if (key === 'DATABASE_URL' && val.startsWith('file:./')) {
          val = `file:${path.resolve(configRoot, val.slice(5))}`;
        }
        process.env[key] = val;
      }
    }
    logger.info('Config loaded', { source: envPath });
  }
}

loadConfig();

async function start() {
  try {
    // 连接数据库
    await connectDatabase();
    logger.info('Database connected');

    // 初始化模型网关
    modelGateway.loadFromEnv();
    // R1: 注册 knowledge provider（KnowledgeAgent 统一走 gateway）
    if (process.env.KNOWLEDGE_API_KEY) {
      modelGateway.addProvider({
        name: 'knowledge',
        baseUrl: process.env.KNOWLEDGE_BASE_URL || 'https://api.deepseek.com/v1',
        apiKey: process.env.KNOWLEDGE_API_KEY,
        model: process.env.MODEL_TIER_STANDARD || 'deepseek-v4-pro',
        priority: 1,
        tierModels: {
          fast: process.env.MODEL_TIER_FAST || 'deepseek-v4-flash',
          standard: process.env.MODEL_TIER_STANDARD || 'deepseek-v4-pro',
        },
      });
    }
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

    // GAP-16: 验证消费事件链完整性（异步，不阻塞启动）
    import('./modules/knowledge/knowledge-bus.service.js').then(({ verifyConsumptionChain }) => {
      verifyConsumptionChain().catch(() => { /* non-blocking */ });
    });

    // RKB: 预置已知 Resolution Seed（幂等，异步不阻塞启动）
    import('./modules/knowledge/resolution.service.js').then(({ resolutionService }) => {
      resolutionService.ensureSeedResolutions().catch(err => logger.warn('[RKB] Seed failed', { error: String(err) }));
    });

    // SessionSummary: 提取上次会话以来的知识（非 Goal 维度）
    import('./modules/agents/session-summary-agent.service.js').then(({ sessionSummaryAgent }) => {
      // 启动时跑一次
      setTimeout(() => sessionSummaryAgent.summarize(), 3000);
      // 每 6 小时增量跑一次（daemon 长期运行不丢分析）
      setInterval(() => sessionSummaryAgent.summarize(), 6 * 60 * 60 * 1000);
    }).catch(err => logger.warn('[SessionSummary] Import failed', { error: String(err) }));

    // G-002: 冷启动业务规则扫描（异步，不阻塞启动）
    import('./modules/knowledge/rule-scanner.js').then(({ ruleScanner }) => {
      ruleScanner.fullScan().catch(err => logger.warn('[RuleScanner] Cold start scan failed', { error: String(err) }));
    });

    // G-003: 环境快照 + 定时 24h
    import('./modules/knowledge/env-snapper.js').then(({ envSnapper }) => {
      envSnapper.startPeriodicSnapshots();
    });

    // G-004: 决策链提取（KK 提取时自动触发，见 knowledge-agent.service.ts）

    // P1b: 冷启动知识导入（异步，不阻塞启动）
    import('./modules/agents/knowledge-agent.service.js').then(({ knowledgeAgent }) => {
      knowledgeAgent.coldStartAll().catch(() => { /* non-blocking */ });
    });

    // 注册路由
    await registerRoutes();
    logger.info('Routes registered');

    // AS-020 P2-04: VPS 本地 Workspace 注册（异步，不阻塞启动）
    import('./modules/workspaces/local-workspace.js').then(({ ensureLocalWorkspace }) => {
      ensureLocalWorkspace().catch(err => logger.warn('[LocalWorkspace] Registration failed', { error: String(err) }));
    }).catch(err => logger.warn('[LocalWorkspace] Import failed', { error: String(err) }));

    // 创建 HTTP 服务器
    const server = createServer(app);

    // AS-020 P4: WebSocket gateway for Daemon persistent connections
    const { attachWsGateway } = await import('./modules/workspaces/ws-gateway.js');
    const detachWsGateway = attachWsGateway(server);
    logger.info('[WsGateway] Attached to HTTP server at /ws/daemon');

    // ── 核心服务 ──
    monitorAgent.start();
    auditorAgent.start();
    daemon.start();
    // ── Ops Agent: runtime health loop ──
    try {
      const { createOpsAgent } = await import('./modules/agents/ops-agent.service.js');
      const opsAgent = createOpsAgent();
      opsAgent.start();
    } catch (e) { logger.warn('[OpsAgent] Failed to start', { error: String(e) }); }
    startAuditSubscriber();
    try { startEvolutionScheduler(); } catch { logger.warn('Evolution scheduler unavailable'); }

    // ── AS-026: AgentLoop per AgentProfile ──
    try {
      const { FileStore } = await import('@dommaker/studio-shared');
      const { AgentLoop } = await import('./modules/agents/agent-loop.js');
      const { registerDefaultTriggers } = await import('./modules/agents/default-triggers.js');
      const { getTriggerScheduler } = await import('./modules/triggers/trigger-registry.js');

      const fileStore = new FileStore();
      const profiles = await fileStore.listProfiles({ status: 'active' });
      const registry = getTriggerScheduler(); // Singleton — shared with trigger.routes.ts
      registry.start(); // Start tick interval for SCHEDULE triggers (workunit-timeout, poll-fallback)
      registerDefaultTriggers(registry);

      for (const profile of profiles) {
        const loop = new AgentLoop(profile as any);
        await loop.start();
        logger.info(`[AgentLoop] Started for profile ${profile.name}`);
      }
      if (profiles.length === 0) {
        logger.info('[AgentLoop] No active profiles found, skipping auto-start');
      }
    } catch (e) { logger.warn('[AgentLoop] Failed to start', { error: String(e) }); }

    // ── Channel 初始化（Goal 管线需要）──
    await import('./modules/channels/channel-init.js').then(({ ensureDefaultChannels }) =>
      ensureDefaultChannels()
    ).catch(e => logger.warn('Channel init unavailable', { error: String(e) }));

    // ── Agent Timeout Scan（超时释放 handler）──
    const { registerExecuteHandler } = await import('./modules/triggers/trigger-action.js');
    registerExecuteHandler('agent-timeout-scan', async () => {
      const { AgentInstanceService } = await import('./modules/agents/agent-instance.service.js');
      const { FileStore } = await import('@dommaker/studio-shared');
      const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
      const threshold = Date.now() - TIMEOUT_MS;
      const fileStore = new FileStore();
      const allStates = await fileStore.listStates();
      const stale = allStates.filter(s => s.status !== 'terminated' && (s.lastHeartbeat ? new Date(s.lastHeartbeat).getTime() < threshold : true));
      const svc = new AgentInstanceService(fileStore);
      for (const inst of stale) {
        await svc.terminate(inst.id).catch(err =>
          logger.warn(`[AgentTimeout] Failed to terminate ${inst.id}: ${err}`)
        );
      }
      if (stale.length > 0) logger.info(`[AgentTimeout] Terminated ${stale.length} stale instances`);
    });

    // ── meeting 路径服务已摘除 ──

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
    if (process.env.CLOUDFLARED_ENABLED !== 'false') {
      startCloudflared();
    } else {
      logger.info('[Cloudflared] Disabled via CLOUDFLARED_ENABLED=false');
    }

    // 优雅关闭
    const shutdown = async () => {
      // Graceful: stop accepting new work, wait for running Claude tasks
      try { await daemon.gracefulShutdown(); } catch {}

      detachWsGateway();
      if (cloudflaredProc) { cloudflaredProc.kill(); cloudflaredProc = null; }
      stopEvolutionScheduler();
      monitorAgent.stop();
      auditorAgent.stop();
      stopAuditSubscriber();
      // Deprecated meeting services removed from startup — stops are no-ops
      try { await stopHealthMonitor(); } catch {}
      try { await taskWorker.stop(); } catch {}
      try { await taskQueue.close(); } catch {}
      server.close(() => process.exit(0));
      // Fallback: force exit if server.close() hangs (lingering connections/handles)
      setTimeout(() => process.exit(0), 5000).unref();
    };
    process.on('SIGTERM', async () => { logger.info('SIGTERM received'); await shutdown(); });
    process.on('SIGINT', async () => { logger.info('SIGINT received'); await shutdown(); });
  } catch (error) {
    logger.error('Failed to start server', { error: String(error) });
    console.error('Full error:', error);
    process.exit(1);
  }
}

start();
