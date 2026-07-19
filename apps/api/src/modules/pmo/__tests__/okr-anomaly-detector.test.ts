import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// 迁移说明（studio-prisma 移除后）：
// - 检测器从 ~/.studio/okr/*-history.jsonl 读取 KR 历史（fs.promises.readdir + FileStore.readJsonl）
// - 异常事件通过 FileStore.appendJsonl 写入 studio-events.jsonl
// - 检测逻辑由 OKR_ANOMALY_DETECTOR_ENABLED=true 显式开启（默认停用）
// 测试 stub 该 env flag 以走真实检测路径；zScoreTest/detectTrend 等统计函数保持真实实现。

const { mockReaddir, mockReadJsonl, mockAppendJsonl } = vi.hoisted(() => ({
  mockReaddir: vi.fn(),
  mockReadJsonl: vi.fn(),
  mockAppendJsonl: vi.fn().mockResolvedValue(undefined),
}));

// Mock fs — 仅替换 promises.readdir（KR 历史目录扫描），其余保持真实
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      readdir: mockReaddir,
    },
  };
});

// Mock studio-shared — 保持统计函数真实，仅替换 FileStore 与 logger
vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    FileStore: vi.fn().mockImplementation(() => ({
      readJsonl: mockReadJsonl,
      appendJsonl: mockAppendJsonl,
    })),
  };
});

describe('detectAnomalies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendJsonl.mockResolvedValue(undefined);
    // 开启检测路径（默认停用）
    vi.stubEnv('OKR_ANOMALY_DETECTOR_ENABLED', 'true');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns empty when KRHistory has no data', async () => {
    mockReaddir.mockResolvedValue([]);
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
    mockReaddir.mockResolvedValue(['kr-1-history.jsonl']);
    mockReadJsonl.mockResolvedValue(history);
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
    mockReaddir.mockResolvedValue(['kr-1-history.jsonl']);
    mockReadJsonl.mockResolvedValue(history);
    const { detectAnomalies } = await import('../okr-anomaly-detector');
    const result = await detectAnomalies();
    expect(result.anomalies.length).toBeGreaterThan(0);
    expect(result.anomalies[0].anomalyType).toBe('zscore');
    // Verify anomaly event written via FileStore.appendJsonl
    expect(mockAppendJsonl).toHaveBeenCalled();
    const anomalyEvent = mockAppendJsonl.mock.calls.find(
      (c: any[]) => c[1]?.type === 'metric:anomaly',
    );
    expect(anomalyEvent).toBeDefined();
    expect(anomalyEvent![1].source).toBe('okr-anomaly-detector');
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
    mockReaddir.mockResolvedValue(['kr-2-history.jsonl']);
    mockReadJsonl.mockResolvedValue(history);
    const { detectAnomalies } = await import('../okr-anomaly-detector');
    const result = await detectAnomalies();
    const trendAnomalies = result.anomalies.filter(a => a.anomalyType === 'trend');
    expect(trendAnomalies.length).toBeGreaterThan(0);
  });

  it('handles fewer than 2 data points gracefully', async () => {
    mockReaddir.mockResolvedValue(['kr-1-history.jsonl']);
    mockReadJsonl.mockResolvedValue([
      { id: 'h-0', okrId: 'okr-1', krId: 'kr-1', value: 80, status: 'on_track', timestamp: new Date() },
    ]);
    const { detectAnomalies } = await import('../okr-anomaly-detector');
    const result = await detectAnomalies();
    expect(result.anomalies).toEqual([]);
  });

  it('returns empty when detector disabled (default)', async () => {
    vi.stubEnv('OKR_ANOMALY_DETECTOR_ENABLED', '');
    mockReaddir.mockResolvedValue(['kr-1-history.jsonl']);
    mockReadJsonl.mockResolvedValue([
      { id: 'h-0', okrId: 'okr-1', krId: 'kr-1', value: 80, status: 'on_track', timestamp: new Date() },
      { id: 'h-1', okrId: 'okr-1', krId: 'kr-1', value: 30, status: 'at_risk', timestamp: new Date() },
    ]);
    const { detectAnomalies } = await import('../okr-anomaly-detector');
    const result = await detectAnomalies();
    expect(result.anomalies).toEqual([]);
    expect(result.summary.totalMetrics).toBe(0);
    // 停用时不读目录、不写事件
    expect(mockReaddir).not.toHaveBeenCalled();
    expect(mockAppendJsonl).not.toHaveBeenCalled();
  });

  it('has zero LLM calls', async () => {
    mockReaddir.mockResolvedValue([]);
    const { detectAnomalies } = await import('../okr-anomaly-detector');
    // Import the source file and check for LLM keywords
    const fs = await import('fs');
    const path = await import('path');
    const { fileURLToPath } = await import('url');
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const content = fs.readFileSync(path.resolve(__dirname, '../okr-anomaly-detector.ts'), 'utf-8');
    expect(content).not.toMatch(/modelGateway|openai|anthropic|deepseek|promptJson|prompt\(/);
  });
});
