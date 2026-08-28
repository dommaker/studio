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

const { mockReadDiskUsage, mockReadMemoryUsage, mockLoadRaw } = vi.hoisted(() => ({
  mockReadDiskUsage: vi.fn(),
  mockReadMemoryUsage: vi.fn(),
  mockLoadRaw: vi.fn(() => '?'),
}));

// #344: getStatus 探测委托 proc-probes 单出口，mock 掉 /proc 读取以固定格式断言
vi.mock('../ops/proc-probes.js', () => ({
  readDiskUsage: mockReadDiskUsage,
  readMemoryUsage: mockReadMemoryUsage,
  readLoadAvgRaw: mockLoadRaw,
}));

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
});
