import * as fs from 'fs';

import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { knowledgeService, preferenceObserver } from '../knowledge/index.js';
import { execFileAsync } from '../../core/exec-async.js';
import {
  writeStudioEvent,
  parseStudioEventPayload,
  getStudioEventTime,
} from '@dommaker/studio-shared';
import type { SessionSummaryPayload } from '@dommaker/studio-shared';
// #335：窗口读口（尾部倒读 + 窗口外早停），替代 readStudioEvents 全量读
import { readStudioEventsSince } from '../../utils/studio-events-tail.js';
import { logger } from '@dommaker/studio-shared/node';

/** 事件 payload 解包（唯一写入方 = session-summary-generator 的 payload 嵌套形态） */
function flattenEvent(e: Record<string, unknown>): SessionSummaryPayload {
  return parseStudioEventPayload<SessionSummaryPayload>(e) ?? {};
}

/** 1. Session summary（D18：读统一事件文件；#335 窗口读） */
export async function collectSessionActivityLines(since: Date): Promise<string[]> {
  const lines: string[] = [];
  try {
    const sinceMs = since.getTime();
    const allEvents = await readStudioEventsSince({ sinceMs });
    const sessions = allEvents
      .filter(e => e.type === 'session:summary' && getStudioEventTime(e) >= sinceMs)
      .map(flattenEvent);
    if (sessions.length > 0) {
      // 字段口径 = session-summary-generator（eventCount/durationMs/toolsUsed/patternType）
      const turnOf = (s: SessionSummaryPayload) => s.eventCount ?? 0;
      const totalTurns = sessions.reduce((sum: number, s) => sum + turnOf(s), 0);
      const deepCount = sessions.filter(s => s.deepAnalysis).length;
      const captureRate = deepCount > 0
        ? Math.round((sessions.filter(s => s.knowledgeCaptured).length / deepCount) * 100)
        : 0;
      const tools = [...new Set(sessions.map(s => s.patternType || 'unknown'))];
      const totalMin = sessions.reduce((sum: number, s) =>
        sum + (typeof s.durationMs === 'number' ? Math.round(s.durationMs / 60000) : 0), 0);

      lines.push('### 会话活动');
      lines.push(`- 会话: ${sessions.length} 次 | 总 turn: ${totalTurns} | 总时长: ${totalMin}min`);
      lines.push(`- 工具: ${tools.join(', ')}`);
      lines.push(`- 深度分析: ${deepCount} | 知识捕获率: ${captureRate}%`);
      const highTurn = sessions.filter(s => turnOf(s) > 30);
      if (highTurn.length > 0) {
        lines.push(`- ⚠️ ${highTurn.length} 个会话超过 30 turns — 考虑 cstnew 重置上下文`);
      }
    }
  } catch { lines.push('### 会话活动\n(数据源不可用)'); }
  return lines;
}

/** 1b. Pattern detection (7-day window, from 统一事件文件 session:summary) */
export async function collectPatternLines(now: number, today: string): Promise<string[]> {
  const lines: string[] = [];
  try {
    const weekAgoMs = now - 7 * 24 * 3600_000;
    const allStudioEvents = await readStudioEventsSince({ sinceMs: weekAgoMs });
    const summaryEvents = allStudioEvents
      .filter(e => e.type === 'session:summary' && getStudioEventTime(e) >= weekAgoMs)
      .map(e => ({ payload: e.payload || null }));

    if (summaryEvents.length >= 5) {
      const typeCounts: Record<string, { count: number; successCount: number }> = {};
      for (const ev of summaryEvents) {
        try {
          const p = (typeof ev.payload === 'string' ? JSON.parse(ev.payload) : ev.payload) as SessionSummaryPayload | null;
          const pt = p?.patternType || p?.workflowType || 'unknown';
          if (!typeCounts[pt]) typeCounts[pt] = { count: 0, successCount: 0 };
          typeCounts[pt].count++;
          if (p?.success !== false) typeCounts[pt].successCount++;
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
  return lines;
}

/** 2. Git commits */
export async function collectGitChangeLines(since: Date): Promise<string[]> {
  const lines: string[] = [];
  try {
    const repoDir = process.env.REPO_DIR || '/root/projects/studio';
    // execFile 数组参数不经 shell；git 失败走 catch 兜底（原 2>/dev/null 语义），
    // 行计数/末行改在 JS 里做（原 `| wc -l` / `| tail -1`）；#374 异步化不阻塞事件循环
    const gitLogOut = await execFileAsync(
      'git', ['log', `--since=${since.toISOString()}`, '--oneline', '--no-merges'],
      { cwd: repoDir, timeout: 5000 }
    );
    const gitLog = String(gitLogOut.split('\n').filter(l => l.trim()).length);
    const diffOut = await execFileAsync(
      'git', ['diff', '--stat', 'HEAD', '@{24 hours ago}'],
      { cwd: repoDir, timeout: 5000 }
    );
    const diffLines = diffOut.split('\n').map(l => l.trim()).filter(Boolean);
    const fileCount = diffLines[diffLines.length - 1] ?? '';

    if (parseInt(gitLog) > 0) {
      lines.push('', '### 代码变更');
      lines.push(`- Commits: ${gitLog} | ${fileCount || 'N/A'}`);
    }
  } catch { /* best-effort */ }
  return lines;
}

/** 4. KnowledgeBus */
export function collectKnowledgeBusLines(): string[] {
  const lines: string[] = [];
  try {
    const stats = knowledgeService.getStats();
    lines.push('', '### 知识积累');
    lines.push(`- KnowledgeBus: ${stats.total || 0} 条 (pattern:${stats.pattern || 0} fix:${stats.fix || 0})`);
  } catch { /* best-effort */ }
  return lines;
}

/** 4b. Knowledge consumption hit rate (24h)（D18：统一事件文件，createdAt 口径） */
export async function collectKnowledgeConsumptionLines(since: Date, today: string): Promise<string[]> {
  const lines: string[] = [];
  try {
    const sinceMs = since.getTime();
    const allStudioEvents = await readStudioEventsSince({ sinceMs });
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
  return lines;
}

/** 5. Knowledge quality audit (daily, auto-fix) */
export async function collectKnowledgeQualityLines(): Promise<string[]> {
  const lines: string[] = [];
  // #134①（harness 1.8.0）：KnowledgeAudit 构造签名改 (store, 阈值)，
  // baseDir 由 store 供给——走 sharedStore 单例（与运行时知识库同一路径
  // UNIFIED_KNOWLEDGE_DIR），不再自拼 {baseDir} 构造。
  // #559：去掉 as any——新版签名类型完整，编译期可拦签名漂移。
  try {
    const { KnowledgeAudit } = await import('@dommaker/harness');
    const { sharedStore } = await import('../knowledge/index.js');
    const audit = new KnowledgeAudit(sharedStore);
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
  return lines;
}

/** 5b. Knowledge index snapshot (for KR4 30d survival rate) */
export async function snapshotKnowledgeIndex(): Promise<void> {
  // #343 review：走 sharedStore 直通路径，不再裸建 FileKnowledgeStore 实例
  try {
    const { sharedStore } = await import('../knowledge/index.js');
    sharedStore.snapshot();
  } catch { /* best-effort */ }
}

/** B9-025: Weekly profile report (every Sunday) */
export async function collectWeeklyProfileLines(now: number): Promise<string[]> {
  const lines: string[] = [];
  if (new Date(now).getDay() !== 0) return lines;
  try {
    const weekAgoMs = now - 7 * 24 * 3600_000;
    const allStudioEvents = await readStudioEventsSince({ sinceMs: weekAgoMs });
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
        const { sharedStore } = await import('../knowledge/index.js');
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
  return lines;
}
