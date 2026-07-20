/**
 * Auditor Agent — 洞察与报告输出
 *
 * 从 auditor-agent.service.ts 拆分（审计规则/执行/报告分离，零行为变更）。
 * 本模块负责报告侧：
 *   - 开发会话行为趋势分析（session:summary → behavioral insights）
 *   - B13-011: 每日快照 + 7 日趋势检测
 *   - tier 成功率保存（Auditor → Analyst 反馈回路）
 *   - 审计报告推送到 #系统 channel
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '@dommaker/studio-shared';
import type { FileStore } from '@dommaker/studio-shared';
import { studioEventsJsonl } from './auditor-rules.js';

const SYSTEM_CHANNEL_NAME = '#系统';

/**
 * 分析开发会话行为趋势 (session:summary → behavioral insights)
 *
 * 读取统一事件目录（~/.studio/events，env 可覆盖）studio.jsonl 中的
 * session:summary 事件，聚合最近 24h 的行为信号，产出入门级洞察。
 * 不自动进化约束 — 行为约束的执行机制（Claude Code hooks）与代码约束（harness check）不同。
 */
export async function analyzeSessionTrends(since: Date): Promise<string[]> {
  const lines: string[] = [];
  try {
    const eventsFile = studioEventsJsonl();
    if (!fs.existsSync(eventsFile)) return [];

    const raw = fs.readFileSync(eventsFile, 'utf-8');
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        if (evt.type === 'session:summary' && new Date(evt.timestamp) >= since) {
          lines.push(line);
        }
      } catch {}
    }
  } catch { return []; }

  if (lines.length === 0) return [];

  // Aggregate metrics
  let totalSessions = 0;
  let deepAnalysisCount = 0;
  let missingCaptureCount = 0;
  let sensitiveOpsSessions = 0;
  let highSensitiveOpsCount = 0;
  let totalTurnCount = 0;
  let maxTurnCount = 0;

  for (const line of lines) {
    try {
      const evt = JSON.parse(line);
      totalSessions++;
      if (evt.deepAnalysis) deepAnalysisCount++;
      if (evt.deepAnalysis && !evt.knowledgeCaptured) missingCaptureCount++;
      if (evt.sensitiveOpsCount > 0) sensitiveOpsSessions++;
      if (evt.sensitiveOpsCount >= 3) highSensitiveOpsCount++;
      totalTurnCount += (evt.turnCount || 0);
      if ((evt.turnCount || 0) > maxTurnCount) maxTurnCount = evt.turnCount;
    } catch {}
  }

  const insights: string[] = [];

  // Knowledge capture health
  if (totalSessions > 0) {
    const captureRate = deepAnalysisCount > 0
      ? Math.round((1 - missingCaptureCount / deepAnalysisCount) * 100)
      : 100;
    insights.push(`- 开发会话: ${totalSessions} 次 | 深度分析: ${deepAnalysisCount} | 知识捕获率: ${captureRate}%`);
  }

  // Sensitive ops trend
  if (sensitiveOpsSessions > 0) {
    const pct = Math.round((sensitiveOpsSessions / Math.max(totalSessions, 1)) * 100);
    insights.push(`- ⚠️  ${sensitiveOpsSessions}/${totalSessions} 会话有未验证敏感操作 (${pct}%)`);

    if (sensitiveOpsSessions >= 3) {
      insights.push('  - 📋 建议：review `feedback_verify_before_move.md` 规则是否需要加强');
    }
    if (highSensitiveOpsCount >= 2) {
      insights.push('  - 🔴 多个会话高频触发敏感操作检测，考虑加强 hook 拦截力度');
    }
  }

  // Knowledge capture degradation
  if (deepAnalysisCount >= 3 && missingCaptureCount >= deepAnalysisCount * 0.5) {
    insights.push(`- ⚠️  知识捕获率 < 50% (${missingCaptureCount}/${deepAnalysisCount} 会话深度分析无产出)`);
    insights.push('  - 📋 建议：运行 `npx harness sync-docs`，检查 `ingest:true` 标记是否遗漏');
  }

  // Session length anomaly
  if (maxTurnCount > 50) {
    insights.push(`- ⚠️  最长会话 ${maxTurnCount} turns — 考虑运行 cstnew 清理长会话`);
  }

  if (totalSessions > 0) {
    const avgTurns = Math.round(totalTurnCount / totalSessions);
    if (avgTurns > 30) {
      insights.push(`- 📊 平均会话 ${avgTurns} turns — 偏高，建议拆分大任务为小 session`);
    }
  }

  // B13-011: Save daily snapshot + detect multi-day trends
  const snapshot = {
    date: since.toISOString().slice(0, 10),
    totalSessions,
    deepAnalysisCount,
    missingCaptureCount,
    sensitiveOpsSessions,
    highSensitiveOpsCount,
    avgTurns: totalSessions > 0 ? Math.round(totalTurnCount / totalSessions) : 0,
    maxTurnCount,
  };

  try {
    const trendInsights = trackTrends(snapshot);
    if (trendInsights.length > 0) {
      insights.push('', '### 趋势变化（7 日对比）', ...trendInsights);
    }
  } catch { /* non-blocking */ }

  return insights;
}

/**
 * B13-011: 保存每日快照 + 检测趋势变化
 *
 * 快照存储：~/.studio/auditor/daily-snapshots.jsonl
 * 每行一个 JSON 对象，保留 30 天。
 */
export function trackTrends(snapshot: {
  date: string; totalSessions: number; deepAnalysisCount: number;
  missingCaptureCount: number; sensitiveOpsSessions: number;
  highSensitiveOpsCount: number; avgTurns: number; maxTurnCount: number;
}): string[] {
  const auditorDir = path.join(os.homedir(), '.studio', 'auditor');
  fs.mkdirSync(auditorDir, { recursive: true });
  const snapshotFile = path.join(auditorDir, 'daily-snapshots.jsonl');

  // Load existing snapshots
  let snapshots: typeof snapshot[] = [];
  try {
    const raw = fs.readFileSync(snapshotFile, 'utf-8');
    snapshots = raw.split('\n').filter(Boolean).map(l => JSON.parse(l));
  } catch { /* file doesn't exist yet */ }

  // Dedup by date (keep latest for today)
  snapshots = snapshots.filter(s => s.date !== snapshot.date);
  snapshots.push(snapshot);

  // Keep last 30 days
  snapshots.sort((a, b) => a.date.localeCompare(b.date));
  if (snapshots.length > 30) snapshots = snapshots.slice(-30);

  // Write back
  fs.writeFileSync(snapshotFile, snapshots.map(s => JSON.stringify(s)).join('\n') + '\n', 'utf-8');

  // Need at least 3 days of history for trend detection
  if (snapshots.length < 3) return [];

  // Compare current vs 7-day average (excluding today)
  const prev = snapshots.slice(0, -1);
  const window = prev.slice(-7);
  if (window.length < 2) return [];

  const avg = (nums: number[]) => nums.reduce((a, b) => a + b, 0) / nums.length;

  const prevSensitiveOps = avg(window.map(s => s.sensitiveOpsSessions));
  const prevCaptureRate = avg(window.map(s =>
    s.deepAnalysisCount > 0 ? (1 - s.missingCaptureCount / s.deepAnalysisCount) * 100 : 100
  ));
  const prevAvgTurns = avg(window.map(s => s.avgTurns));

  const currentCaptureRate = snapshot.deepAnalysisCount > 0
    ? (1 - snapshot.missingCaptureCount / snapshot.deepAnalysisCount) * 100
    : 100;

  const insights: string[] = [];

  // Sensitive ops increasing
  if (snapshot.sensitiveOpsSessions > prevSensitiveOps * 1.5 && snapshot.sensitiveOpsSessions >= 2) {
    insights.push(`- 🔴 敏感操作会话数上升: ${snapshot.sensitiveOpsSessions}（7日均值 ${prevSensitiveOps.toFixed(1)}），需关注`);
  }

  // Capture rate declining
  if (currentCaptureRate < prevCaptureRate - 15 && snapshot.deepAnalysisCount >= 2) {
    insights.push(`- 📉 知识捕获率下降: ${Math.round(currentCaptureRate)}%（7日均值 ${Math.round(prevCaptureRate)}%）`);
  }

  // Session length increasing
  if (snapshot.avgTurns > prevAvgTurns * 1.3 && snapshot.avgTurns > 20) {
    insights.push(`- 📈 平均会话长度上升: ${snapshot.avgTurns} turns（7日均值 ${Math.round(prevAvgTurns)}）`);
  }

  return insights;
}

// ── Save Tier Stats (Auditor → Analyst feedback loop) ──

export async function saveTierStats(
  tierStats: Map<string, { total: number; failed: number }>,
): Promise<void> {
  if (tierStats.size === 0) return;

  try {
    const stats = [...tierStats.entries()].map(([tier, s]) => ({
      tier,
      total: s.total,
      failed: s.failed,
      successRate: s.total > 0 ? Math.round((1 - s.failed / s.total) * 100) : 100,
    }));

    const { sharedStore: tierStatsStore } = await import('../knowledge/knowledge-bus.service.js');
    tierStatsStore.save({
      id: `tier-stats-${new Date().toISOString().slice(0, 10)}`,
      type: 'guideline' as any,
      title: 'tier_success_rate',
      content: JSON.stringify(stats),
      maturity: 'active' as any,
      layer: 'project',
      created: new Date().toISOString(),
      lastReferenced: new Date().toISOString(),
      contributors: ['auditor-agent'],
      projects: [],
      tags: ['audit', 'tier_stats'],
      applicablePhases: [],
      sourceReferences: [],
      referencedBy: [],
      executionResults: [],
      consumptionMode: 'reference' as any,
      origin: 'agent' as any,
    } as any);

    logger.info('[AuditorAgent] Tier stats saved', { tiers: stats.length });
  } catch (err) {
    logger.warn('[AuditorAgent] Failed to save tier stats', { error: String(err) });
  }
}

// ── Post to Channel ──

export async function postToSystemChannel(fileStore: FileStore, content: string): Promise<void> {
  try {
    const channel = (await fileStore.listChannels({ name: SYSTEM_CHANNEL_NAME }))[0] ?? null;
    if (!channel) {
      logger.warn('[AuditorAgent] System channel not found');
      return;
    }

    const { channelMessageService } = await import('../channels/channel-message.service.js');
    await channelMessageService.createAgentMessage(
      channel.id,
      'Auditor',
      content,
      { meta: { cardType: 'audit-report', source: 'auditor-agent' } },
    );
  } catch (e) {
    logger.warn('[AuditorAgent] Failed to post to system channel', { error: String(e) });
  }
}
