import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import {
  zScoreTest,
  detectTrend,
  detectDelta,
  rollingBaseline,
} from '@dommaker/studio-shared/stats/anomaly-detector';

interface AnomalyReport {
  anomalies: AnomalyItem[];
  summary: {
    totalMetrics: number;
    anomalyCount: number;
    timestamp: Date;
  };
}

interface AnomalyItem {
  okrId: string;
  krId: string;
  currentValue: number;
  baseline: { mean: number; stddev: number };
  zScore: number | null;
  trend: { direction: 'up' | 'down' | 'stable'; consecutiveDays: number } | null;
  delta: { deltaRatio: number; isAnomaly: boolean } | null;
  anomalyType: 'zscore' | 'trend' | 'delta';
  detectedAt: Date;
}

export async function detectAnomalies(): Promise<AnomalyReport> {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const anomalies: AnomalyItem[] = [];

  try {
    const records = await prisma.kRHistory.findMany({
      where: { timestamp: { gte: sevenDaysAgo } },
      orderBy: { timestamp: 'asc' },
    });

    if (!records || records.length === 0) {
      return {
        anomalies: [],
        summary: { totalMetrics: 0, anomalyCount: 0, timestamp: now },
      };
    }

    // Group by (okrId, krId)
    const groups = new Map<string, typeof records>();
    for (const r of records) {
      const key = `${r.okrId}:${r.krId}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }

    for (const [key, group] of groups) {
      if (group.length < 2) continue;

      const values = group.map(r => r.value);
      const latest = group[group.length - 1];

      // z-score check (need >= 3 points for meaningful stddev)
      if (values.length >= 3) {
        const baseline = rollingBaseline(values.slice(0, -1), 7);
        if (baseline.stddev > 0.001) {
          const zResult = zScoreTest(latest.value, baseline);
          if (zResult.isAnomaly) {
            anomalies.push({
              okrId: latest.okrId,
              krId: latest.krId,
              currentValue: latest.value,
              baseline,
              zScore: zResult.zScore,
              trend: null,
              delta: null,
              anomalyType: 'zscore',
              detectedAt: now,
            });
          }
        }
      }

      // Trend check
      if (values.length >= 4) {
        const trend = detectTrend(values, 3);
        if (trend.direction !== 'stable' && trend.consecutiveDays >= 3) {
          // Only add if not already flagged for z-score on same metric
          const alreadyFlagged = anomalies.some(
            a => a.okrId === latest.okrId && a.krId === latest.krId
          );
          if (!alreadyFlagged) {
            anomalies.push({
              okrId: latest.okrId,
              krId: latest.krId,
              currentValue: latest.value,
              baseline: rollingBaseline(values, 7),
              zScore: null,
              trend,
              delta: null,
              anomalyType: 'trend',
              detectedAt: now,
            });
          }
        }
      }

      // Delta check (day-over-day change)
      if (values.length >= 2) {
        const prev = values[values.length - 2];
        const delta = detectDelta(latest.value, prev, 0.5);
        if (delta.isAnomaly) {
          const alreadyFlagged = anomalies.some(
            a => a.okrId === latest.okrId && a.krId === latest.krId
          );
          if (!alreadyFlagged) {
            anomalies.push({
              okrId: latest.okrId,
              krId: latest.krId,
              currentValue: latest.value,
              baseline: rollingBaseline(values, 7),
              zScore: null,
              trend: null,
              delta,
              anomalyType: 'delta',
              detectedAt: now,
            });
          }
        }
      }
    }

    logger.info('[okr-anomaly-detector] Scan complete', {
      totalMetrics: groups.size,
      anomalies: anomalies.length,
    });

    // Write anomaly events to studioEvent
    for (const anomaly of anomalies) {
      try {
        await prisma.studioEvent.create({
          data: {
            type: 'metric:anomaly',
            source: 'okr-anomaly-detector',
            payload: JSON.stringify(anomaly),
          },
        });
      } catch {
        // Non-blocking: event write failure doesn't stop scan
      }
    }

    return {
      anomalies,
      summary: {
        totalMetrics: groups.size,
        anomalyCount: anomalies.length,
        timestamp: now,
      },
    };
  } catch (error) {
    logger.warn('[okr-anomaly-detector] Scan failed (non-blocking)', { error: String(error) });
    return {
      anomalies: [],
      summary: { totalMetrics: 0, anomalyCount: 0, timestamp: now },
    };
  }
}
