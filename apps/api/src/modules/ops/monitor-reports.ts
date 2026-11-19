/**
 * Monitor Agent — 报告：轨迹评估 / 每日洞察 / 交互模式观察
 *
 * 从 monitor.service.ts 拆分（探测/告警/报告分离，零行为变更）。
 * 本模块负责聚合类输出：
 *   - G4: 结构化轨迹评估（monitor:trajectory）
 *   - DailyReflection: 每日开发洞察聚合（#系统 channel + Discord）
 *   - B9-025: PatternObserver — 交互模式持久化
 */

import type { FileStore } from '@dommaker/studio-shared';
import { emitMonitorEvent } from './monitor-alerts.js';
import { writeStudioEvent } from '@dommaker/studio-shared';
import {
  collectSessionActivityLines,
  collectPatternLines,
  collectGitChangeLines,
  collectKnowledgeBusLines,
  collectKnowledgeConsumptionLines,
  collectKnowledgeQualityLines,
  snapshotKnowledgeIndex,
  collectWeeklyProfileLines,
} from './monitor-reflection-collectors.js';
import { logger } from '@dommaker/studio-shared/node';

/**
 * 报告的实例级状态（由 MonitorService 实例持有并传入，保持 per-instance 语义）。
 */
export interface ReportState {
  lastDailyReflectionTs: number;
}

// ── G4: Trajectory Eval — 结构化轨迹评估 ──

export async function evaluateTrajectory(fileStore: FileStore): Promise<void> {
  try {
    const validStatuses = new Set(['done', 'closed']);
    const cutoff = Date.now() - 24 * 3600_000;
    const recent = (await fileStore.getIndex())
      .filter(s => validStatuses.has(s.status) && s.completedAt && new Date(s.completedAt).getTime() >= cutoff)
      .sort((a, b) => {
        if (!a.completedAt) return 1;
        if (!b.completedAt) return -1;
        return new Date(b.completedAt).getTime() - new Date(a.completedAt).getTime();
      })
      .slice(0, 10);

    if (recent.length === 0) return; // No workUnits to evaluate

    let totalWorkUnits = 0;
    let efficientCount = 0;
    let normalCount = 0;
    let slowCount = 0;
    let retryCount = 0;
    let failureCount = 0;
    let timedCount = 0;   // 有 claimedAt+completedAt 的 WorkUnit 数

    for (const wu of recent) {
      totalWorkUnits++;

      // Check retry count from WorkUnit field
      if (wu.retryCount > 0) {
        retryCount++;
      }

      // Check execution time — three tiers, 5-15min gap filled
      if (wu.claimedAt && wu.completedAt) {
        timedCount++;
        const durationMin = (new Date(wu.completedAt).getTime() - new Date(wu.claimedAt).getTime()) / 60000;
        if (durationMin > 15) slowCount++;
        else if (durationMin > 5) normalCount++;
        else efficientCount++;
      }

      if (wu.status === 'closed') failureCount++;
    }

    // Efficiency: (efficient + normal) / timed (only workUnits with timing data)
    const efficiency = timedCount > 0 ? Math.round(((efficientCount + normalCount) / timedCount) * 100) : 0;
    const slowRate = timedCount > 0 ? Math.round((slowCount / timedCount) * 100) : 0;

    const report = {
      type: 'monitor:trajectory',
      totalWorkUnits,
      efficiency: `${efficiency}%`,
      slowRate: `${slowRate}%`,
      retryCount,
      failureCount,
      verdict: efficiency >= 60 ? 'good' : efficiency >= 30 ? 'degraded' : 'poor',
    };

    logger.info('[MonitorService] Trajectory eval', report);

    // Emit for Discord notification
    emitMonitorEvent(report);

    if (slowRate > 30) {
      emitMonitorEvent({
        type: 'monitor:alert',
        level: 'warning',
        source: 'trajectory',
        message: `WorkUnit efficiency ${efficiency}% (${slowRate}% slow, ${retryCount} retries)`,
      });
    }
  } catch (e) {
    logger.warn('[MonitorService] Trajectory eval failed', { error: String(e) });
  }
}

// ── DailyReflection: 每日洞察聚合 ──

/**
 * 每天聚合所有数据源 → 输出每日开发洞察
 * GAP-15: 去掉 23:50 时间窗口，改为"距上次 >24h 则运行"
 * 数据源: session:summary + pipelineRun + git log + KnowledgeBus
 * 输出: #系统 channel 卡片 + Discord discord-alert 频道
 */
export async function dailyReflection(fileStore: FileStore, state: ReportState): Promise<void> {
  try {
    const now = Date.now();
    // GAP-15: Run if last run was >24h ago (no time-of-day constraint)
    if (now - state.lastDailyReflectionTs < 24 * 3600_000) return;
    state.lastDailyReflectionTs = now;

    const today = new Date(now).toISOString().split('T')[0];

    const since = new Date(now - 24 * 3600_000);
    const lines: string[] = [
      `## 📊 每日洞察 — ${today}`,
      '',
    ];

    // 采集段顺序即报告段落顺序（1 会话 → 1b 模式 → 2 git → 4 知识积累 → 4b 消费 → 5 审计），
    // 各段自兜异常（best-effort），实现见 monitor-reflection-collectors.ts
    lines.push(...await collectSessionActivityLines(since));
    lines.push(...await collectPatternLines(now, today));
    lines.push(...await collectGitChangeLines(since));
    lines.push(...collectKnowledgeBusLines());
    lines.push(...await collectKnowledgeConsumptionLines(since, today));
    lines.push(...await collectKnowledgeQualityLines());

    // 5b. Knowledge index snapshot (for KR4 30d survival rate)——纯副作用
    await snapshotKnowledgeIndex();

    // B9-025: Weekly profile report (every Sunday)——周日条件在 collector 内判定
    lines.push(...await collectWeeklyProfileLines(now));

    // Post to #系统 channel
    const content = lines.join('\n');
    try {
      const sysChannels = await fileStore.listChannels({ name: '#系统' });
      const sysChannel = sysChannels[0] ?? null;
      if (sysChannel) {
        const { getChannelMessageService } = await import('../channels/index.js');
        await getChannelMessageService().createAgentMessage(sysChannel.id, 'DailyReflection', content, {
          meta: { cardType: 'daily_reflection', date: today },
        });
        logger.info('[MonitorService] DailyReflection posted', { date: today });
      }
    } catch (e: any) { logger.warn('[MonitorService] DailyReflection channel post failed', { error: String(e) }); }

    // G30: Record daily reflection event（D18：统一写入入口）
    void writeStudioEvent('daily_reflection', { date: today, summaryLength: content.length }, { source: 'monitor' });

    // Discord alert (fire-and-forget, channel configured via DISCORD_DAILY_CHANNEL)
    try {
      const channel = process.env.DISCORD_DAILY_CHANNEL || null;
      if (channel) {
        const { discordNotifier } = await import('../notifications/index.js');
        await discordNotifier.sendChannelMessage(channel, 'DailyReflection', content, {
          cardType: 'daily_reflection',
        });
      }
    } catch { /* Discord best-effort */ }
  } catch (e: any) {
    logger.warn('[MonitorService] DailyReflection failed', { error: String(e) });
  }
}

