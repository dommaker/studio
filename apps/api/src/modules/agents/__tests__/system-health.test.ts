import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Mock os module
vi.mock('os', () => ({
  loadavg: () => [2.5, 1.5, 0.8],
  cpus: () => Array(4).fill({}),
  totalmem: () => 16 * 1024 * 1024 * 1024, // 16GB
  freemem: () => 4 * 1024 * 1024 * 1024,   // 4GB (75% used)
}));

// Mock dynamic imports used by collectDb() and collectWorkunitStats()
vi.mock('@dommaker/studio-prisma', () => ({
  prisma: { $queryRawUnsafe: vi.fn().mockResolvedValue([{ 1: 1 }]) },
}));

vi.mock('@dommaker/studio-shared', () => {
  const FileStore = vi.fn();
  FileStore.prototype.getIndex = vi.fn().mockResolvedValue([]);
  FileStore.prototype.listStates = vi.fn().mockResolvedValue([]);
  FileStore.prototype.listProfiles = vi.fn().mockResolvedValue([]);
  return { FileStore, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } };
});

// 数据根入口走真实现会撞上面的 os mock（无 homedir），这里钉一个 env 敏感的等价物：
// 断言的边界是「runGC 经 studioPath/STUDIO_HOME 解析 sessions 目录」而非 studioDir 本身。
vi.mock('@dommaker/studio-shared/studio-dir', async () => {
  const path = await import('path');
  return {
    studioPath: (...segments: string[]) =>
      path.join(process.env.STUDIO_HOME ?? '/nonexistent-studio-home', ...segments),
  };
});

// Mock process.memoryUsage
vi.spyOn(process, 'memoryUsage').mockReturnValue({
  heapUsed: 200 * 1024 * 1024, // 200MB
  heapTotal: 300 * 1024 * 1024,
  external: 10 * 1024 * 1024,
  rss: 500 * 1024 * 1024,
  arrayBuffers: 0,
});

describe('collectSystemHealth', () => {
  it('collects CPU stats', async () => {
    const { collectSystemHealth } = await import('../ops/system-health');
    const snapshot = await collectSystemHealth();
    expect(snapshot.cpu.loadAvg).toBe(2.5);
    expect(snapshot.cpu.cores).toBe(4);
  });

  it('collects memory stats', async () => {
    const { collectSystemHealth } = await import('../ops/system-health');
    const snapshot = await collectSystemHealth();
    expect(snapshot.memory.heapUsedMB).toBeGreaterThan(0);
    expect(snapshot.memory.percentUsed).toBeGreaterThan(0);
  });

  it('returns complete snapshot structure', async () => {
    const { collectSystemHealth } = await import('../ops/system-health');
    const snapshot = await collectSystemHealth();
    expect(snapshot).toHaveProperty('timestamp');
    expect(snapshot).toHaveProperty('cpu');
    expect(snapshot).toHaveProperty('memory');
    expect(snapshot).toHaveProperty('disk');
    expect(snapshot).toHaveProperty('db');
    expect(snapshot).toHaveProperty('workunits');
  });
});

describe('checkThresholds', () => {
  it('returns critical alert when CPU load exceeds cores', async () => {
    const { checkThresholds } = await import('../ops/system-health');
    const snapshot = {
      cpu: { loadAvg: 5, cores: 4 },
      memory: { heapUsedMB: 100, percentUsed: 50 },
      disk: { percentUsed: 50, path: '/' },
      db: { connected: true, zombieProcesses: 0 },
      workunits: { activeCount: 2, stalledCount: 0, overtimeCount: 0, failureRate: 0 },
      timestamp: new Date(),
    };
    const alerts = await checkThresholds(snapshot);
    expect(alerts.some(a => a.category === 'cpu' && a.severity === 'critical')).toBe(true);
  });

  it('returns critical alert when disk > 90%', async () => {
    const { checkThresholds } = await import('../ops/system-health');
    const snapshot = {
      cpu: { loadAvg: 1, cores: 4 },
      memory: { heapUsedMB: 100, percentUsed: 50 },
      disk: { percentUsed: 95, path: '/' },
      db: { connected: true, zombieProcesses: 0 },
      workunits: { activeCount: 2, stalledCount: 0, overtimeCount: 0, failureRate: 0 },
      timestamp: new Date(),
    };
    const alerts = await checkThresholds(snapshot);
    expect(alerts.some(a => a.category === 'disk')).toBe(true);
  });

  it('returns empty array when all within thresholds', async () => {
    const { checkThresholds } = await import('../ops/system-health');
    const snapshot = {
      cpu: { loadAvg: 1, cores: 4 },
      memory: { heapUsedMB: 100, percentUsed: 50 },
      disk: { percentUsed: 50, path: '/' },
      db: { connected: true, zombieProcesses: 0 },
      workunits: { activeCount: 1, stalledCount: 0, overtimeCount: 0, failureRate: 0 },
      timestamp: new Date(),
    };
    const alerts = await checkThresholds(snapshot);
    expect(alerts).toEqual([]);
  });

  it('returns warning when heapUsedMB > 512', async () => {
    const { checkThresholds } = await import('../ops/system-health');
    const snapshot = {
      cpu: { loadAvg: 1, cores: 4 },
      memory: { heapUsedMB: 600, percentUsed: 50 },
      disk: { percentUsed: 50, path: '/' },
      db: { connected: true, zombieProcesses: 0 },
      workunits: { activeCount: 2, stalledCount: 0, overtimeCount: 0, failureRate: 0 },
      timestamp: new Date(),
    };
    const alerts = await checkThresholds(snapshot);
    expect(alerts.some(a => a.category === 'memory' && a.severity === 'warning')).toBe(true);
  });

  it('returns critical when memory percentUsed > 80', async () => {
    const { checkThresholds } = await import('../ops/system-health');
    const snapshot = {
      cpu: { loadAvg: 1, cores: 4 },
      memory: { heapUsedMB: 100, percentUsed: 85 },
      disk: { percentUsed: 50, path: '/' },
      db: { connected: true, zombieProcesses: 0 },
      workunits: { activeCount: 2, stalledCount: 0, overtimeCount: 0, failureRate: 0 },
      timestamp: new Date(),
    };
    const alerts = await checkThresholds(snapshot);
    expect(alerts.some(a => a.category === 'memory' && a.severity === 'critical')).toBe(true);
  });
});

describe('runGC', () => {
  it('returns success result structure', async () => {
    const { runGC } = await import('../ops/system-health');
    const result = await runGC();
    expect(result).toHaveProperty('cleaned');
    expect(result).toHaveProperty('details');
    expect(result).toHaveProperty('duration');
    expect(Array.isArray(result.details)).toBe(true);
    expect(typeof result.duration).toBe('number');
  });

  it('cleans stale sessions under STUDIO_HOME（经 studioPath，不硬编码 ~/.studio）', async () => {
    const fs = await import('fs');
    const osReal = await vi.importActual<typeof import('os')>('os');
    const path = await import('path');
    const tmpRoot = fs.mkdtempSync(path.join(osReal.tmpdir(), 'studio-gc-'));
    const sessionsDir = path.join(tmpRoot, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const staleFile = path.join(sessionsDir, 'stale.json');
    fs.writeFileSync(staleFile, '{}');
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    fs.utimesSync(staleFile, old, old);

    vi.stubEnv('STUDIO_HOME', tmpRoot);
    try {
      const { runGC } = await import('../ops/system-health');
      const result = await runGC();
      expect(fs.existsSync(staleFile)).toBe(false);
      expect(result.details.some((d) => d.includes('stale.json'))).toBe(true);
    } finally {
      vi.unstubAllEnvs();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });
});
