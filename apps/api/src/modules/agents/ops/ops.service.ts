/**
 * Ops Service — 系统生命周期守护
 *
 * 负责：启动安全检查、进程管理、配置校验、数据完整性、运行时健康
 * 缺口：启动阶段独立于 Monitor/Auditor 运行，保护 Monitor 管不到的部分
 */

import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger, FileStore } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { loadRules, type OpsRules } from './ops-rules.js';
import { readDiskUsage, readMemoryUsage, readLoadAvgRaw } from './proc-probes.js';
import { hashPassword } from '../../auth/service.js';
import { resolveStudioLogFile } from '../../../utils/studio-log-path.js';

const execAsync = promisify(exec);

export interface PreflightResult {
  passed: boolean;
  checks: PreflightCheck[];
  criticalFailures: string[];
}

export interface PreflightCheck {
  name: string;
  passed: boolean;
  message: string;
  critical: boolean;
  autoFixed?: boolean;
}

interface HealthStatus {
  disk: { used: string; avail: string; usePercent: string };
  memory: { total: string; used: string; free: string };
  cpu: { load: string };
  apiResponding: boolean;
  processes: number;
  timestamp: string;
}

export class OpsService {
  private interval: NodeJS.Timeout | null = null;
  private port: number;
  private rules: OpsRules;
  private fileStore: FileStore;

  constructor(port: number, fileStore?: FileStore) {
    this.port = port;
    this.rules = loadRules();
    this.fileStore = fileStore ?? new FileStore();
  }

  // ============================================
  // Pre-flight Guard
  // ============================================

  async preflight(repoDir: string, frontendDistPath: string): Promise<PreflightResult> {
    const checks: PreflightCheck[] = [];
    const criticalFailures: string[] = [];

    const add = (c: PreflightCheck) => {
      checks.push(c);
      if (!c.passed && c.critical) criticalFailures.push(c.name);
    };

    // 1. Check storage (FileStore)
    try {
      const probeFile = studioPath('data', '_health_probe');
      await fs.promises.writeFile(probeFile, Date.now().toString());
      await fs.promises.unlink(probeFile);
      add({ name: 'storage', passed: true, message: 'FileStore OK', critical: true });
    } catch (e: any) {
      add({
        name: 'storage', passed: false, critical: true,
        message: `❌ FileStore error! Cannot write to ${studioPath('data')}. Check disk space and permissions. (${e.message})`,
      });
    }

    // 2. Check frontend dist
    const indexHtml = path.join(frontendDistPath, 'index.html');
    if (fs.existsSync(indexHtml)) {
      add({ name: 'frontend-dist', passed: true, message: 'Frontend dist exists', critical: false });
    } else {
      // Try to auto-build
      try {
        const webDir = path.join(repoDir, 'apps/web');
        if (fs.existsSync(webDir)) {
          logger.info('[Ops] Building frontend...');
          execSync('npx vite build', { cwd: webDir, stdio: 'pipe', timeout: 120_000 });
          // Copy to frontend dist
          const srcDist = path.join(webDir, 'dist');
          if (fs.existsSync(srcDist)) {
            fs.mkdirSync(path.dirname(frontendDistPath), { recursive: true });
            execSync(`cp -r "${srcDist}/"* "${frontendDistPath}/"`, { stdio: 'pipe' });
            add({
              name: 'frontend-dist', passed: true, critical: false,
              message: 'Frontend built and deployed', autoFixed: true,
            });
          } else {
            add({ name: 'frontend-dist', passed: false, critical: false, message: '⚠️ Frontend build produced no dist' });
          }
        }
      } catch (e: any) {
        add({
          name: 'frontend-dist', passed: false, critical: false,
          message: `⚠️ Frontend dist missing and auto-build failed: ${e.message.slice(0, 100)}`,
        });
      }
    }

    // 3. Check port
    try {
      const output = execSync(`lsof -ti:${this.port} 2>/dev/null || true`, { encoding: 'utf-8', stdio: 'pipe' }).trim();
      if (output) {
        add({
          name: 'port-available', passed: false, critical: true,
          message: `❌ Port ${this.port} is already in use by PID(s): ${output.replace(/\n/g, ', ')}. Kill old processes first: studio stop`,
        });
      } else {
        add({ name: 'port-available', passed: true, message: `Port ${this.port} available`, critical: true });
      }
    } catch (e: any) {
      add({ name: 'port-available', passed: true, message: `Port ${this.port} available`, critical: true });
    }

    // 4. Clean stale processes
    try {
      const staleCount = this.cleanStaleProcesses();
      if (staleCount > 0) {
        add({ name: 'clean-processes', passed: true, message: `Cleaned ${staleCount} stale processes`, critical: false, autoFixed: true });
      } else {
        add({ name: 'clean-processes', passed: true, message: 'No stale processes', critical: false });
      }
    } catch (e: any) {
      add({ name: 'clean-processes', passed: true, message: `Process check skipped: ${e.message.slice(0, 50)}`, critical: false });
    }

    // 4b. Cloudflared tunnel (only if enabled — most users don't need it)
    if (process.env.CLOUDFLARED_ENABLED === 'true') {
      try {
        const cfAlive = this.isCloudflaredRunning();
        if (cfAlive) {
          add({ name: 'cloudflared', passed: true, message: 'Tunnel connected', critical: false });
        } else {
          try {
            execSync(`nohup cloudflared tunnel --url http://localhost:${this.port} --no-autoupdate > /tmp/cloudflared.log 2>&1 &`, { stdio: 'pipe' });
            add({ name: 'cloudflared', passed: true, message: 'Tunnel restarted', critical: false, autoFixed: true });
          } catch {
            add({ name: 'cloudflared', passed: false, critical: false, message: '⚠️ Cloudflared tunnel not running — HTTPS may be unavailable' });
          }
        }
      } catch {
        add({ name: 'cloudflared', passed: true, message: 'Cloudflared check skipped', critical: false });
      }
    }

    // 5. Disk space（statfs 口径，委托 proc-probes 单出口——#374 去同步 df 子进程）
    try {
      const disk = readDiskUsage('/');
      if (!disk || disk.usePercent === null) throw new Error('statfs unavailable');
      const usePercent = `${disk.usePercent}%`;
      const fmtAvail = (bytes: number) =>
        bytes >= 1024 ** 3 ? `${Math.round(bytes / 1024 ** 3)}G` : `${Math.round(bytes / 1024 ** 2)}M`;
      const avail = fmtAvail(disk.availBytes);
      if (disk.usePercent > this.rules.checks.disk_threshold_critical) {
        add({ name: 'disk-space', passed: false, critical: true, message: `❌ Disk ${usePercent} full (${avail} available)` });
      } else if (disk.usePercent > this.rules.checks.disk_threshold_warn) {
        add({ name: 'disk-space', passed: true, message: `⚠️ Disk ${usePercent} (${avail} available)`, critical: false });
      } else {
        add({ name: 'disk-space', passed: true, message: `Disk ${usePercent} (${avail} available)`, critical: false });
      }
    } catch {
      add({ name: 'disk-space', passed: true, message: 'Disk check skipped (statfs unavailable)', critical: false });
    }

    const passed = criticalFailures.length === 0;
    const result: PreflightResult = {
      passed,
      checks,
      criticalFailures: passed ? [] : criticalFailures,
    };

    // Print report
    console.log('\n═══ Pre-flight Check ═══');
    for (const c of checks) {
      const icon = c.passed ? '✅' : '❌';
      const auto = c.autoFixed ? ' (auto-fixed)' : '';
      console.log(`  ${icon} ${c.name}: ${c.message}${auto}`);
    }
    if (!passed) {
      console.log(`\n❌ ${criticalFailures.length} critical failure(s). Server will NOT start.`);
      console.log(`   Fix the issues above and try again.\n`);
    } else {
      console.log('\n✅ All checks passed. Starting server...\n');
    }

    return result;
  }

  // ============================================
  // Runtime Health
  // ============================================

  private stopped = false;

  // Proxy health: restart rate limiting (max 3 per hour)
  private proxyRestartCount = 0;
  private proxyRestartWindowStart = 0;

  start(intervalMs: number = 300_000): void {
    if (this.interval) return;
    this.stopped = false;
    this.interval = setInterval(() => this.healthCheck(), intervalMs);
    logger.info('[OpsService] Started', { intervalMs, port: this.port });
  }

  stop(): void {
    this.stopped = true;
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    logger.info('[OpsService] Stopped');
  }

  private async healthCheck(): Promise<void> {
    // Bail out if stop() was called while this check was in-flight (race with graceful shutdown)
    if (this.stopped) return;
    try {
      const status = await this.getStatus();
      if (this.stopped) return; // re-check after async gap
      logger.info('[OpsService] Health check', status);

      // Critical: API not responding → check if daemon is busy before restart
      if (!status.apiResponding) {
        logger.error('[OpsService] CRITICAL: API not responding on port', { port: this.port });
        // B13-009: Record incident to KnowledgeService
        try {
          const { knowledgeService } = await import('../../knowledge/knowledge-service.js');
          knowledgeService.recordIncident({
            title: 'API not responding',
            content: `API on port ${this.port} is not responding. Time: ${new Date().toISOString()}`,
            severity: 'critical',
            tags: ['ops'],
          }).catch(() => { /* non-blocking */ });
        } catch { /* non-blocking */ }
        // Don't auto-restart if executor sessions are running — the load is likely from Claude
        // （daemon 簇已随 origin/master cf3c6d50 退役，daemon-busy 检查一并移除）
        let daemonBusy = false;
        // Also check executor sessions (agentRunner bypasses daemon)
        if (!daemonBusy) {
          try {
            const snapshots = await this.fileStore.getIndex({ status: 'active' });
            const runningExecs = snapshots.filter(s => s.parentId !== null).length;
            if (runningExecs > 0) {
              daemonBusy = true;
              logger.info('[OpsService] Executor sessions active', { runningExecs });
            }
          } catch {}
        }
        if (this.stopped) return; // re-check after async gap
        if (daemonBusy) {
          logger.warn('[OpsService] Daemon busy — skipping auto-restart to avoid killing running tasks');
        } else {
          // Self-exit instead of spawning `systemctl restart` which creates orphan processes
          // and cascade loops. Systemd's Restart=always will handle the restart naturally.
          logger.error('[OpsService] API unresponsive and daemon idle — exiting for systemd restart');
          process.exit(1);
        }
        // Push alert to #系统 Channel
        try {
          const { channelMessageService } = await import('../../channels/channel-message.service.js');
          const sysChannel = (await this.fileStore.listChannels({ name: '#系统' }))[0] ?? null;
          if (sysChannel) {
            await channelMessageService.createAgentMessage(sysChannel.id, 'OpsAgent',
              `## 🚨 API 不可达告警\n\n- **端口**: ${this.port}\n- **时间**: ${new Date().toISOString()}\n- **动作**: 已触发 systemd 重启`,
              { meta: { alertType: 'api_unreachable', port: this.port, severity: 'critical' } }
            );
          }
        } catch { /* best-effort */ }
      }

      // Critical conditions → escalate
      const pct = parseInt(status.disk.usePercent);
      if (pct > this.rules.checks.disk_threshold_critical) {
        logger.error('[OpsService] CRITICAL: Disk nearly full', { usePercent: status.disk.usePercent });
        // B13-009: Record incident to KnowledgeService
        try {
          const { knowledgeService } = await import('../../knowledge/knowledge-service.js');
          knowledgeService.recordIncident({
            title: 'Disk nearly full',
            content: `Disk usage at ${status.disk.usePercent}% (threshold: ${this.rules.checks.disk_threshold_critical}%). Time: ${new Date().toISOString()}`,
            severity: 'critical',
            tags: ['ops'],
          }).catch(() => { /* non-blocking */ });
        } catch { /* non-blocking */ }
      }
      // Cloudflared tunnel check + auto-restart (if enabled)
      // C2: Worktree GC (hourly — dogfood creates many worktrees)
      const lastGC = (this as any)._lastGc || 0;
      if (Date.now() - lastGC > 60 * 60 * 1000) {
        const cleaned = await this.cleanupWorktrees();
        if (cleaned > 0) logger.info('[OpsService] Worktree GC cleaned', { cleaned });
        (this as any)._lastGc = Date.now();
      }

      if (process.env.CLOUDFLARED_ENABLED === 'true' && !this.isCloudflaredRunning()) {
        logger.warn('[OpsService] Cloudflared not running, restarting...');
        try {
          execSync(`nohup cloudflared tunnel --url http://localhost:${this.port} --no-autoupdate > /tmp/cloudflared.log 2>&1 &`, { stdio: 'pipe' });
          logger.info('[OpsService] Cloudflared restarted');
        } catch (e: any) {
          logger.error('[OpsService] Failed to restart cloudflared', { error: String(e) });
        }
      }

      // Proxy health: detect SYN-SENT → restart ss-local with rate limiting
      await this.checkProxyHealth();
    } catch (e: any) {
      logger.warn('[OpsService] Health check failed', { error: String(e) });
    }
  }

  async getStatus(): Promise<HealthStatus> {
    // 磁盘/内存/loadavg 探测走 proc-probes 单出口（零子进程，monitor 同源）
    const disk = readDiskUsage('/');
    const mem = readMemoryUsage();
    const cpuRaw = readLoadAvgRaw();

    const fmtGb = (bytes: number | null) => bytes === null ? '?' : String(Math.round(bytes / (1024 * 1024 * 1024)));
    const fmtMb = (kb: number | null) => kb === null ? '?' : String(Math.round(kb / 1024));
    const fmtPct = (pct: number | null) => pct === null ? '?' : String(pct);

    let apiResponding = false;
    try {
      const http = require('http');
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`http://localhost:${this.port}/api/v1/channels`, (res: any) => {
          apiResponding = res.statusCode === 200;
          res.resume();
          resolve();
        });
        req.on('error', () => { apiResponding = false; resolve(); });
        setTimeout(() => { req.destroy(); resolve(); }, 10_000);
      });
    } catch { apiResponding = false; }

    return {
      disk: { used: fmtGb(disk?.usedBytes ?? null) + 'G', avail: fmtGb(disk?.availBytes ?? null) + 'G', usePercent: fmtPct(disk?.usePercent ?? null) + '%' },
      memory: { total: fmtMb(mem.totalKb) + 'M', used: fmtMb(mem.usedKb) + 'M', free: fmtMb(mem.freeKb) + 'M' },
      cpu: { load: cpuRaw },
      apiResponding,
      processes: await this.countProcesses(),
      timestamp: new Date().toISOString(),
    };
  }

  // ============================================
  // Proxy Health
  // ============================================

  /**
   * Proxy health: detect SYN-SENT on proxy port → restart ss-local.
   * Rate-limited: max 3 restarts per hour. Exceeded → emit alert to Monitor.
   */
  private async checkProxyHealth(): Promise<void> {
    const PROXY_PORT = 1080;
    const MAX_RESTARTS_PER_HOUR = 3;
    const HOUR_MS = 60 * 60 * 1000;

    try {
      // Reset counter if outside the current hourly window
      if (Date.now() - this.proxyRestartWindowStart > HOUR_MS) {
        this.proxyRestartCount = 0;
        this.proxyRestartWindowStart = Date.now();
      }

      // Detect SYN-SENT connections on proxy port（async exec，不阻塞事件循环）
      const { stdout } = await execAsync(
        `ss -tnp 2>/dev/null | grep ":${PROXY_PORT}" | grep "SYN-SENT" | wc -l`,
        { timeout: 5_000 },
      );
      const synSentCount = parseInt(stdout.trim(), 10) || 0;

      if (synSentCount < 2) {
        // Proxy healthy (or acceptable transient state) — reset stale counter
        if (synSentCount === 0 && this.proxyRestartCount > 0) {
          logger.info('[OpsService] Proxy recovered', { proxyPort: PROXY_PORT });
          this.proxyRestartCount = 0;
        }
        return;
      }

      // Proxy is dead (2+ SYN-SENT)
      logger.warn('[OpsService] Proxy health degraded', { proxyPort: PROXY_PORT, synSentCount });

      // Check rate limit
      if (this.proxyRestartCount >= MAX_RESTARTS_PER_HOUR) {
        logger.error('[OpsService] Proxy restart limit exhausted', {
          proxyPort: PROXY_PORT,
          restarts: this.proxyRestartCount,
          windowStart: new Date(this.proxyRestartWindowStart).toISOString(),
        });
        await this.emitProxyRestartExhaustedAlert(synSentCount);
        return;
      }

      // Restart proxy service
      this.proxyRestartCount++;
      logger.info('[OpsService] Restarting proxy service', {
        proxyPort: PROXY_PORT,
        attempt: this.proxyRestartCount,
        maxPerHour: MAX_RESTARTS_PER_HOUR,
      });
      await execAsync('systemctl restart ss-local 2>/dev/null || true', { timeout: 10_000 });
    } catch (e: any) {
      logger.warn('[OpsService] Proxy health check failed', { error: String(e) });
    }
  }

  /**
   * Emit proxy_restart_exhausted alert when restart limit reached.
   */
  private async emitProxyRestartExhaustedAlert(synSentCount: number): Promise<void> {
    try {
      const STUDIO_EVENTS_JSONL = resolveStudioLogFile('studio-events.jsonl');
      const fs = new FileStore();
      await fs.appendJsonl(STUDIO_EVENTS_JSONL, {
        type: 'proxy_restart_exhausted',
        source: 'ops-agent',
        payload: JSON.stringify({
          proxyPort: 1080,
          synSentCount,
          restartsThisHour: this.proxyRestartCount,
          windowStart: new Date(this.proxyRestartWindowStart).toISOString(),
          timestamp: Date.now(),
        }),
        createdAt: new Date().toISOString(),
      });
    } catch (e) {
      logger.warn('[OpsService] Failed to emit proxy alert', { error: String(e) });
    }
  }

  // ============================================
  // Utilities
  // ============================================

  private isCloudflaredRunning(): boolean {
    try {
      const out = execSync('ps aux | grep "[c]loudflared tunnel" | grep -v grep | wc -l', {
        encoding: 'utf-8', stdio: 'pipe',
      }).trim();
      return parseInt(out, 10) > 0;
    } catch { return false; }
  }

  private cleanStaleProcesses(): number {
    let count = 0;
    const patterns = this.rules.checks.processes_to_clean;
    try {
      const grepPattern = patterns.map(p => `[${p.slice(0,1)}]${p.slice(1)}`).join('\\|');
      const cmd = `ps aux | grep "${grepPattern}" | grep -v grep | awk '{print $2}'`;
      const procs = execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' }).trim();
      if (procs) {
        const pids = procs.split('\n').filter(Boolean);
        for (const pid of pids) {
          try { execSync(`kill -9 ${pid.trim()} 2>/dev/null`, { stdio: 'pipe' }); count++; } catch { /* already dead */ }
        }
      }
    } catch { /* no stale processes */ }
    return count;
  }

  private async countProcesses(): Promise<number> {
    try {
      const { stdout } = await execAsync('ps aux | grep "[t]sx" | grep -v grep | wc -l', { timeout: 5_000 });
      return parseInt(stdout.trim(), 10) || 0;
    } catch { return 0; }
  }

  /**
   * C2: Worktree GC — 清理超过 7 天的旧 worktree
   *
   * 目录口径与 agent-loop.resolveWorktreesDir 一致（WORKTREES_DIR > ~/worktrees），
   * 即 WU worktree 的实际创建位置；此前默认 ~/.studio/worktrees 是扫空目录的死 GC。
   */
  async cleanupWorktrees(maxAgeDays = 7): Promise<number> {
    const worktreesDir = process.env.WORKTREES_DIR || path.join(os.homedir(), 'worktrees');
    let cleaned = 0;
    try {
      if (!fs.existsSync(worktreesDir)) return 0;
      const entries = fs.readdirSync(worktreesDir, { withFileTypes: true });
      const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const fullPath = path.join(worktreesDir, entry.name);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.mtimeMs < cutoff) {
            // Remove from git first, then delete directory
            try {
              execSync(`git worktree remove --force "${fullPath}" 2>/dev/null || true`, {
                cwd: process.env.REPO_DIR || process.cwd(), stdio: 'pipe', timeout: 10_000,
              });
            } catch { /* git cleanup best-effort */ }
            fs.rmSync(fullPath, { recursive: true, force: true });
            cleaned++;
            logger.info('[OpsService] Cleaned old worktree', { path: fullPath, age: Math.round((Date.now() - stat.mtimeMs) / 86400000) + 'd' });
          }
        } catch { /* skip problematic entries */ }
      }
    } catch (e: any) {
      logger.warn('[OpsService] Worktree GC failed', { error: String(e) });
    }
    return cleaned;
  }

  /**
   * Ensure default data exists (idempotent)
   */
  async ensureDefaults(): Promise<{ channels: number; admin: boolean }> {
    // Ensure default channels
    const defaults: Array<{ name: string; type: string }> = [
      { name: '#研发', type: 'rnd' },
      { name: '#决策', type: 'decision' },
      { name: '#系统', type: 'system' },
      { name: '#研发-dev', type: 'rnd' },       // dev 测试消息隔离
    ];
    let channelCount = 0;
    for (const d of defaults) {
      const existing = await this.fileStore.listChannels({ name: d.name });
      if (existing.length === 0) {
        const { randomUUID } = await import('crypto');
        const now = new Date().toISOString();
        await this.fileStore.createChannel({
          id: randomUUID(), name: d.name, type: d.type,
          defaultWorkspaceId: null, defaultPath: null,
          discordChannelId: null, discordWebhookUrl: null,
          members: '[]', createdAt: now, updatedAt: now,
        });
        channelCount++;
        logger.info(`[Ops] Created channel: ${d.name}`);
      }
    }
    const allCh = await this.fileStore.listChannels();
    channelCount = channelCount || allCh.length;

    // Ensure admin exists (FileStore)
    const usersDir = studioPath('data', 'users');
    let adminExists = false;
    try {
      const entries = await fs.promises.readdir(usersDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isFile() || !e.name.endsWith('.json')) continue;
        const u = await this.fileStore.readJson<any>(path.join(usersDir, e.name));
        if (u && u.role === 'Admin') { adminExists = true; break; }
      }
    } catch { /* no users dir */ }

    if (!adminExists) {
      const adminPassword = process.env.ADMIN_PASSWORD;
      if (!adminPassword) {
        logger.warn('[Ops] No admin user found and ADMIN_PASSWORD not set — skipping auto-creation. Set ADMIN_PASSWORD (and optionally ADMIN_EMAIL) to auto-create an admin on next boot.');
      } else {
        const adminEmail = process.env.ADMIN_EMAIL || 'admin@localhost';
        const now = new Date().toISOString();
        const adminId = `user_admin_${Date.now()}`;
        await fs.promises.mkdir(usersDir, { recursive: true });
        await this.fileStore.writeJson(path.join(usersDir, `${adminId}.json`), {
          id: adminId, email: adminEmail, passwordHash: hashPassword(adminPassword),
          name: 'Admin', role: 'Admin', createdAt: now, updatedAt: now,
        });
        logger.info(`[Ops] Created default admin user (${adminEmail})`);
      }
    }

    return { channels: channelCount, admin: adminExists };
  }
}

/** Factory — port from env or default */
export function createOpsService(port?: number): OpsService {
  return new OpsService(port || parseInt(process.env.PORT || '3001', 10));
}

// ── Health endpoint factory ──
import { Router, Request, Response } from 'express';
export function createHealthRoutes(ops: OpsService): Router {
  const router = Router();
  router.get('/', async (_req: Request, res: Response) => {
    try {
      const status = await ops.getStatus();
      const isHealthy = status.apiResponding;
      res.status(isHealthy ? 200 : 503).json({
        status: isHealthy ? 'healthy' : 'degraded',
        ...status,
      });
    } catch (e: any) {
      res.status(500).json({ status: 'error', error: String(e) });
    }
  });
  return router;
}
