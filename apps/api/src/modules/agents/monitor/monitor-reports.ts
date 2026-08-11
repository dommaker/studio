/**
 * Monitor Agent — 报告：轨迹评估 / 每日洞察 / 交互模式观察
 *
 * 从 monitor.service.ts 拆分（探测/告警/报告分离，零行为变更）。
 * 本模块负责聚合类输出：
 *   - G4: 结构化轨迹评估（monitor:trajectory）
 *   - DailyReflection: 每日开发洞察聚合（#系统 channel + Discord）
 *   - B9-025: PatternObserver — 交互模式持久化
 */

import * as fs from 'fs';
import { logger } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import type { FileStore } from '@dommaker/studio-shared';
import { knowledgeService } from '../../knowledge/knowledge-service.js';
import { preferenceObserver } from '../../knowledge/preference-observer.js';
import { emitMonitorEvent } from './monitor-alerts.js';
import {
  readStudioEvents,
  writeStudioEvent,
  parseStudioEventPayload,
  getStudioEventTime,
} from '../../../utils/studio-events.js';

/** 事件字段拉平：StudioEvent（payload 嵌套）与历史扁平事件（字段在顶层）统一为平面对象 */
function flattenEvent(e: Record<string, unknown>): Record<string, any> {
  const { payload: _p, ...top } = e;
  return { ...(parseStudioEventPayload(e) ?? {}), ...top };
}

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
 * 数据源: session:summary + pipelineRun + routing.jsonl + git log + KnowledgeBus
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

    // 1. Session summary（D18：读统一事件文件；兼容 payload 嵌套与历史扁平形态）
    try {
      const allEvents = await readStudioEvents();
      const sinceMs = since.getTime();
      const sessions = allEvents
        .filter(e => e.type === 'session:summary' && getStudioEventTime(e) >= sinceMs)
        .map(flattenEvent);
      if (sessions.length > 0) {
        // 字段兼容：外部扁平写入方（turnCount/durationMin/tool）vs
        // session-summary-generator（eventCount/durationMs/toolsUsed/patternType）
        const turnOf = (s: any) => s.turnCount ?? s.eventCount ?? 0;
        const totalTurns = sessions.reduce((sum: number, s: any) => sum + turnOf(s), 0);
        const deepCount = sessions.filter((s: any) => s.deepAnalysis).length;
        const captureRate = deepCount > 0
          ? Math.round((sessions.filter((s: any) => s.knowledgeCaptured).length / deepCount) * 100)
          : 0;
        const tools = [...new Set(sessions.map((s: any) => s.tool || s.patternType || 'unknown'))];
        const totalMin = sessions.reduce((sum: number, s: any) =>
          sum + (s.durationMin ?? (typeof s.durationMs === 'number' ? Math.round(s.durationMs / 60000) : 0)), 0);

        lines.push('### 会话活动');
        lines.push(`- 会话: ${sessions.length} 次 | 总 turn: ${totalTurns} | 总时长: ${totalMin}min`);
        lines.push(`- 工具: ${tools.join(', ')}`);
        lines.push(`- 深度分析: ${deepCount} | 知识捕获率: ${captureRate}%`);
        const highTurn = sessions.filter((s: any) => turnOf(s) > 30);
        if (highTurn.length > 0) {
          lines.push(`- ⚠️ ${highTurn.length} 个会话超过 30 turns — 考虑 cstnew 重置上下文`);
        }
      }
    } catch { lines.push('### 会话活动\n(数据源不可用)'); }

    // 1b. Pattern detection (7-day window, from 统一事件文件 session:summary)
    try {
      const weekAgoMs = now - 7 * 24 * 3600_000;
      const allStudioEvents = await readStudioEvents();
      const summaryEvents = allStudioEvents
        .filter(e => e.type === 'session:summary' && getStudioEventTime(e) >= weekAgoMs)
        .map(e => ({ payload: e.payload || null }));

      if (summaryEvents.length >= 5) {
        const typeCounts: Record<string, { count: number; successCount: number }> = {};
        for (const ev of summaryEvents) {
          try {
            const p = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
            const pt = (p as any)?.patternType || (p as any)?.workflowType || 'unknown';
            if (!typeCounts[pt]) typeCounts[pt] = { count: 0, successCount: 0 };
            typeCounts[pt].count++;
            if ((p as any)?.success !== false) typeCounts[pt].successCount++;
          } catch {}
        }

        const recurring = Object.entries(typeCounts)
          .filter(([_, s]) => s.count >= 3 && s.successCount / s.count > 0.7)
          .sort((a, b) => b[1].count - a[1].count);

        if (recurring.length > 0) {
          lines.push('', '### 交互模式（7天）');
          for (const [pt, s] of recurring) {
            const rate = Math.round((s.successCount / s.count) * 100);
            lines.push(`- **${pt}**: ${s.count} 次, 成功率 ${rate}%`);
            if (['ci_fix', 'test_triage', 'release_prep'].includes(pt)) {
              lines.push(`  → 建议创建 Skill 自动化此模式`);
            }
          }
        }

        // B9-025: Persist pattern_report + update UserPreference（D18：统一写入入口）
        const distribution: Record<string, number> = {};
        for (const [pt, s] of Object.entries(typeCounts)) distribution[pt] = s.count;
        const recurringData = recurring.map(([pt, s]) => ({
          type: pt,
          count: s.count,
          successRate: Math.round((s.successCount / s.count) * 100) / 100,
          lastSeen: today,
        }));

        void writeStudioEvent('pattern_report', { distribution, recurring: recurringData, date: today }, { source: 'monitor' });

        preferenceObserver.updateFromPatternReport(distribution, recurringData).catch((e) => {
          logger.warn('[MonitorService] updateFromPatternReport failed', { error: String(e) });
        });
      }
    } catch { /* best-effort */ }

    // 2. Git commits
    try {
      const { execSync } = await import('child_process');
      const repoDir = process.env.REPO_DIR || '/root/projects/studio';
      const gitLog = execSync(
        `git log --since="${since.toISOString()}" --oneline --no-merges 2>/dev/null | wc -l`,
        { cwd: repoDir, timeout: 5000 }
      ).toString().trim();
      const fileCount = execSync(
        `git diff --stat HEAD "@{24 hours ago}" 2>/dev/null | tail -1`,
        { cwd: repoDir, timeout: 5000 }
      ).toString().trim();

      if (parseInt(gitLog) > 0) {
        lines.push('', '### 代码变更');
        lines.push(`- Commits: ${gitLog} | ${fileCount || 'N/A'}`);
      }
    } catch { /* best-effort */ }

    // 4. KnowledgeBus
    try {
      const stats = knowledgeService.getStats();
      lines.push('', '### 知识积累');
      lines.push(`- KnowledgeBus: ${stats.total || 0} 条 (pattern:${stats.pattern || 0} fix:${stats.fix || 0})`);
    } catch { /* best-effort */ }

    // 4b. Knowledge consumption hit rate (24h)（D18：统一事件文件，createdAt 口径）
    try {
      const sinceMs = since.getTime();
      const allStudioEvents = await readStudioEvents();
      const consumptionEvents = allStudioEvents
        .filter(e => e.type === 'knowledge:consumption' && getStudioEventTime(e) >= sinceMs)
        .map(e => ({ source: (e.source as string) || '', payload: e.payload || null }));
      const searchHitEvents = allStudioEvents
        .filter(e => e.type === 'knowledge:search_hit' && getStudioEventTime(e) >= sinceMs)
        .map(e => ({ payload: e.payload || null }));

      if (consumptionEvents.length > 0 || searchHitEvents.length > 0) {
        lines.push('', '### 知识消费（24h）');
        lines.push(`- 引用事件: ${consumptionEvents.length} 次`);

        // By contributor
        const byContributor: Record<string, number> = {};
        for (const ev of consumptionEvents) {
          byContributor[ev.source] = (byContributor[ev.source] || 0) + 1;
        }
        const contribLine = Object.entries(byContributor)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([c, n]) => `${c}(${n})`)
          .join(', ');
        if (contribLine) lines.push(`- 来源: ${contribLine}`);

        // Search hit rate
        if (searchHitEvents.length > 0) {
          let totalHits = 0;
          let totalScore = 0;
          for (const ev of searchHitEvents) {
            try {
              const p = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
              totalHits += (p as any).hitCount || 0;
              totalScore += ((p as any).avgScore || 0) * ((p as any).hitCount || 1);
            } catch {}
          }
          const avgHitCount = Math.round(totalHits / searchHitEvents.length);
          const avgScore = totalHits > 0 ? Math.round(totalScore / totalHits * 100) / 100 : 0;
          lines.push(`- 搜索: ${searchHitEvents.length} 次查询, 平均命中 ${avgHitCount} 条, 平均分 ${avgScore}`);
        }
      }

      // Write aggregated stats for audit D6 to read
      try {
        const statsPath = studioPath('knowledge', '.consumption-stats.json');
        fs.writeFileSync(statsPath, JSON.stringify({
          date: today,
          dailyEvents: consumptionEvents.length,
          searchHits: searchHitEvents.length,
        }), 'utf-8');
      } catch { /* best-effort */ }
    } catch { /* best-effort */ }

    // 5. Knowledge quality audit (daily, auto-fix)
    try {
      const { KnowledgeAudit } = await import('@dommaker/harness') as any;
      const knowledgeDir = studioPath('knowledge');
      const audit = new KnowledgeAudit({ baseDir: knowledgeDir });
      const report = audit.run({ autoFix: true });
      if (report.totalEntries > 0) {
        lines.push('', '### 知识质量审计');
        lines.push(`- 总条目: ${report.totalEntries} | 健康分: ${report.healthScore.before}→${report.healthScore.after}/100`);
        if (report.autoFixed > 0) {
          lines.push(`- 自动修复: ${report.autoFixed} 条`);
        }
        const dimLabels: Record<string, string> = {
          structure: '结构', content: '内容', dedup: '去重',
          maturity: '成熟度', freshness: '新鲜度', flywheel: '飞轮',
        };
        const dimLine = Object.entries(report.dimensions)
          .map(([k, d]: [string, any]) => `${dimLabels[k] || k}:${d.score}`)
          .join(' | ');
        lines.push(`- 维度: ${dimLine}`);
        const criticalCount = report.issues.filter((i: any) => i.severity === 'critical').length;
        const highCount = report.issues.filter((i: any) => i.severity === 'high').length;
        if (criticalCount > 0 || highCount > 0) {
          lines.push(`- ⚠️ 需关注: ${criticalCount} critical, ${highCount} high`);
        }
      }
    } catch { /* best-effort: audit module may not be available */ }

    // 5b. Knowledge index snapshot (for KR4 30d survival rate)
    try {
      const { FileKnowledgeStore } = await import('@dommaker/harness') as any;
      const knowledgeDir = studioPath('knowledge');
      const store = new FileKnowledgeStore({ baseDir: knowledgeDir });
      store.snapshot();
    } catch { /* best-effort */ }

    // B9-025: Weekly profile report (every Sunday)
    if (new Date(now).getDay() === 0) {
      try {
        const weekAgoMs = now - 7 * 24 * 3600_000;
        const allStudioEvents = await readStudioEvents();
        const weeklyEvents = allStudioEvents
          .filter(e => ['pattern_report', 'workflow_report'].includes(e.type as string) && getStudioEventTime(e) >= weekAgoMs)
          .sort((a, b) => getStudioEventTime(b) - getStudioEventTime(a))
          .map(e => ({ payload: e.payload || null }));

        if (weeklyEvents.length > 0) {
          const merged: Record<string, number> = {};
          for (const ev of weeklyEvents) {
            try {
              const p = typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload;
              const dist = (p as any)?.distribution || {};
              for (const [k, v] of Object.entries(dist)) merged[k] = (merged[k] || 0) + (v as number);
            } catch {}
          }

          const sorted = Object.entries(merged).sort((a, b) => b[1] - a[1]);
          if (sorted.length > 0) {
            lines.push('', '### 周交互画像');
            lines.push(`- Top 模式: ${sorted.slice(0, 3).map(([t, c]) => `${t}(${c})`).join(', ')}`);
            const { sharedStore } = await import('../../knowledge/knowledge-bus.service.js');
            const prefEntries = sharedStore.list({ tags: ['preference', 'user-default'] });
            const prefData = prefEntries.length > 0 ? JSON.parse((prefEntries[0] as any).content || '{}') : {};
            const preferredRaw = prefData.preferredPatternTypes;
            if (preferredRaw) {
              const preferred = JSON.parse(preferredRaw) as string[];
              const newTypes = sorted.filter(([t]) => !preferred.includes(t)).map(([t]) => t);
              if (newTypes.length > 0) lines.push(`- 新增高频类型: ${newTypes.join(', ')}`);
            }
          }
        }
      } catch { /* best-effort */ }
    }

    // Post to #系统 channel
    const content = lines.join('\n');
    try {
      const sysChannels = await fileStore.listChannels({ name: '#系统' });
      const sysChannel = sysChannels[0] ?? null;
      if (sysChannel) {
        const { channelMessageService } = await import('../../channels/channel-message.service.js');
        await channelMessageService.createAgentMessage(sysChannel.id, 'DailyReflection', content, {
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
        const { discordNotifier } = await import('../../../utils/discord-notifier.js');
        await discordNotifier.sendChannelMessage(channel, 'DailyReflection', content, {
          cardType: 'daily_reflection',
        });
      }
    } catch { /* Discord best-effort */ }
  } catch (e: any) {
    logger.warn('[MonitorService] DailyReflection failed', { error: String(e) });
  }
}

