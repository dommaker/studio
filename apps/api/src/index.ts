// Pipeline Studio - 主入口
import 'dotenv/config';

// 固定 KnowledgeStore 路径 — CWD 无关, 与 memory-knowledge-sync hook 共用
process.env.KNOWLEDGE_DIR = process.env.KNOWLEDGE_DIR || require('path').resolve(__dirname, '..', '.harness', 'knowledge');

import { createServer } from 'http';
import { app, registerRoutes } from './app.js';
// WebSocket server removed (B0-003: migrated to SSE). See modules/events/sse.routes.ts
import { logger } from '@dommaker/studio-shared';
// database.ts removed (Spec 4 Phase 4) — FileStore auto-creates directories
import { startEvolutionScheduler, stopEvolutionScheduler } from './modules/knowledge/evolution-scheduler.js';
import { startAuditSubscriber, stopAuditSubscriber } from './modules/audit/audit-subscriber.js';
import { monitorService } from './modules/agents/monitor/monitor.service.js';
import { auditorService } from './modules/agents/auditor/auditor.service.js';
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
    if (!process.env.WORKTREES_DIR) process.env.WORKTREES_DIR = path.join(studioDir, 'worktrees');
    if (!process.env.EVENTS_DIR) process.env.EVENTS_DIR = path.join(studioDir, 'events');
    return;
  }

  // Load .env file from config directory
  const envPath = configDir.endsWith('.env') ? configDir : path.join(configDir, '.env');
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
    logger.info('Config loaded', { source: envPath });
  }
}

loadConfig();

async function start() {
  try {
    // FileStore 自动建目录，无需 DB 连接
    logger.info('Storage initialized (FileStore)');

    // 初始化 harness 运行时（加载 .harness/config.yml 注入 ConstraintChecker）
    await bootstrapHarness();

    // GAP-16: 验证消费事件链完整性（异步，不阻塞启动）
    import('./modules/knowledge/knowledge-singletons.js').then(({ verifyConsumptionChain }) => {
      verifyConsumptionChain().catch(() => { /* non-blocking */ });
    });

    // RKB: 预置已知 Resolution Seed（幂等，异步不阻塞启动）
    import('./modules/knowledge/resolution.service.js').then(({ resolutionService }) => {
      resolutionService.ensureSeedResolutions().catch(err => logger.warn('[RKB] Seed failed', { error: String(err) }));
    });

    // SessionSummary: 提取上次会话以来的知识（非 Goal 维度）
    import('./modules/agents/session-summary.service.js').then(({ sessionSummaryService }) => {
      // 启动时跑一次
      setTimeout(() => sessionSummaryService.summarize(), 3000);
      // 每 6 小时增量跑一次（daemon 长期运行不丢分析）
      setInterval(() => sessionSummaryService.summarize(), 6 * 60 * 60 * 1000);
    }).catch(err => logger.warn('[SessionSummary] Import failed', { error: String(err) }));

    // G-002: 冷启动业务规则扫描（异步，不阻塞启动）
    import('./modules/knowledge/rule-scanner.js').then(({ ruleScanner }) => {
      ruleScanner.fullScan().catch(err => logger.warn('[RuleScanner] Cold start scan failed', { error: String(err) }));
    });

    // G-003: 环境快照 + 定时 24h
    import('./modules/knowledge/env-snapper.js').then(({ envSnapper }) => {
      envSnapper.startPeriodicSnapshots();
    });

    // G-004: 决策链提取（KK 提取时自动触发，见 knowledge-curator.service.ts）

    // P1b: 冷启动知识导入（异步，不阻塞启动）
    import('./modules/agents/knowledge/knowledge-curator.service.js').then(({ knowledgeCurator }) => {
      knowledgeCurator.coldStartAll().catch(() => { /* non-blocking */ });
    });

    // 注册路由
    await registerRoutes();
    logger.info('Routes registered');

    // §9.5: 迁移 profile.channels → channel.members（幂等，异步不阻塞启动）
    import('./modules/channels/migrate-members.js').then(({ migrateProfileChannelsToMembers }) => {
      migrateProfileChannelsToMembers().catch(err => logger.warn('[MembersMigration] failed', { error: String(err) }));
    }).catch(err => logger.warn('[MembersMigration] import failed', { error: String(err) }));

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
    monitorService.start();
    auditorService.start();
    // B4a（决策 D8）: daemon.start() 已摘除 —— studio-daemon 是 pipeline 时代
    // session 管理器，submitJob/submitAdhocJob 全库无生产调用方（仅测试），
    // 且其 reviewer session 每次启动新建 git worktree（daemon/reviewer-* 分支
    // 从不合从不删，泄漏源头）。代码文件保留：daemon-routes / discord /
    // ops.service / cli 仍消费 getStatus/isStarted（未启动时安全降级为空状态）。
    // REQ 需求编号体系（vision §5.3）：WorkUnit 终态 → Requirement done 状态汇总
    try {
      const { initRequirementRollup } = await import('./modules/requirements/rollup.js');
      initRequirementRollup();
      logger.info('[Requirement] Rollup subscribed (workunit.status_changed → done)');
    } catch (e) { logger.warn('[Requirement] Rollup init failed', { error: String(e) }); }
    // B3a 工程归属链（决策 D2）：WorkUnit 状态 → PMO 项目进度回写
    try {
      const { initPmoProgressRollup } = await import('./modules/pmo/progress-rollup.js');
      initPmoProgressRollup();
      logger.info('[PMO] Progress rollup subscribed (workunit.status_changed → project progress)');
    } catch (e) { logger.warn('[PMO] Progress rollup init failed', { error: String(e) }); }
    // ── Ops Service: runtime health loop ──
    try {
      const { createOpsService } = await import('./modules/agents/ops/ops.service.js');
      const opsService = createOpsService();
      opsService.start();
    } catch (e) { logger.warn('[OpsService] Failed to start', { error: String(e) }); }
    startAuditSubscriber();
    try { startEvolutionScheduler(); } catch { logger.warn('Evolution scheduler unavailable'); }

    // ── AS-026: AgentLoop per AgentProfile ──
    try {
      const { FileStore } = await import('@dommaker/studio-shared');
      const { agentLoopRegistry } = await import('./modules/agents/loop/agent-loop-registry.js');
      const { registerDefaultTriggers } = await import('./modules/agents/default-triggers.js');
      const { getTriggerScheduler } = await import('./modules/triggers/trigger-registry.js');
      const { ensureStudioProfile } = await import('./modules/agents/agent-profile.service.js');

      const fileStore = new FileStore();
      // AC-1.1: 启动时幂等创建内置 studio 角色（系统任务执行身份）
      try {
        await ensureStudioProfile(fileStore);
      } catch (e) { logger.warn('[StudioRole] ensureStudioProfile failed', { error: String(e) }); }
      // F1（2026-07-28 分析文档）: 回填存量角色空 provider（幂等;不含 studio）。
      // 内置三角色 seed（B4a 决策 D7）已随 reviewer/pm 解锚退役（F4/F5）——
      // 角色创建走用户入口（FirstRoleSetupModal / 角色向导 / preset 模板），不再系统 seed。
      try {
        const { backfillProfileProviders } = await import('./modules/agents/default-provider.js');
        const stamped = await backfillProfileProviders(fileStore);
        if (stamped > 0) logger.info('[DefaultProvider] Startup backfill done', { stamped });
      } catch (e) { logger.warn('[DefaultProvider] Backfill failed', { error: String(e) }); }
      const profiles = await fileStore.listProfiles({ status: 'active' });
      const scheduler = getTriggerScheduler(); // Singleton — shared with trigger.routes.ts
      scheduler.start(); // Start tick interval for SCHEDULE triggers (workunit-timeout, poll-fallback)

      // 2026-07-30 走查修复：同一 ~/.studio 多实例（dev/prod 并存）时，只允许一个实例
      // 挂载 agent loop + 注册系统触发器 —— 否则同 profile 被重复挂载（认领竞争、频道重复
      // 回复、定时 WU 重复创建）。STUDIO_AGENT_LOOP_ENABLED=false 的实例 standby：
      // 仍提供 REST/UI 与事件订阅（ReviewDispatcher/AnalysisHandoff 有幂等哨兵，状态变更
      // 由谁发起就在谁进程内触发，故两侧都保留），但不认领、不发言、不建定时 WU。
      const agentLoopEnabled = process.env.STUDIO_AGENT_LOOP_ENABLED !== 'false';
      if (!agentLoopEnabled) {
        logger.info('[AgentLoop] STUDIO_AGENT_LOOP_ENABLED=false — 本实例 standby：不挂载 loop、不注册系统触发器');
      }
      if (agentLoopEnabled) {
        registerDefaultTriggers(scheduler);

        // F1: profile 生命周期事件（create/activate/deactivate/delete）→ 动态挂载/卸载
        agentLoopRegistry.subscribeToEvents();
      }

      // AC-4.1: ReviewDispatcher subscribes to workunit.status_changed
      try {
        const { getReviewDispatcher } = await import('./modules/agents/loop/review-dispatcher.js');
        getReviewDispatcher().subscribeToEvents();
        logger.info('[ReviewDispatcher] Subscribed to workunit.status_changed');
      } catch (e) { logger.warn('[ReviewDispatcher] Failed to subscribe', { error: String(e) }); }

      // WorkUnit 事件 → SSE（前端 WU 列表/抽屉实时刷新）
      try {
        const { initWorkunitEventsBridge } = await import('./modules/events/workunit-events-bridge.js');
        initWorkunitEventsBridge();
      } catch (e) { logger.warn('[Events] WorkUnit events bridge failed', { error: String(e) }); }

      // PMO 分析接力：analysis 确认 → 拆 task WU 派工
      try {
        const { initAnalysisHandoff } = await import('./modules/pmo/analysis-handoff.js');
        initAnalysisHandoff();
        logger.info('[AnalysisHandoff] Subscribed to workunit.status_changed');
      } catch (e) { logger.warn('[AnalysisHandoff] Failed to subscribe', { error: String(e) }); }

      if (agentLoopEnabled) {
        for (const profile of profiles) {
          const entry = await agentLoopRegistry.mount(profile);
          if (entry.status === 'running') {
            logger.info(`[AgentLoop] Started for profile ${profile.name}`);
          }
        }
        if (profiles.length === 0) {
          logger.info('[AgentLoop] No active profiles found, skipping auto-start');
        }
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
      const stale = allStates.filter(s => s.status !== 'terminated' && s.status !== 'error' && (s.lastHeartbeat ? new Date(s.lastHeartbeat).getTime() < threshold : true));
      const svc = new AgentInstanceService(fileStore);
      for (const inst of stale) {
        await svc.terminate(inst.id).catch(err =>
          logger.warn(`[AgentTimeout] Failed to terminate ${inst.id}: ${err}`)
        );
      }
      if (stale.length > 0) logger.info(`[AgentTimeout] Terminated ${stale.length} stale instances`);
    });

    // ── F5: NEED_INPUT 挂起超时提醒 handler ──
    registerExecuteHandler('workunit-input-reminder-scan', async () => {
      const { scanWaitingForInputReminders } = await import('./modules/workunit/waiting-input.js');
      await scanWaitingForInputReminders();
    });

    // ── P0: WorkUnit 执行超时释放 handler（workunit-timeout 触发器）──
    registerExecuteHandler('workunit-timeout-scan', async () => {
      const { scanTimedOutWorkUnits } = await import('./modules/workunit/timeout-release.js');
      await scanTimedOutWorkUnits();
    });

    // ── E1 约束进化（vision §6）：每日扫描 handler + 频道审核 watcher ──
    registerExecuteHandler('evolution-scan', async () => {
      const { getEvolutionService } = await import('./modules/evolution/evolution.service.js');
      const result = await getEvolutionService().runScan();
      if (result.created.length > 0) {
        logger.info(`[Evolution] Daily scan created ${result.created.length} proposal(s)`);
      }
    });
    if (process.env.EVOLUTION_ENABLED !== 'false') {
      try {
        const { getEvolutionService } = await import('./modules/evolution/evolution.service.js');
        const { initEvolutionChannelReview } = await import('./modules/evolution/channel-review.js');
        initEvolutionChannelReview(getEvolutionService());
        logger.info('[Evolution] Channel review watcher subscribed (approve/reject EP-XXXX)');
      } catch (e) { logger.warn('[Evolution] Channel review init failed', { error: String(e) }); }
    }

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

      // F1: unmount all AgentLoops
      try {
        const { agentLoopRegistry } = await import('./modules/agents/loop/agent-loop-registry.js');
        agentLoopRegistry.unmountAll();
      } catch {}

      detachWsGateway();
      if (cloudflaredProc) { cloudflaredProc.kill(); cloudflaredProc = null; }
      stopEvolutionScheduler();
      monitorService.stop();
      auditorService.stop();
      stopAuditSubscriber();
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
