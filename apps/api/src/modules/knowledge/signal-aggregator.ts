/**
 * Signal Aggregator — 原始 signal 条目 → 聚合趋势摘要
 *
 * 设计目标（AS-022）：
 *   signal 层注入的是趋势摘要（"部署超时频发: 5次/7天"），不是原始事件。
 *   Aggregator 把 KnowledgeStore 中的原始 signal 条目按 tag 聚合，
 *   达到阈值后生成趋势条目，供 prompt-builder 索引注入。
 *
 * 触发：管线完成（PostEval）后运行
 * 阈值：≥3 次/7 天
 * 输出：consumptionMode=signal, tags=[trend-aggregated, <tag>]
 */

import { logger } from '@dommaker/studio-shared';
import { sharedStore, sharedIngest, sharedLifecycle, scheduleVectorDbSync } from './knowledge-bus.service.js';

// ── Types ──

interface TagGroup {
  tag: string;
  entries: Array<{ id: string; title: string; created: string; content: string }>;
}

interface TrendSummary {
  tag: string;
  count: number;
  windowDays: number;
  sampleTitles: string[];
}

// ── Config ──

const AGGREGATION_WINDOW_DAYS = 7;
const AGGREGATION_THRESHOLD = 3;
const MAX_TREND_ENTRIES = 20;
const TREND_TAG = 'trend-aggregated';

// ── Aggregator ──

export class SignalAggregator {
  /**
   * 扫描原始 signal 条目，按 tag 聚合，生成趋势摘要。
   * 返回新生成的趋势条目数。
   */
  async run(): Promise<number> {
    try {
      const rawSignals = this.loadRawSignals();
      if (rawSignals.length === 0) {
        logger.debug('[SignalAggregator] No raw signal entries to aggregate');
        return 0;
      }

      const groups = this.groupByTag(rawSignals);
      const trends = this.filterTrends(groups);

      if (trends.length === 0) {
        logger.debug('[SignalAggregator] No trends meet threshold', { groupCount: groups.length });
        return 0;
      }

      let created = 0;
      for (const trend of trends.slice(0, MAX_TREND_ENTRIES)) {
        const entry = this.upsertTrend(trend);
        if (entry) created++;
      }

      if (created > 0) {
        logger.info('[SignalAggregator] Trends aggregated', { created, total: trends.length });
      }
      return created;
    } catch (err) {
      logger.warn('[SignalAggregator] Aggregation failed (non-blocking)', { error: String(err) });
      return 0;
    }
  }

  /**
   * 加载原始 signal 条目（排除已聚合的趋势条目）
   */
  private loadRawSignals(): Array<{ id: string; title: string; created: string; content: string; tags: string[] }> {
    const entries = sharedStore.list({ consumptionModes: ['signal'] });
    return entries
      .filter(e => !e.tags?.includes(TREND_TAG))
      .map(e => ({
        id: e.id,
        title: e.title,
        created: e.created,
        content: e.content,
        tags: e.tags || [],
      }));
  }

  /**
   * 按 tag 分组（跳过通用 tag）
   */
  private groupByTag(entries: ReturnType<typeof this.loadRawSignals>): TagGroup[] {
    const SKIP_TAGS = new Set([TREND_TAG, 'low_quality', 'design-doc']);
    const groups = new Map<string, TagGroup['entries']>();

    for (const entry of entries) {
      const meaningfulTags = entry.tags.filter(t => !SKIP_TAGS.has(t));
      const tag = meaningfulTags[0]; // 取第一个有意义的 tag
      if (!tag) continue;

      if (!groups.has(tag)) groups.set(tag, []);
      groups.get(tag)!.push(entry);
    }

    return Array.from(groups.entries()).map(([tag, entries]) => ({ tag, entries }));
  }

  /**
   * 过滤：时间窗口内频次 ≥ 阈值的分组
   */
  private filterTrends(groups: TagGroup[]): TrendSummary[] {
    const cutoff = Date.now() - AGGREGATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;

    return groups
      .map(group => {
        const recent = group.entries.filter(e => {
          const created = new Date(e.created).getTime();
          return created >= cutoff;
        });
        return {
          tag: group.tag,
          count: recent.length,
          windowDays: AGGREGATION_WINDOW_DAYS,
          sampleTitles: recent.slice(0, 3).map(e => e.title),
        };
      })
      .filter(t => t.count >= AGGREGATION_THRESHOLD);
  }

  /**
   * 创建或更新趋势条目
   */
  private upsertTrend(trend: TrendSummary): boolean {
    const title = `趋势: ${trend.tag} 频发 ${trend.count}次/${trend.windowDays}天`;
    const content = [
      `tag: ${trend.tag}`,
      `count: ${trend.count}`,
      `window: ${trend.windowDays}d`,
      `samples:`,
      ...trend.sampleTitles.map(t => `  - ${t.slice(0, 80)}`),
    ].join('\n');

    // 检查是否已有同 tag 的趋势条目
    const existing = sharedStore.list({ tags: [TREND_TAG] }).find(e => e.tags?.includes(trend.tag));
    if (existing) {
      // 更新已有趋势
      sharedStore.update(existing.id, { content, title });
      sharedLifecycle.recordReference(existing.id, 'signal-aggregator');
      logger.debug('[SignalAggregator] Updated trend', { tag: trend.tag, id: existing.id });
      return false;
    }

    // 创建新趋势条目
    const result = sharedIngest.ingestEntry(
      { type: 'guideline', title, content, tags: [TREND_TAG, trend.tag] },
      { source: 'signal-aggregator', layer: 'project', maturity: 'active', tags: [TREND_TAG, trend.tag], consumptionMode: 'signal' },
    );
    scheduleVectorDbSync();
    logger.debug('[SignalAggregator] Created trend', { tag: trend.tag, id: result.id });
    return true;
  }
}

export const signalAggregator = new SignalAggregator();
