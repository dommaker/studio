/**
 * #614 复现 + 防回归：tag append 路径无去重反复追加同一值（活跃数据腐蚀）。
 *
 * 实盘 63 个 guideline-rule-*.md 的 tags 被每次冷启动 fullScan 追加一个
 * 'deprecated'（rule-scanner 弃置路径）；pattern-miner 清理旧模式同理
 * 反复追加 'outdated'（data.status 不随 tags 改写，每次运行都命中）。
 *
 * AC：重复 fullScan / 清理循环后，条目 tags 中同一值至多出现 1 次；
 * 已达终态（deprecated / outdated）的条目不再重复写。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { entries, sharedStore } = vi.hoisted(() => {
  const entries = new Map<string, any>();
  const sharedStore = {
    list: vi.fn((filter: any = {}) => {
      let all = [...entries.values()];
      if (filter.tags) all = all.filter(e => filter.tags.every((t: string) => e.tags?.includes(t)));
      if (filter.types) all = all.filter(e => filter.types.includes(e.type));
      return all;
    }),
    save: vi.fn((e: any) => { entries.set(e.id, e); return e; }),
  };
  return { entries, sharedStore };
});

vi.mock('../knowledge-singletons.js', () => ({ sharedStore }));
vi.mock('../skills/skill-store.js', () => ({ skillStore: {} }));
vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  FileStore: class {},
}));

import { ruleScanner } from '../rule-scanner.js';
import { PatternMiner } from '../pattern-miner.js';

function tagCounts(tags: string[]): Record<string, number> {
  return tags.reduce((acc: Record<string, number>, t) => {
    acc[t] = (acc[t] || 0) + 1;
    return acc;
  }, {});
}

beforeEach(() => {
  entries.clear();
  sharedStore.list.mockClear();
  sharedStore.save.mockClear();
});

describe('RuleScanner 弃置路径（#614）', () => {
  it('已弃置条目不重复追加 deprecated；未弃置条目弃置后 tags 无重复值', async () => {
    entries.set('rule-ghost-deprecated', {
      id: 'rule-ghost-deprecated',
      type: 'guideline',
      title: 'ghost-rule-already-deprecated',
      content: '{}',
      tags: ['rule', 'deprecated'],
    });
    entries.set('rule-ghost-active', {
      id: 'rule-ghost-active',
      type: 'guideline',
      title: 'ghost-rule-still-active',
      content: '{}',
      tags: ['rule', 'active', 'threshold'],
    });

    await ruleScanner.fullScan();
    await ruleScanner.fullScan();

    for (const id of ['rule-ghost-deprecated', 'rule-ghost-active']) {
      const tags = entries.get(id).tags as string[];
      for (const [tag, n] of Object.entries(tagCounts(tags))) {
        expect(n, `${id} tag "${tag}" 重复 ${n} 次`).toBe(1);
      }
    }
    // 弃置写入路径：摘 active、补 deprecated
    expect(entries.get('rule-ghost-active').tags).toContain('deprecated');
    expect(entries.get('rule-ghost-active').tags).not.toContain('active');

    // 已达终态的条目第二轮不再重复写（腐蚀源头：每次冷启动扫描都 save 一次）
    sharedStore.save.mockClear();
    await ruleScanner.fullScan();
    const rewritten = sharedStore.save.mock.calls.map(c => c[0].id);
    expect(rewritten).not.toContain('rule-ghost-deprecated');
    expect(rewritten).not.toContain('rule-ghost-active');
  });
});

describe('PatternMiner 旧模式清理（#614）', () => {
  const oldDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const fakeTraces = Array.from({ length: 10 }, (_, i) => ({
    type: 'tool:call',
    tool: `tool-${i}`,
    success: true,
    durationMs: 10,
    timestamp: Date.now() - i * 1000,
  }));

  function seedPatterns() {
    entries.set('pat-outdated', {
      id: 'pat-outdated',
      type: 'pattern',
      title: 'pat-already-outdated',
      content: JSON.stringify({ status: 'active', observedPeriodEnd: oldDate, confidence: 0.5, frequency: 3 }),
      tags: ['pattern', 'outdated'],
    });
    entries.set('pat-active', {
      id: 'pat-active',
      type: 'pattern',
      title: 'pat-still-active',
      content: JSON.stringify({ status: 'active', observedPeriodEnd: oldDate, confidence: 0.5, frequency: 3 }),
      tags: ['pattern', 'active'],
    });
  }

  it('重复清理循环后 tags 同一值至多 1 次，已达 outdated 的条目不再重复写', async () => {
    seedPatterns();
    const miner = new PatternMiner();
    (miner as any).loadTracesSince = async () => fakeTraces;

    await miner.analyzeDaily();
    await miner.analyzeDaily();

    for (const id of ['pat-outdated', 'pat-active']) {
      const tags = entries.get(id).tags as string[];
      for (const [tag, n] of Object.entries(tagCounts(tags))) {
        expect(n, `${id} tag "${tag}" 重复 ${n} 次`).toBe(1);
      }
    }
    expect(entries.get('pat-active').tags).toContain('outdated');
    expect(entries.get('pat-active').tags).not.toContain('active');

    sharedStore.save.mockClear();
    await miner.analyzeDaily();
    const rewritten = sharedStore.save.mock.calls.map(c => c[0].id);
    expect(rewritten).not.toContain('pat-outdated');
    expect(rewritten).not.toContain('pat-active');
  });
});
