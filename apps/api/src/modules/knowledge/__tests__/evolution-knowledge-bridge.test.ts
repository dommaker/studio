/**
 * B13-008: EvolutionService → KnowledgeBus 飞轮接桥测试
 *
 * 验证 microEvolution/mesoEvolution 产出时调用 knowledgeBus.recordPattern。
 * 全 mock 避免 Prisma schema + LLM 依赖。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// TODO(spec4-followup): @dommaker/studio-prisma removed (Spec 4 AC-6a).
// Tests need to be rewritten to mock FileStore instead of Prisma.

// Mock modelGateway
vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const orig = await importOriginal() as Record<string, unknown>;
  return {
    ...orig,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    modelGateway: { promptJson: vi.fn() },
  };
});

// Mock knowledgeBus (vi.hoisted ensures the mock is available during hoisted vi.mock)
const { mockRecordPattern } = vi.hoisted(() => ({
  mockRecordPattern: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../knowledge-bus.service.js', () => ({
  knowledgeBus: { recordPattern: mockRecordPattern },
}));

import { KnowledgeEvolutionService } from '../evolution.service.js';
import { modelGateway } from '@dommaker/studio-shared';

const service = new KnowledgeEvolutionService();

describe.skip('B13-008: EvolutionService → KnowledgeBus bridge', () => {
  // TODO(spec4-followup): Rewrite tests using FileStore instead of Prisma mocks.
  // Prisma was removed (Spec 4 AC-6a). The service now uses FileStore internally.
  // The Prisma-based mock setup (prisma.execution.findUnique etc.) is no longer valid.
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('microEvolution', () => {
    it('should call knowledgeBus.recordPattern when new doc created', async () => {
      (prisma.execution.findUnique as any).mockResolvedValue({
        id: 'exec-1', status: 'failed', error: 'test error',
      });
      (prisma.document.findFirst as any).mockResolvedValue(null); // no existing doc
      (modelGateway.promptJson as any).mockResolvedValue([
        { title: 'Test Knowledge', content: 'Learned something', type: 'execution', tags: ['test'] },
      ]);
      (prisma.document.create as any).mockResolvedValue({
        id: 'doc-1', title: 'Test Knowledge', content: 'Learned something',
      });

      await service.microEvolution('exec-1', 'proj-1', 'comp-1');

      expect(mockRecordPattern).toHaveBeenCalledTimes(1);
      expect(mockRecordPattern).toHaveBeenCalledWith(expect.objectContaining({
        source: 'evolution',
        type: 'pattern',
        title: '[Evolution] Test Knowledge',
        content: 'Learned something',
        severity: 'info',
      }));
    });

    it('should call knowledgeBus.recordPattern for each extracted entry', async () => {
      (prisma.execution.findUnique as any).mockResolvedValue({
        id: 'exec-2', status: 'failed', error: 'multi error',
      });
      (prisma.document.findFirst as any).mockResolvedValue(null);
      (modelGateway.promptJson as any).mockResolvedValue([
        { title: 'Entry A', content: 'Content A', type: 'execution', tags: [] },
        { title: 'Entry B', content: 'Content B', type: 'design', tags: [] },
      ]);
      (prisma.document.create as any).mockResolvedValue({ id: 'doc-x' });

      await service.microEvolution('exec-2', 'proj-1', 'comp-1');

      expect(mockRecordPattern).toHaveBeenCalledTimes(2);
    });

    it('should NOT call knowledgeBus.recordPattern when LLM returns empty', async () => {
      (prisma.execution.findUnique as any).mockResolvedValue({
        id: 'exec-3', status: 'failed', error: 'no extraction',
      });
      (modelGateway.promptJson as any).mockResolvedValue([]);

      await service.microEvolution('exec-3', 'proj-1', 'comp-1');

      expect(mockRecordPattern).not.toHaveBeenCalled();
    });

    it('should NOT call knowledgeBus.recordPattern when execution has no error', async () => {
      (prisma.execution.findUnique as any).mockResolvedValue({
        id: 'exec-4', status: 'success', error: null,
      });

      await service.microEvolution('exec-4', 'proj-1', 'comp-1');

      expect(mockRecordPattern).not.toHaveBeenCalled();
    });

    it('should NOT block on knowledgeBus failure', async () => {
      (prisma.execution.findUnique as any).mockResolvedValue({
        id: 'exec-5', status: 'failed', error: 'error',
      });
      (prisma.document.findFirst as any).mockResolvedValue(null);
      (modelGateway.promptJson as any).mockResolvedValue([
        { title: 'Test', content: 'Content', type: 'execution', tags: [] },
      ]);
      (prisma.document.create as any).mockResolvedValue({ id: 'doc-5' });
      mockRecordPattern.mockRejectedValueOnce(new Error('Bus down'));

      await expect(service.microEvolution('exec-5', 'proj-1', 'comp-1')).resolves.toBeDefined();
    });
  });

  describe('mesoEvolution', () => {
    it('should call knowledgeBus.recordPattern when pattern identified', async () => {
      // Create 5 docs of same type to trigger pattern analysis
      const docs = Array.from({ length: 5 }, (_, i) => ({
        id: `doc-${i}`, type: 'execution', title: `Doc ${i}`,
        content: `Content ${i}`, status: 'active', updatedAt: new Date(),
      }));
      (prisma.document.findMany as any).mockResolvedValue(docs);
      (modelGateway.promptJson as any).mockResolvedValue({
        pattern: 'Common Error Pattern',
        recommendation: 'Fix the root cause',
      });
      (prisma.project.findUnique as any).mockResolvedValue({ companyId: 'comp-1' });
      (prisma.document.create as any).mockResolvedValue({ id: 'pattern-doc' });

      await service.mesoEvolution('proj-1');

      expect(mockRecordPattern).toHaveBeenCalledTimes(1);
      expect(mockRecordPattern).toHaveBeenCalledWith(expect.objectContaining({
        source: 'evolution',
        type: 'pattern',
        title: '[Meso Pattern] Common Error Pattern',
        content: 'Fix the root cause',
      }));
    });

    it('should NOT call knowledgeBus.recordPattern when no pattern found', async () => {
      const docs = Array.from({ length: 5 }, (_, i) => ({
        id: `doc-${i}`, type: 'execution', title: `Doc ${i}`,
        content: `Content ${i}`, status: 'active', updatedAt: new Date(),
      }));
      (prisma.document.findMany as any).mockResolvedValue(docs);
      (modelGateway.promptJson as any).mockResolvedValue(null);

      await service.mesoEvolution('proj-1');

      expect(mockRecordPattern).not.toHaveBeenCalled();
    });

    it('should NOT call knowledgeBus.recordPattern when < 5 docs of same type', async () => {
      const docs = Array.from({ length: 3 }, (_, i) => ({
        id: `doc-${i}`, type: 'execution', title: `Doc ${i}`,
        content: `Content ${i}`, status: 'active', updatedAt: new Date(),
      }));
      (prisma.document.findMany as any).mockResolvedValue(docs);

      await service.mesoEvolution('proj-1');

      expect(mockRecordPattern).not.toHaveBeenCalled();
    });
  });
});
