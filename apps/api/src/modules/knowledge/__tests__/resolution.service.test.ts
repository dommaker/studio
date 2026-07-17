/**
 * ResolutionService — writeCanonicalToDisk + scheduleVectorDbSync 测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const isCI = !!process.env.CI;
const describeIf = isCI ? describe.skip : describe;

vi.mock('../knowledge-bus.service.js', () => ({
  scheduleVectorDbSync: vi.fn(),
}));

import { prisma } from '@dommaker/studio-prisma';
import { resolutionService } from '../resolution.service.js';
import { scheduleVectorDbSync } from '../knowledge-bus.service.js';

// Helper: create a test resolution in DB
async function createTestResolution(overrides: Partial<{
  id: string; pattern: string; errorClass: string; layer: string;
  title: string; fix: string; status: string; verifyCount: number;
  tags: string;
}> = {}) {
  const id = overrides.id || `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  return prisma.resolution.create({
    data: {
      id,
      pattern: overrides.pattern || 'test.*error',
      errorClass: overrides.errorClass || 'test_error',
      layer: overrides.layer || 'L3_tool_behavior',
      title: overrides.title || 'Test Resolution',
      fix: overrides.fix || 'Fix the test error by doing X',
      status: overrides.status || 'canonical',
      verifyCount: overrides.verifyCount ?? 3,
      tags: overrides.tags || JSON.stringify(['test']),
      verifiedAt: new Date(),
    },
  });
}

describeIf('ResolutionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await prisma.resolution.deleteMany({ where: { id: { startsWith: 'test-' } } });
  });

  describe('writeCanonicalToDisk', () => {
    it('should complete without throwing', async () => {
      await createTestResolution({
        id: `test-sync-${Date.now()}`,
        title: 'Sync Test Resolution',
        fix: 'Apply fix XYZ',
        pattern: 'sync.*test.*error',
        errorClass: 'sync_error',
      });

      await expect(resolutionService.writeCanonicalToDisk()).resolves.not.toThrow();
    });

    it('should handle empty canonical set gracefully', async () => {
      // No canonical resolutions → should return without error
      await expect(resolutionService.writeCanonicalToDisk()).resolves.not.toThrow();
    });
  });

  describe('verifyResolution triggers scheduleVectorDbSync', () => {
    it('should call scheduleVectorDbSync when resolution becomes canonical', async () => {
      const row = await createTestResolution({
        id: `test-verify-${Date.now()}`,
        status: 'verified',
        verifyCount: 2, // one more → canonical
      });

      await resolutionService.verifyResolution(row.id);
      await new Promise(r => setTimeout(r, 50));

      expect(scheduleVectorDbSync).toHaveBeenCalled();
    });

    it('should NOT call scheduleVectorDbSync when resolution stays verified', async () => {
      const row = await createTestResolution({
        id: `test-no-sync-${Date.now()}`,
        status: 'pending',
        verifyCount: 0, // one verify → verified, not canonical
      });

      await resolutionService.verifyResolution(row.id);
      await new Promise(r => setTimeout(r, 50));

      expect(scheduleVectorDbSync).not.toHaveBeenCalled();
    });
  });
});
