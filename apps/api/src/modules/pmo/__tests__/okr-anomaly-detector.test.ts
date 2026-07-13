import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock prisma
const mockFindMany = vi.fn();
vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    kRHistory: { findMany: mockFindMany },
    $queryRawUnsafe: vi.fn(),
  },
}));

// Mock studioEvent logger
const mockCreate = vi.fn();
vi.mock('@dommaker/studio-shared', async () => {
  const actual = await vi.importActual('@dommaker/studio-shared');
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

describe('detectAnomalies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty when KRHistory has no data', async () => {
    mockFindMany.mockResolvedValue([]);
    const { detectAnomalies } = await import('../okr-anomaly-detector');
    const result = await detectAnomalies();
    expect(result.anomalies).toEqual([]);
    expect(result.summary.totalMetrics).toBe(0);
    expect(result.summary.anomalyCount).toBe(0);
  });

  it('returns empty when all values within normal range', async () => {
    const now = new Date();
    // Alternating values around 80 — no 3+ consecutive same-direction trends, no large deltas
    const baseValues = [80, 82, 79, 81, 78, 80, 79];
    const history = baseValues.map((v, i) => ({
      id: `h-${i}`,
      okrId: 'okr-1',
      krId: 'kr-1',
      value: v,
      status: 'on_track',
      timestamp: new Date(now.getTime() - (baseValues.length - 1 - i) * 86400000),
    }));
    mockFindMany.mockResolvedValue(history);
    const { detectAnomalies } = await import('../okr-anomaly-detector');
    const result = await detectAnomalies();
    expect(result.anomalies).toEqual([]);
    expect(result.summary.anomalyCount).toBe(0);
  });

  it('detects z-score anomaly when value deviates significantly', async () => {
    const now = new Date();
    // 6 days with slight variance around 80, today at 30 (large drop)
    const history = Array.from({ length: 6 }, (_, i) => ({
      id: `h-${i}`,
      okrId: 'okr-1',
      krId: 'kr-1',
      value: 80 + (i % 3 - 1) * 2,  // 78, 80, 82, 78, 80, 82
      status: 'on_track',
      timestamp: new Date(now.getTime() - (6 - i) * 86400000),
    }));
    history.push({
      id: 'h-6',
      okrId: 'okr-1',
      krId: 'kr-1',
      value: 30,
      status: 'at_risk',
      timestamp: now,
    });
    mockFindMany.mockResolvedValue(history);
    const { detectAnomalies } = await import('../okr-anomaly-detector');
    const result = await detectAnomalies();
    expect(result.anomalies.length).toBeGreaterThan(0);
    expect(result.anomalies[0].anomalyType).toBe('zscore');
  });

  it('detects trend anomaly for consecutive decline', async () => {
    const now = new Date();
    // Gradual decline with noise to avoid z-score trigger (high baseline stddev)
    // Baseline variance ~20 suppresses z-score, but consistent downward direction triggers trend
    const history = [105, 85, 82, 72, 58, 48, 40].map((v, i) => ({
      id: `h-${i}`,
      okrId: 'okr-1',
      krId: 'kr-2',
      value: v,
      status: v < 60 ? 'at_risk' : 'on_track',
      timestamp: new Date(now.getTime() - (6 - i) * 86400000),
    }));
    mockFindMany.mockResolvedValue(history);
    const { detectAnomalies } = await import('../okr-anomaly-detector');
    const result = await detectAnomalies();
    const trendAnomalies = result.anomalies.filter(a => a.anomalyType === 'trend');
    expect(trendAnomalies.length).toBeGreaterThan(0);
  });

  it('handles fewer than 2 data points gracefully', async () => {
    mockFindMany.mockResolvedValue([
      { id: 'h-0', okrId: 'okr-1', krId: 'kr-1', value: 80, status: 'on_track', timestamp: new Date() },
    ]);
    const { detectAnomalies } = await import('../okr-anomaly-detector');
    const result = await detectAnomalies();
    expect(result.anomalies).toEqual([]);
  });

  it('has zero LLM calls', async () => {
    mockFindMany.mockResolvedValue([]);
    const { detectAnomalies } = await import('../okr-anomaly-detector');
    // Import the source file and check for LLM keywords
    const fs = await import('fs');
    const content = fs.readFileSync('/root/projects/studio/apps/api/src/modules/pmo/okr-anomaly-detector.ts', 'utf-8');
    expect(content).not.toMatch(/modelGateway|openai|anthropic|deepseek|promptJson|prompt\(/);
  });
});
