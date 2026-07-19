import { FileStore } from '@dommaker/studio-shared';
import { logger, zScoreTest, detectTrend, detectDelta, rollingBaseline } from '@dommaker/studio-shared';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

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
  // TODO(vision §5.3): PMO 重定义为 REQ 需求编号体系，独立检测器已下线。
  // 默认停用（本函数当前亦无生产调用方）；如需临时运行设 OKR_ANOMALY_DETECTOR_ENABLED=true。
  // 模块与测试保留，清理归 cleanup batch-2。
  if (process.env.OKR_ANOMALY_DETECTOR_ENABLED !== 'true') {
    return {
      anomalies: [],
      summary: { totalMetrics: 0, anomalyCount: 0, timestamp: now },
    };
  }
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const anomalies: AnomalyItem[] = [];
  const STUDIO_DIR = path.join(os.homedir(), '.studio');
  const STUDIO_EVENTS_JSONL = path.join(STUDIO_DIR, 'logs', 'studio-events.jsonl');
  const KR_HISTORY_DIR = path.join(STUDIO_DIR, 'okr');
  const fileStore = new FileStore();

  try {
    let records: any[] = [];
    try {
      const files = await fs.promises.readdir(KR_HISTORY_DIR);
      const historyFiles = files.filter(f => f.endsWith('-history.jsonl'));
      for (const f of historyFiles) {
        const rows = await fileStore.readJsonl<any>(path.join(KR_HISTORY_DIR, f));
        records.push(...rows);
      }
      records = records.filter((r: any) => new Date(r.timestamp).getTime() >= sevenDaysAgo.getTime());
    } catch { records = []; }

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
        await fileStore.appendJsonl(STUDIO_EVENTS_JSONL, {
          type: 'metric:anomaly',
          source: 'okr-anomaly-detector',
          payload: JSON.stringify(anomaly),
          createdAt: new Date().toISOString(),
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
