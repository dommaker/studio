/**
 * EnvSnapper (G-003) — 系统环境自动快照
 *
 * 启动时 + 每 24h 自动拍摄环境快照，diff 变更并维护已知限制清单。
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { readFileSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';

interface SnapshotData {
  hostname: string;
  platform: string;
  nodeVersion: string;
  cpuCores: number;
  totalMemGB: number;
  apiPort: number;
  webPort: number;
  nodeEnv: string;
  dbPath: string;
  nginxConfig?: string;
  serviceManager?: string;
  tunnelType?: string;
  keyDependencies: string;
  knownLimitations: any[];
}

export class EnvSnapper {
  private timer: NodeJS.Timeout | null = null;

  /**
   * 拍摄环境快照并写入 DB
   */
  async snapshot(takenBy: 'auto' | 'manual' = 'auto'): Promise<string> {
    try {
      const data = this.collectSnapshot();
      const prev = await this.getLatestSnapshot();

      // diff
      let diffSummary = '';
      if (prev) {
        const diffs: string[] = [];
        if (prev.apiPort !== data.apiPort) diffs.push(`API port: ${prev.apiPort}→${data.apiPort}`);
        if (prev.nodeVersion !== data.nodeVersion) diffs.push(`Node: ${prev.nodeVersion}→${data.nodeVersion}`);
        if (prev.keyDependencies !== data.keyDependencies) diffs.push('dependencies changed');
        if (prev.nodeEnv !== data.nodeEnv) diffs.push(`NODE_ENV: ${prev.nodeEnv}→${data.nodeEnv}`);
        diffSummary = diffs.join('; ') || 'no changes';
      }

      const snap = await prisma.environmentSnapshot.create({
        data: {
          hostname: data.hostname,
          platform: data.platform,
          nodeVersion: data.nodeVersion,
          cpuCores: data.cpuCores,
          totalMemGB: data.totalMemGB,
          apiPort: data.apiPort,
          webPort: data.webPort,
          nodeEnv: data.nodeEnv,
          dbPath: data.dbPath,
          nginxConfig: data.nginxConfig || null,
          serviceManager: data.serviceManager || null,
          tunnelType: data.tunnelType || null,
          keyDependencies: data.keyDependencies,
          knownLimitations: JSON.stringify(data.knownLimitations),
          takenAt: new Date(),
          takenBy,
          diffFromPrev: diffSummary || null,
        },
      });

      // 清理旧快照（保留最近 30 条）
      await this.cleanupOld(30);

      logger.info('[EnvSnapper] Snapshot taken', {
        snapId: snap.id,
        diff: diffSummary || 'initial',
        nodeEnv: data.nodeEnv,
      });

      return snap.id;
    } catch (err) {
      logger.error('[EnvSnapper] Snapshot failed', { error: String(err) });
      return '';
    }
  }

  /**
   * 启动定时快照（每 24h）
   */
  startPeriodicSnapshots(): void {
    if (this.timer) return;

    // 启动时拍一次
    this.snapshot('auto');

    // 每 24 小时
    this.timer = setInterval(() => {
      this.snapshot('auto');
    }, 24 * 60 * 60 * 1000);

    logger.info('[EnvSnapper] Periodic snapshots started (24h interval)');
  }

  /**
   * 停止定时器
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /**
   * 获取最新快照
   */
  async getLatest(): Promise<Record<string, any> | null> {
    try {
      const snap = await prisma.environmentSnapshot.findFirst({
        orderBy: { takenAt: 'desc' },
      });
      if (!snap) return null;

      return {
        hostname: snap.hostname,
        platform: snap.platform,
        nodeVersion: snap.nodeVersion,
        cpuCores: snap.cpuCores,
        totalMemGB: snap.totalMemGB,
        apiPort: snap.apiPort,
        webPort: snap.webPort,
        nodeEnv: snap.nodeEnv,
        dbPath: snap.dbPath,
        keyDependencies: JSON.parse(snap.keyDependencies),
        knownLimitations: JSON.parse(snap.knownLimitations),
        nginxConfig: snap.nginxConfig,
        tunnelType: snap.tunnelType,
        takenAt: snap.takenAt,
        diffFromPrev: snap.diffFromPrev,
      };
    } catch {
      return null;
    }
  }

  /**
   * 添加已知限制
   */
  async addKnownLimitation(issue: string, since?: string): Promise<void> {
    try {
      const latest = await prisma.environmentSnapshot.findFirst({
        orderBy: { takenAt: 'desc' },
        select: { id: true, knownLimitations: true },
      });
      if (!latest) return;

      const limitations = JSON.parse(latest.knownLimitations) as any[];
      // 去重
      if (limitations.some(l => l.issue === issue)) return;

      limitations.push({ issue, since: since || new Date().toISOString().split('T')[0] });

      await prisma.environmentSnapshot.update({
        where: { id: latest.id },
        data: { knownLimitations: JSON.stringify(limitations) },
      });

      logger.info(`[EnvSnapper] Added known limitation: ${issue}`);
    } catch (err) {
      logger.error('[EnvSnapper] Failed to add limitation', { error: String(err) });
    }
  }

  /**
   * 移除已解决的已知限制
   */
  async removeKnownLimitation(issue: string): Promise<void> {
    try {
      const latest = await prisma.environmentSnapshot.findFirst({
        orderBy: { takenAt: 'desc' },
        select: { id: true, knownLimitations: true },
      });
      if (!latest) return;

      const limitations = JSON.parse(latest.knownLimitations) as any[];
      const filtered = limitations.filter(l => l.issue !== issue);

      if (filtered.length < limitations.length) {
        await prisma.environmentSnapshot.update({
          where: { id: latest.id },
          data: { knownLimitations: JSON.stringify(filtered) },
        });
        logger.info(`[EnvSnapper] Removed known limitation: ${issue}`);
      }
    } catch (err) {
      logger.error('[EnvSnapper] Failed to remove limitation', { error: String(err) });
    }
  }

  /**
   * 格式化环境信息为 prompt 注入片段
   */
  async formatForPrompt(): Promise<string> {
    const snap = await this.getLatest();
    if (!snap) return '';

    const limitations = (snap.knownLimitations as any[]) || [];
    const deps = snap.keyDependencies as Record<string, string>;

    const lines = [
      '\n## 当前环境',
      `- 环境: ${snap.nodeEnv}, 平台: ${snap.platform}, Node ${snap.nodeVersion}`,
      `- 端口: API=${snap.apiPort}, Web=${snap.webPort}`,
      `- 关键依赖: ${Object.entries(deps).map(([k, v]) => `${k}@${v}`).join(', ')}`,
    ];

    if (limitations.length > 0) {
      lines.push('- 已知限制:');
      for (const l of limitations) {
        lines.push(`  - ${l.issue} (since ${l.since})`);
      }
    }

    return lines.join('\n') + '\n';
  }

  // ── private ──

  private collectSnapshot(): SnapshotData {
    const deps: Record<string, string> = {};

    // 读取 harpress 版本
    try {
      const harnessPkg = JSON.parse(
        readFileSync(
          path.join(process.env.PROJECT_ROOT || '/root/projects/agent-studio', 'node_modules', '@dommaker', 'harness', 'package.json'),
          'utf-8',
        ),
      );
      deps.harness = harnessPkg.version;
    } catch { deps.harness = 'unknown'; }

    // prisma 版本
    try {
      const prismaPkg = JSON.parse(
        readFileSync(
          path.join(process.env.PROJECT_ROOT || '/root/projects/agent-studio', 'node_modules', '@prisma/client', 'package.json'),
          'utf-8',
        ),
      );
      deps.prisma = prismaPkg.version;
    } catch { deps.prisma = 'unknown'; }

    // nginx 配置摘要
    let nginxConfig: string | undefined;
    try {
      const nginxPath = '/etc/nginx/sites-enabled/agent-studio';
      if (existsSync(nginxPath)) {
        const nginxContent = readFileSync(nginxPath, 'utf-8');
        const serverName = nginxContent.match(/server_name\s+([^;]+);/)?.[1] || 'unknown';
        const listen = nginxContent.match(/listen\s+([^;]+);/)?.[1] || 'unknown';
        nginxConfig = `listen=${listen},server_name=${serverName}`;
      }
    } catch { /* optional */ }

    // cloudflared 检测
    let tunnelType: string | undefined;
    try {
      const { execSync } = require('child_process');
      const ps = execSync('ps aux | grep cloudflared | grep -v grep || echo ""', { timeout: 3000 }).toString().trim();
      tunnelType = ps ? 'cloudflared' : undefined;
    } catch { /* optional */ }

    const knownLimitations = this.getDefaultLimitations();

    return {
      hostname: os.hostname(),
      platform: process.platform,
      nodeVersion: process.version,
      cpuCores: os.cpus().length,
      totalMemGB: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10,
      apiPort: parseInt(process.env.PORT || '13001'),
      webPort: 5173,
      nodeEnv: process.env.NODE_ENV || 'development',
      dbPath: process.env.DATABASE_URL || 'file:./prisma/dev.db',
      keyDependencies: JSON.stringify(deps),
      nginxConfig,
      tunnelType,
      knownLimitations,
    };
  }

  private getDefaultLimitations(): any[] {
    const lims: any[] = [];
    // SQLite 已知限制
    lims.push({ issue: 'SQLite 不支持并发写', since: '2026-05-08' });
    // Discord .cn 域名
    lims.push({ issue: 'Discord 无法访问 .cn 域名 (Interactions Endpoint)', since: '2026-05-10' });
    return lims;
  }

  private async getLatestSnapshot(): Promise<SnapshotData | null> {
    const snap = await this.getLatest();
    if (!snap) return null;
    return snap as unknown as SnapshotData;
  }

  private async cleanupOld(keepCount: number): Promise<void> {
    try {
      const snapshots = await prisma.environmentSnapshot.findMany({
        orderBy: { takenAt: 'desc' },
        select: { id: true },
        skip: keepCount,
      });
      if (snapshots.length > 0) {
        await prisma.environmentSnapshot.deleteMany({
          where: { id: { in: snapshots.map(s => s.id) } },
        });
      }
    } catch { /* non-blocking */ }
  }
}

export const envSnapper = new EnvSnapper();
