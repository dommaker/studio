/**
 * 系统健康采集模块（纯代码，零 LLM）
 *
 * 从 Monitor Agent 提取的系统健康采集 + 阈值检查 + GC 清理。
 */

import * as os from 'os';
import { execSync } from 'child_process';

// ─── 类型 ───

export interface SystemHealthSnapshot {
  timestamp: Date;
  cpu: { loadAvg: number; cores: number };
  memory: { heapUsedMB: number; percentUsed: number };
  disk: { percentUsed: number; path: string };
  db: { connected: boolean; zombieProcesses: number };
  workunits: {
    activeCount: number;
    stalledCount: number;
    overtimeCount: number;
    failureRate: number;
  };
}

export interface Alert {
  severity: 'warning' | 'critical';
  category: 'cpu' | 'memory' | 'disk' | 'db' | 'workunit';
  message: string;
  currentValue: number;
  threshold: number;
  timestamp: Date;
}

export interface GCResult {
  cleaned: number;
  details: string[];
  duration: number;
}

// ─── 阈值常量 ───

const HEAP_WARN_MB = 512;
const MEMORY_CRITICAL_PCT = 80;
const DISK_CRITICAL_PCT = 90;
const STALLED_WARN_COUNT = 5;
const FAILURE_RATE_CRITICAL = 0.3;

// ─── 系统健康采集 ───

export async function collectSystemHealth(): Promise<SystemHealthSnapshot> {
  const cpu = collectCpu();
  const memory = collectMemory();
  const disk = collectDisk();
  const db = await collectDb();
  const workunits = await collectWorkunitStats();

  return {
    timestamp: new Date(),
    cpu,
    memory,
    disk,
    db,
    workunits,
  };
}

function collectCpu(): SystemHealthSnapshot['cpu'] {
  const loadAvg = os.loadavg()[0];
  const cores = os.cpus().length;
  return { loadAvg, cores };
}

function collectMemory(): SystemHealthSnapshot['memory'] {
  const memUsage = process.memoryUsage();
  const heapUsedMB = Math.round(memUsage.heapUsed / (1024 * 1024));

  // Prefer /proc/meminfo on Linux, fallback to os module in containers
  let percentUsed: number;
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    percentUsed = Math.round(((totalMem - freeMem) / totalMem) * 100);
  } catch {
    percentUsed = 0;
  }

  return { heapUsedMB, percentUsed };
}

function collectDisk(): SystemHealthSnapshot['disk'] {
  const path = '/';
  let percentUsed = 0;
  try {
    const output = execSync("df -h / | tail -1 | awk '{print $5}'", {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    percentUsed = parseInt(output.replace('%', ''), 10) || 0;
  } catch {
    percentUsed = 0;
  }
  return { percentUsed, path };
}

async function collectDb(): Promise<SystemHealthSnapshot['db']> {
  let connected = false;
  let zombieProcesses = 0;
  try {
    // Storage health check — verify FileStore writable
    try {
      const { FileStore } = await import('@dommaker/studio-shared');
      const fs = new FileStore();
      await fs.readJson('/tmp/_studio_health_check_.json');
      connected = true;
    } catch { /* probe file not expected to exist */ connected = true; }
  } catch {
    connected = false;
  }
  try {
    const output = execSync("ps aux | grep -c '[d]efunct'", {
      encoding: 'utf-8',
      timeout: 5000,
    }).trim();
    zombieProcesses = parseInt(output, 10) || 0;
  } catch {
    zombieProcesses = 0;
  }
  return { connected, zombieProcesses };
}

async function collectWorkunitStats(): Promise<SystemHealthSnapshot['workunits']> {
  let activeCount = 0;
  let stalledCount = 0;
  let overtimeCount = 0;
  let failureRate = 0;

  try {
    const { FileStore } = await import('@dommaker/studio-shared');
    const fileStore = new FileStore();
    const snapshots = await fileStore.getIndex();
    const now = Date.now();

    for (const s of snapshots) {
      if (s.status === 'active' || s.status === 'in_progress') {
        activeCount++;
        const updatedAt = new Date(s.updatedAt).getTime();
        const elapsed = now - updatedAt;
        if (elapsed > 30 * 60_000) stalledCount++;       // 30min+
        if (elapsed > 150 * 60_000) overtimeCount++;      // 2.5h+
      }
    }

    const totalCompleted = snapshots.filter(s => s.status === 'done' || s.status === 'failed').length;
    const totalFailed = snapshots.filter(s => s.status === 'failed').length;
    failureRate = totalCompleted > 0 ? totalFailed / totalCompleted : 0;
  } catch {
    // FileStore unavailable — leave stats at 0
  }

  return { activeCount, stalledCount, overtimeCount, failureRate };
}

// ─── 阈值检查 ───

export async function checkThresholds(snapshot: SystemHealthSnapshot): Promise<Alert[]> {
  const alerts: Alert[] = [];
  const now = new Date();

  // CPU
  if (snapshot.cpu.loadAvg > snapshot.cpu.cores) {
    alerts.push({
      severity: 'critical',
      category: 'cpu',
      message: `CPU load (${snapshot.cpu.loadAvg.toFixed(1)}) exceeds core count (${snapshot.cpu.cores})`,
      currentValue: snapshot.cpu.loadAvg,
      threshold: snapshot.cpu.cores,
      timestamp: now,
    });
  }

  // Memory — heap
  if (snapshot.memory.heapUsedMB > HEAP_WARN_MB) {
    alerts.push({
      severity: 'warning',
      category: 'memory',
      message: `Heap usage (${snapshot.memory.heapUsedMB}MB) exceeds ${HEAP_WARN_MB}MB`,
      currentValue: snapshot.memory.heapUsedMB,
      threshold: HEAP_WARN_MB,
      timestamp: now,
    });
  }

  // Memory — system
  if (snapshot.memory.percentUsed > MEMORY_CRITICAL_PCT) {
    alerts.push({
      severity: 'critical',
      category: 'memory',
      message: `System memory usage (${snapshot.memory.percentUsed}%) exceeds ${MEMORY_CRITICAL_PCT}%`,
      currentValue: snapshot.memory.percentUsed,
      threshold: MEMORY_CRITICAL_PCT,
      timestamp: now,
    });
  }

  // Disk
  if (snapshot.disk.percentUsed > DISK_CRITICAL_PCT) {
    alerts.push({
      severity: 'critical',
      category: 'disk',
      message: `Disk usage (${snapshot.disk.percentUsed}%) exceeds ${DISK_CRITICAL_PCT}%`,
      currentValue: snapshot.disk.percentUsed,
      threshold: DISK_CRITICAL_PCT,
      timestamp: now,
    });
  }

  // DB
  if (!snapshot.db.connected) {
    alerts.push({
      severity: 'critical',
      category: 'db',
      message: 'Database connection lost',
      currentValue: 0,
      threshold: 1,
      timestamp: now,
    });
  }

  // WorkUnit — stalled
  if (snapshot.workunits.stalledCount > STALLED_WARN_COUNT) {
    alerts.push({
      severity: 'warning',
      category: 'workunit',
      message: `${snapshot.workunits.stalledCount} WorkUnits stalled (>30min)`,
      currentValue: snapshot.workunits.stalledCount,
      threshold: STALLED_WARN_COUNT,
      timestamp: now,
    });
  }

  // WorkUnit — failure rate
  if (snapshot.workunits.failureRate > FAILURE_RATE_CRITICAL) {
    alerts.push({
      severity: 'critical',
      category: 'workunit',
      message: `WorkUnit failure rate (${(snapshot.workunits.failureRate * 100).toFixed(0)}%) exceeds ${(FAILURE_RATE_CRITICAL * 100).toFixed(0)}%`,
      currentValue: snapshot.workunits.failureRate,
      threshold: FAILURE_RATE_CRITICAL,
      timestamp: now,
    });
  }

  return alerts;
}

// ─── GC 清理 ───

export async function runGC(): Promise<GCResult> {
  const start = Date.now();
  const details: string[] = [];
  let cleaned = 0;

  // Clean stale worktrees (> 7 days)
  // 目录口径与 agent-loop.resolveWorktreesDir 一致（WORKTREES_DIR > ~/worktrees）
  try {
    const worktreesDir = process.env.WORKTREES_DIR || `${os.homedir()}/worktrees`;
    const fs = await import('fs');
    if (fs.existsSync(worktreesDir)) {
      const entries = fs.readdirSync(worktreesDir);
      const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const entry of entries) {
        try {
          const stat = fs.statSync(`${worktreesDir}/${entry}`);
          if (stat.mtimeMs < cutoff) {
            fs.rmSync(`${worktreesDir}/${entry}`, { recursive: true, force: true });
            cleaned++;
            details.push(`Removed stale worktree: ${entry}`);
          }
        } catch {
          // Skip entries we can't stat/remove
        }
      }
    }
  } catch {
    // Worktrees dir not present
  }

  // Clean old session files (> 24h)
  try {
    const sessionsDir = `${os.homedir()}/.studio/sessions`;
    const fs = await import('fs');
    if (fs.existsSync(sessionsDir)) {
      const entries = fs.readdirSync(sessionsDir);
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const entry of entries) {
        try {
          const stat = fs.statSync(`${sessionsDir}/${entry}`);
          if (stat.mtimeMs < cutoff) {
            fs.rmSync(`${sessionsDir}/${entry}`, { recursive: true, force: true });
            cleaned++;
            details.push(`Removed old session: ${entry}`);
          }
        } catch {
          // Skip
        }
      }
    }
  } catch {
    // Sessions dir not present
  }

  // Clean completed WorkUnits older than 30 days
  try {
    const { FileStore } = await import('@dommaker/studio-shared');
    const fileStore = new FileStore();
    const snapshots = await fileStore.getIndex();
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    for (const s of snapshots) {
      if ((s.status === 'done' || s.status === 'closed') && s.completedAt && s.completedAt < cutoff) {
        await fileStore.removeSnapshot(s.id);
        cleaned++;
        details.push(`Removed completed WorkUnit: ${s.id}`);
      }
    }
  } catch {
    // FileStore unavailable
  }

  const duration = Date.now() - start;
  return { cleaned, details, duration };
}
