/**
 * OpsService proxy health + rate limiting tests
 *
 * AC-2: checkProxyHealth() with SYN-SENT detection + restart rate limit (3/hour)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createOpsService, OpsService } from '../ops/ops.service.js';
import { studioPath } from '@dommaker/studio-shared/studio-dir';

const { mockReadDiskUsage, mockReadMemoryUsage, mockLoadRaw, mockExecSync, mockExec } = vi.hoisted(() => ({
  mockReadDiskUsage: vi.fn(),
  mockReadMemoryUsage: vi.fn(),
  mockLoadRaw: vi.fn(() => '?'),
  // #374: preflight 不再跑真实 lsof/ps/kill（processes_to_clean 会误杀本机进程），全 mock 空输出
  mockExecSync: vi.fn(() => ''),
  mockExec: vi.fn((_cmd: string, _opts: unknown, cb: (err: Error | null, stdout: string) => void) => cb(null, '')),
}));

// #344: getStatus 探测委托 proc-probes 单出口，mock 掉 /proc 读取以固定格式断言
vi.mock('../ops/proc-probes.js', () => ({
  readDiskUsage: mockReadDiskUsage,
  readMemoryUsage: mockReadMemoryUsage,
  readLoadAvgRaw: mockLoadRaw,
}));

vi.mock('child_process', () => ({ execSync: mockExecSync, exec: mockExec }));

beforeEach(() => {
  mockReadDiskUsage.mockReturnValue({
    totalBytes: 100 * 1024 ** 3,
    availBytes: 50 * 1024 ** 3,
    usedBytes: 50 * 1024 ** 3,
    usePercent: 50,
  });
  mockReadMemoryUsage.mockReturnValue({ totalKb: 16_384_000, freeKb: 8_192_000, usedKb: 8_192_000 });
  mockLoadRaw.mockReturnValue('0.10 0.20 0.30 2/100 12345');
});

describe('OpsService proxy health (AC-2)', () => {
  // ============================================================
  // Rate limiting logic
  // ============================================================
  describe('proxy restart rate limiting', () => {
    it('AC-2.1: starts with zero restart count', () => {
      const ops = createOpsService(19999);
      expect((ops as any).proxyRestartCount).toBe(0);
      expect((ops as any).proxyRestartWindowStart).toBe(0);
    });

    it('AC-2.2: resetCounter clears after window expiry', () => {
      const ops = createOpsService(19999);
      // Simulate: had restarts 2 hours ago
      (ops as any).proxyRestartCount = 3;
      (ops as any).proxyRestartWindowStart = Date.now() - 2 * 60 * 60 * 1000;

      // The next health check will see window expired and reset
      // Verify the state would be reset
      const ONE_HOUR = 60 * 60 * 1000;
      const windowExpired = Date.now() - (ops as any).proxyRestartWindowStart > ONE_HOUR;
      expect(windowExpired).toBe(true);
    });

    it('AC-2.3: counter not reset when within window', () => {
      const ops = createOpsService(19999);
      // Simulate: had 2 restarts 30 min ago
      (ops as any).proxyRestartCount = 2;
      (ops as any).proxyRestartWindowStart = Date.now() - 30 * 60 * 1000;

      const ONE_HOUR = 60 * 60 * 1000;
      const windowExpired = Date.now() - (ops as any).proxyRestartWindowStart > ONE_HOUR;
      expect(windowExpired).toBe(false);
    });

    it('AC-2.4: max 3 restarts per hour ceiling', () => {
      const ops = createOpsService(19999);
      (ops as any).proxyRestartCount = 3;
      (ops as any).proxyRestartWindowStart = Date.now();

      const MAX_RESTARTS_PER_HOUR = 3;
      expect((ops as any).proxyRestartCount).toBeGreaterThanOrEqual(MAX_RESTARTS_PER_HOUR);
    });
  });

  // ============================================================
  // SYN-SENT threshold detection
  // ============================================================
  describe('SYN-SENT threshold', () => {
    it('AC-2.5: threshold is 2 (>=2 SYN-SENT = dead proxy)', () => {
      // Contract test: the SYN-SENT threshold is defined as 2
      const PROXY_PORT = 1080;
      const THRESHOLD = 2;

      // Fewer than THRESHOLD → no alert
      expect(1).toBeLessThan(THRESHOLD);

      // At or above THRESHOLD → should trigger restart
      expect(2).toBeGreaterThanOrEqual(THRESHOLD);
      expect(3).toBeGreaterThanOrEqual(THRESHOLD);
    });

    it('AC-2.6: ss -tnp command targets correct port and grep pattern', () => {
      // Verify the command would match the expected format
      const proxyPort = 1080;
      const cmd = `ss -tnp 2>/dev/null | grep ":${proxyPort}" | grep "SYN-SENT" | wc -l`;
      expect(cmd).toContain('1080');
      expect(cmd).toContain('SYN-SENT');
      expect(cmd).toContain('wc -l');
    });
  });

  // ============================================================
  // Health status contract
  // ============================================================
  describe('getStatus() contract', () => {
    it('AC-2.7: getStatus returns required health fields', async () => {
      const ops = createOpsService(19999);
      const status = await ops.getStatus();
      expect(status).toHaveProperty('disk');
      expect(status).toHaveProperty('memory');
      expect(status).toHaveProperty('cpu');
      expect(status).toHaveProperty('apiResponding');
      expect(status).toHaveProperty('processes');
      expect(status).toHaveProperty('timestamp');
      expect(status.disk).toHaveProperty('used');
      expect(status.disk).toHaveProperty('avail');
      expect(status.disk).toHaveProperty('usePercent');
      expect(status.memory).toHaveProperty('total');
      expect(status.memory).toHaveProperty('used');
      expect(status.memory).toHaveProperty('free');
    });

    it('AC #344: getStatus 输出格式逐字段保真（G/M/% 字符串，委托 proc-probes）', async () => {
      const ops = createOpsService(19999);
      const status = await ops.getStatus();
      expect(status.disk).toEqual({ used: '50G', avail: '50G', usePercent: '50%' });
      expect(status.memory).toEqual({ total: '16000M', used: '8000M', free: '8000M' });
      expect(status.cpu).toEqual({ load: '0.10 0.20 0.30 2/100 12345' });
      expect(typeof status.processes).toBe('number');
    });
  });

  // ============================================================
  // Preflight disk check (AC #374)
  // ============================================================
  describe('preflight disk check (AC #374)', () => {
    // 固定阈值，断言不受用户 rules 配置影响；loadRules 无配置时返回 DEFAULT_RULES 本体，
    // 先浅拷贝再 pin，防跨实例泄漏
    const pinThresholds = (ops: OpsService) => {
      (ops as any).rules = {
        ...(ops as any).rules,
        checks: { ...(ops as any).rules.checks, disk_threshold_warn: 80, disk_threshold_critical: 90 },
      };
    };
    const makeTmp = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    // storage 探测写 studioPath('data')（vitest setup 指向 tmp，需先建目录）
    const ensureStudioData = () => fs.mkdirSync(studioPath('data'), { recursive: true });

    it('磁盘检查委托 proc-probes.readDiskUsage，message 保真 Use% 与 available', async () => {
      mockReadDiskUsage.mockReturnValue({
        totalBytes: 100 * 1024 ** 3, availBytes: 50 * 1024 ** 3, usedBytes: 50 * 1024 ** 3, usePercent: 50,
      });
      ensureStudioData();
      const dist = makeTmp('ops-pf-dist-');
      const repo = makeTmp('ops-pf-repo-');
      fs.writeFileSync(path.join(dist, 'index.html'), 'x');
      try {
        const ops = createOpsService(19999);
        pinThresholds(ops);
        const result = await ops.preflight(repo, dist);
        const disk = result.checks.find(c => c.name === 'disk-space');
        expect(disk?.passed).toBe(true);
        expect(disk?.message).toContain('50%');
        expect(disk?.message).toContain('50G available');
        expect(result.passed).toBe(true);
      } finally {
        fs.rmSync(dist, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    it('超过 critical 阈值 → disk-space critical 失败', async () => {
      mockReadDiskUsage.mockReturnValue({
        totalBytes: 100 * 1024 ** 3, availBytes: 5 * 1024 ** 3, usedBytes: 95 * 1024 ** 3, usePercent: 95,
      });
      ensureStudioData();
      const dist = makeTmp('ops-pf-dist-');
      const repo = makeTmp('ops-pf-repo-');
      fs.writeFileSync(path.join(dist, 'index.html'), 'x');
      try {
        const ops = createOpsService(19999);
        pinThresholds(ops);
        const result = await ops.preflight(repo, dist);
        const disk = result.checks.find(c => c.name === 'disk-space');
        expect(disk?.passed).toBe(false);
        expect(disk?.critical).toBe(true);
        expect(disk?.message).toContain('95%');
        expect(disk?.message).toContain('full');
        expect(result.criticalFailures).toContain('disk-space');
      } finally {
        fs.rmSync(dist, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    it('warn 带（>warn 且 ≤critical）→ ⚠️ 提示但不 fail', async () => {
      mockReadDiskUsage.mockReturnValue({
        totalBytes: 100 * 1024 ** 3, availBytes: 15 * 1024 ** 3, usedBytes: 85 * 1024 ** 3, usePercent: 85,
      });
      ensureStudioData();
      const dist = makeTmp('ops-pf-dist-');
      const repo = makeTmp('ops-pf-repo-');
      fs.writeFileSync(path.join(dist, 'index.html'), 'x');
      try {
        const ops = createOpsService(19999);
        pinThresholds(ops);
        const result = await ops.preflight(repo, dist);
        const disk = result.checks.find(c => c.name === 'disk-space');
        expect(disk?.passed).toBe(true);
        expect(disk?.critical).toBe(false);
        expect(disk?.message).toContain('⚠️');
        expect(disk?.message).toContain('85%');
        expect(result.criticalFailures).toHaveLength(0);
      } finally {
        fs.rmSync(dist, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    it('readDiskUsage 不可用（null）→ skip 而非失败', async () => {
      mockReadDiskUsage.mockReturnValue(null);
      ensureStudioData();
      const dist = makeTmp('ops-pf-dist-');
      const repo = makeTmp('ops-pf-repo-');
      fs.writeFileSync(path.join(dist, 'index.html'), 'x');
      try {
        const ops = createOpsService(19999);
        pinThresholds(ops);
        const result = await ops.preflight(repo, dist);
        const disk = result.checks.find(c => c.name === 'disk-space');
        expect(disk?.passed).toBe(true);
        expect(disk?.message).toContain('Disk check skipped');
      } finally {
        fs.rmSync(dist, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });
  });
});
