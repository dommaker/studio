/**
 * ResolutionService — B13-003 syncCanonicalToLocalRag 测试
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('child_process', () => ({
  execSync: vi.fn(() => 'Ingested files'),
}));

import { prisma } from '@dommaker/studio-prisma';
import { resolutionService } from '../resolution.service.js';
import { execSync } from 'child_process';

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

describe('ResolutionService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await prisma.resolution.deleteMany({ where: { id: { startsWith: 'test-' } } });
  });

  describe('syncCanonicalToLocalRag (B13-003)', () => {
    it('should complete sync without throwing', async () => {
      await createTestResolution({
        id: `test-sync-${Date.now()}`,
        title: 'Sync Test Resolution',
        fix: 'Apply fix XYZ',
        pattern: 'sync.*test.*error',
        errorClass: 'sync_error',
      });

      await expect(resolutionService.syncCanonicalToLocalRag()).resolves.not.toThrow();
    });

    it('should call mcp-local-rag ingest after writing files', async () => {
      await createTestResolution({ id: `test-ingest-${Date.now()}` });

      await resolutionService.syncCanonicalToLocalRag();

      expect(execSync).toHaveBeenCalledWith(
        expect.stringContaining('mcp-local-rag ingest'),
        expect.objectContaining({ timeout: 30_000 }),
      );
    });

    it('should handle sync failure gracefully (non-blocking)', async () => {
      await createTestResolution({ id: `test-fail-${Date.now()}` });
      (execSync as any).mockImplementationOnce(() => { throw new Error('Command failed'); });

      await expect(resolutionService.syncCanonicalToLocalRag()).resolves.not.toThrow();
    });
  });

  describe('verifyResolution triggers sync (B13-003)', () => {
    it('should trigger sync when resolution becomes canonical', async () => {
      const row = await createTestResolution({
        id: `test-verify-${Date.now()}`,
        status: 'verified',
        verifyCount: 2, // one more → canonical
      });

      const syncSpy = vi.spyOn(resolutionService, 'syncCanonicalToLocalRag')
        .mockResolvedValue(undefined);

      await resolutionService.verifyResolution(row.id);
      await new Promise(r => setTimeout(r, 50));

      expect(syncSpy).toHaveBeenCalled();
      syncSpy.mockRestore();
    });

    it('should NOT trigger sync when resolution stays verified', async () => {
      const row = await createTestResolution({
        id: `test-no-sync-${Date.now()}`,
        status: 'pending',
        verifyCount: 0, // one verify → verified, not canonical
      });

      const syncSpy = vi.spyOn(resolutionService, 'syncCanonicalToLocalRag')
        .mockResolvedValue(undefined);

      await resolutionService.verifyResolution(row.id);
      await new Promise(r => setTimeout(r, 50));

      expect(syncSpy).not.toHaveBeenCalled();
      syncSpy.mockRestore();
    });
  });
});
