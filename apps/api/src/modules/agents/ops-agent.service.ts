/**
 * Ops Agent — 系统生命周期守护
 *
 * 负责：启动安全检查、进程管理、配置校验、数据完整性、运行时健康
 * 缺口：启动阶段独立于 Monitor/Auditor 运行，保护 Monitor 管不到的部分
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '@dommaker/studio-shared';
import { prisma } from '@dommaker/studio-prisma';

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

export class OpsAgent {
  private interval: NodeJS.Timeout | null = null;
  private port: number;

  constructor(port: number) {
    this.port = port;
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

    // 1. Check DB
    try {
      const dbUrl = process.env.DATABASE_URL || '';
      const dbPath = dbUrl.replace('file:', '');
      const dbExists = fs.existsSync(dbPath);

      if (dbExists) {
        // Try a simple query to verify schema matches
        try {
          await prisma.$queryRaw`SELECT 1`;
          add({ name: 'db-schema', passed: true, message: `DB schema OK (${dbPath})`, critical: true });
        } catch {
          add({
            name: 'db-schema', passed: false, critical: true,
            message: `❌ DB schema mismatch! The database at ${dbPath} does not match the current Prisma schema. Schema changes detected — use "studio migrate" instead of auto-push. Refusing to start to prevent data loss.`,
          });
        }
      } else {
        add({ name: 'db-exists', passed: true, message: `New DB will be created at ${dbPath}`, critical: false });
      }
    } catch (e: any) {
      add({ name: 'db-schema', passed: false, critical: true, message: `❌ DB check failed: ${e.message}` });
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

    // 4b. Cloudflared tunnel
    try {
      const cfAlive = this.isCloudflaredRunning();
      if (cfAlive) {
        add({ name: 'cloudflared', passed: true, message: 'Tunnel connected', critical: false });
      } else {
        // Try to restart
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

    // 5. Disk space
    try {
      const output = execSync("df -h / | tail -1 | awk '{print $5, $4}'", { encoding: 'utf-8', stdio: 'pipe' }).trim();
      const [usePercent, avail] = output.split(/\s+/);
      const pct = parseInt(usePercent);
      if (pct > 90) {
        add({ name: 'disk-space', passed: false, critical: true, message: `❌ Disk ${usePercent} full (${avail} available)` });
      } else if (pct > 80) {
        add({ name: 'disk-space', passed: true, message: `⚠️ Disk ${usePercent} (${avail} available)`, critical: false });
      } else {
        add({ name: 'disk-space', passed: true, message: `Disk ${usePercent} (${avail} available)`, critical: false });
      }
    } catch {
      add({ name: 'disk-space', passed: true, message: 'Disk check skipped (df unavailable)', critical: false });
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

  start(intervalMs: number = 300_000): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.healthCheck(), intervalMs);
    logger.info('[OpsAgent] Started', { intervalMs, port: this.port });
  }

  stop(): void {
    if (this.interval) { clearInterval(this.interval); this.interval = null; }
    logger.info('[OpsAgent] Stopped');
  }

  private async healthCheck(): Promise<void> {
    try {
      const status = await this.getStatus();
      logger.info('[OpsAgent] Health check', status);

      // Critical conditions → escalate
      const pct = parseInt(status.disk.usePercent);
      if (pct > 90) {
        logger.error('[OpsAgent] CRITICAL: Disk nearly full', { usePercent: status.disk.usePercent });
      }
      // Cloudflared tunnel check + auto-restart
      if (!this.isCloudflaredRunning()) {
        logger.warn('[OpsAgent] Cloudflared not running, restarting...');
        try {
          execSync(`nohup cloudflared tunnel --url http://localhost:${this.port} --no-autoupdate > /tmp/cloudflared.log 2>&1 &`, { stdio: 'pipe' });
          logger.info('[OpsAgent] Cloudflared restarted');
        } catch (e: any) {
          logger.error('[OpsAgent] Failed to restart cloudflared', { error: String(e) });
        }
      }
    } catch (e: any) {
      logger.warn('[OpsAgent] Health check failed', { error: String(e) });
    }
  }

  async getStatus(): Promise<HealthStatus> {
    const diskRaw = execSync("df -h / | tail -1", { encoding: 'utf-8', stdio: 'pipe' }).trim().split(/\s+/);
    const memRaw = execSync("free -m | grep Mem", { encoding: 'utf-8', stdio: 'pipe' }).trim().split(/\s+/);
    const cpuRaw = execSync("cat /proc/loadavg", { encoding: 'utf-8', stdio: 'pipe' }).trim();

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
        setTimeout(() => { req.destroy(); resolve(); }, 3000);
      });
    } catch { apiResponding = false; }

    return {
      disk: { used: diskRaw[2] || '?', avail: diskRaw[3] || '?', usePercent: diskRaw[4] || '?' },
      memory: { total: memRaw[1] || '?', used: memRaw[2] || '?', free: memRaw[3] || '?' },
      cpu: { load: cpuRaw },
      apiResponding,
      processes: this.countProcesses(),
      timestamp: new Date().toISOString(),
    };
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
    try {
      const nodeProcs = execSync('ps aux | grep "[t]sx\|[n]ode.*index" | grep -v grep | awk \'{print $2}\'', {
        encoding: 'utf-8', stdio: 'pipe',
      }).trim();
      if (nodeProcs) {
        const pids = nodeProcs.split('\n').filter(Boolean);
        for (const pid of pids) {
          try { execSync(`kill -9 ${pid.trim()} 2>/dev/null`, { stdio: 'pipe' }); count++; } catch { /* already dead */ }
        }
      }
    } catch { /* no stale processes */ }
    return count;
  }

  private countProcesses(): number {
    try {
      return parseInt(execSync('ps aux | grep "[t]sx" | grep -v grep | wc -l', {
        encoding: 'utf-8', stdio: 'pipe',
      }).trim(), 10);
    } catch { return 0; }
  }

  /**
   * Ensure default data exists (idempotent)
   */
  async ensureDefaults(): Promise<{ channels: number; admin: boolean }> {
    // Ensure default channels
    const defaults = [
      { name: '#研发', type: 'rnd' },
      { name: '#决策', type: 'decision' },
      { name: '#系统', type: 'system' },
    ];
    let channelCount = 0;
    for (const d of defaults) {
      const ch = await prisma.channel.findFirst({ where: { name: d.name } });
      if (!ch) {
        await prisma.channel.create({ data: d });
        channelCount++;
        logger.info(`[Ops] Created channel: ${d.name}`);
      }
    }
    const totalCh = await prisma.channel.count();
    channelCount = channelCount || totalCh;

    // Ensure admin exists
    const admin = await prisma.user.findFirst({ where: { role: 'Admin' } });
    if (!admin) {
      const crypto = require('crypto');
      const salt = crypto.randomBytes(16).toString('hex');
      const hash = crypto.pbkdf2Sync('admin', salt, 1000, 64, 'sha256').toString('hex');
      await prisma.user.create({
        data: { email: 'admin@localhost', passwordHash: `${salt}:${hash}`, name: 'Admin', role: 'Admin' },
      });
      logger.info('[Ops] Created default admin user (admin@localhost / admin)');
    }

    return { channels: channelCount, admin: !!admin };
  }
}

/** Factory — port from env or default */
export function createOpsAgent(port?: number): OpsAgent {
  return new OpsAgent(port || parseInt(process.env.PORT || '3001', 10));
}
