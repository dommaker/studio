/**
 * DataAnalyst Agent — 行为测试
 *
 * Mock prisma + modelGateway，spy on okrService instance。
 * 验证：数据采集、LLM prompt、报告存储、错误处理。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock prisma + modelGateway
vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    studioEvent: {
      findMany: vi.fn().mockResolvedValue([
        { type: 'test:event', source: 'test', timestamp: new Date(), payload: '{}' },
      ]),
      create: vi.fn().mockResolvedValue({ id: 'ev-1' }),
    },
  },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
  modelGateway: {
    promptJson: vi.fn().mockResolvedValue({
      trends: [{ metric: 'execution_success_rate', direction: 'up', significance: 'medium', description: '执行成功率上升' }],
      rootCauses: [],
      recommendations: [{ priority: 'P1', action: '优化执行策略', expectedImpact: '提升成功率', relatedMetrics: ['execution_success_rate'] }],
      anomalies: [],
    }),
  },
}));

// Must import AFTER mocks
import { dataAnalystAgent } from '../data-analyst-agent.service.js';
import { prisma } from '@dommaker/studio-prisma';
import { modelGateway } from '@dommaker/studio-shared';

describe('DataAnalystAgent', () => {
  const originalGetMetricBaseline = dataAnalystAgent.okrService.getMetricBaseline;

  beforeEach(() => {
    vi.clearAllMocks();
    // Spy on okrService.getMetricBaseline
    dataAnalystAgent.okrService.getMetricBaseline = vi.fn().mockImplementation((metricType: string) => {
      const data: Record<string, number | null> = {
        execution_success_rate: 80,
        review_pass_rate: 90,
        deploy_success_rate: null,
      };
      return Promise.resolve(data[metricType] ?? null);
    });
  });

  afterEach(() => {
    dataAnalystAgent.okrService.getMetricBaseline = originalGetMetricBaseline;
  });

  describe('collectMetrics', () => {
    it('returns metrics for all registered metricTypes', async () => {
      const metrics = await dataAnalystAgent.collectMetrics();
      expect(metrics.execution_success_rate).toBe(80);
      expect(metrics.review_pass_rate).toBe(90);
      expect(metrics.deploy_success_rate).toBeNull();
    });
  });

  describe('collectRecentEvents', () => {
    it('queries StudioEvent from last 24h', async () => {
      const events = await dataAnalystAgent.collectRecentEvents();
      expect(prisma.studioEvent.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { timestamp: { gte: expect.any(Date) } },
          take: 200,
        }),
      );
      expect(events).toHaveLength(1);
    });
  });

  describe('analyze', () => {
    it('produces a DataAnalysisReport and stores it', async () => {
      const report = await dataAnalystAgent.analyze();

      expect(report).not.toBeNull();
      expect(report!.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(report!.metrics).toHaveProperty('execution_success_rate', 80);
      expect(report!.analysis.trends).toHaveLength(1);
      expect(report!.analysis.recommendations).toHaveLength(1);
      expect(report!.metadata.durationMs).toBeGreaterThanOrEqual(0);

      // Stored to StudioEvent
      expect(prisma.studioEvent.create).toHaveBeenCalledWith({
        data: {
          type: 'knowledge:data_analysis',
          source: 'data-analyst',
          payload: expect.any(String),
        },
      });
    });

    it('calls modelGateway.promptJson with metrics data', async () => {
      await dataAnalystAgent.analyze();

      expect(modelGateway.promptJson).toHaveBeenCalledTimes(1);
      const prompt = (modelGateway.promptJson as any).mock.calls[0][0];
      expect(prompt).toContain('execution_success_rate');
      expect(prompt).toContain('80');
    });

    it('returns null on LLM failure without throwing', async () => {
      (modelGateway.promptJson as any).mockRejectedValueOnce(new Error('LLM timeout'));

      const report = await dataAnalystAgent.analyze();
      expect(report).toBeNull();
    });

    it('returns report even if storage fails', async () => {
      (prisma.studioEvent.create as any).mockRejectedValueOnce(new Error('DB error'));

      const report = await dataAnalystAgent.analyze();
      expect(report).not.toBeNull();
    });
  });
});
