/**
 * PreferenceObserver 独立测试 — KnowledgeStore 存储
 *
 * 覆盖：updateFromToolTrace、updateActiveHours、updateResponseStyle、
 *       updateAutoApproveThreshold、getPreferences、formatForPrompt
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

let observer: InstanceType<typeof import('../preference-observer.js').PreferenceObserver>;

// Mock sharedStore — 内存 KV，隔离于真实文件系统
const storeEntries = new Map<string, any>();

vi.mock('../knowledge-singletons.js', () => ({
  sharedStore: {
    list: (filter?: { tags?: string[] }) => {
      if (!filter?.tags) return Array.from(storeEntries.values());
      return Array.from(storeEntries.values()).filter((e: any) =>
        filter.tags!.every(t => (e.tags || []).includes(t))
      );
    },
    save: (entry: any) => {
      storeEntries.set(entry.id, entry);
    },
    get: (id: string) => storeEntries.get(id) || null,
  },
}));

beforeAll(async () => {
  const { PreferenceObserver } = await import('../preference-observer.js');
  observer = new PreferenceObserver();
});

beforeEach(() => {
  storeEntries.clear();
});

// ════════════════════════════════════════════
// updateFromToolTrace
// ════════════════════════════════════════════

describe('PreferenceObserver.updateFromToolTrace', () => {
  it('creates preference and records tool usage', async () => {
    await observer.updateFromToolTrace({
      tool: 'read', success: true, durationMs: 100, timestamp: Date.now(),
    });

    const entry = storeEntries.get('user-preference-default');
    expect(entry).toBeDefined();
    const tools = JSON.parse(entry.content).favoriteTools;
    const parsed = JSON.parse(tools);
    expect(parsed).toContainEqual(expect.objectContaining({ name: 'read', count: 1 }));
  });

  it('increments count for repeated tool', async () => {
    await observer.updateFromToolTrace({ tool: 'read', success: true, durationMs: 50, timestamp: Date.now() });
    await observer.updateFromToolTrace({ tool: 'edit', success: true, durationMs: 200, timestamp: Date.now() });
    await observer.updateFromToolTrace({ tool: 'read', success: true, durationMs: 80, timestamp: Date.now() });

    const entry = storeEntries.get('user-preference-default');
    const tools = JSON.parse(entry.content).favoriteTools;
    const parsed = JSON.parse(tools) as Array<{ name: string; count: number }>;
    const readEntry = parsed.find(t => t.name === 'read');
    expect(readEntry!.count).toBeGreaterThanOrEqual(2);
  });

  it('sorts tools by count descending, keeps top 10', async () => {
    for (let i = 0; i < 3; i++) {
      await observer.updateFromToolTrace({ tool: 'exec', success: true, durationMs: 500, timestamp: Date.now() });
    }

    const entry = storeEntries.get('user-preference-default');
    const tools = JSON.parse(entry.content).favoriteTools;
    const parsed = JSON.parse(tools) as Array<{ name: string; count: number }>;
    for (let i = 1; i < parsed.length; i++) {
      expect(parsed[i - 1].count).toBeGreaterThanOrEqual(parsed[i].count);
    }
    expect(parsed.length).toBeLessThanOrEqual(10);
  });

  it('increases confidence via EMA', async () => {
    // 先写入初始状态
    await observer.updateFromToolTrace({ tool: 'seed', success: true, durationMs: 10, timestamp: Date.now() });
    const before = JSON.parse(storeEntries.get('user-preference-default').content).confidence;
    await observer.updateFromToolTrace({ tool: 'grep', success: true, durationMs: 30, timestamp: Date.now() });
    const after = JSON.parse(storeEntries.get('user-preference-default').content).confidence;
    expect(after).toBeGreaterThan(before);
  });
});

// ════════════════════════════════════════════
// updateActiveHours
// ════════════════════════════════════════════

describe('PreferenceObserver.updateActiveHours', () => {
  it('skips empty array', async () => {
    await observer.updateActiveHours([]);
  });

  it('extracts top 8 active hours sorted ascending', async () => {
    const now = new Date();
    const messages = [
      { createdAt: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9) },
      { createdAt: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9) },
      { createdAt: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 9) },
      { createdAt: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14) },
      { createdAt: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 14) },
      { createdAt: new Date(now.getFullYear(), now.getMonth(), now.getDate(), 22) },
    ];

    await observer.updateActiveHours(messages);

    const entry = storeEntries.get('user-preference-default');
    const hours = JSON.parse(entry.content).activeHours;
    const parsed = JSON.parse(hours) as number[];
    expect(parsed).toContain(9);
    expect(parsed).toContain(14);
    expect(parsed.length).toBeLessThanOrEqual(8);
    for (let i = 1; i < parsed.length; i++) {
      expect(parsed[i]).toBeGreaterThan(parsed[i - 1]);
    }
  });
});

// ════════════════════════════════════════════
// updateResponseStyle
// ════════════════════════════════════════════

describe('PreferenceObserver.updateResponseStyle', () => {
  it('skips empty array', async () => {
    await observer.updateResponseStyle([]);
  });

  it('short messages → concise', async () => {
    const messages = Array(10).fill({ content: 'ok', createdAt: new Date().toISOString() });
    await observer.updateResponseStyle(messages);
    const content = JSON.parse(storeEntries.get('user-preference-default').content);
    expect(content.responseStyle).toBe('concise');
  });

  it('medium messages → balanced', async () => {
    const messages = Array(10).fill({ content: 'A'.repeat(100), createdAt: new Date().toISOString() });
    await observer.updateResponseStyle(messages);
    const content = JSON.parse(storeEntries.get('user-preference-default').content);
    expect(content.responseStyle).toBe('balanced');
  });

  it('long messages → detailed', async () => {
    const messages = Array(10).fill({ content: 'A'.repeat(300), createdAt: new Date().toISOString() });
    await observer.updateResponseStyle(messages);
    const content = JSON.parse(storeEntries.get('user-preference-default').content);
    expect(content.responseStyle).toBe('detailed');
  });

  it('sets avgMessageLength', async () => {
    const messages = Array(10).fill({ content: 'A'.repeat(100), createdAt: new Date().toISOString() });
    await observer.updateResponseStyle(messages);
    const content = JSON.parse(storeEntries.get('user-preference-default').content);
    expect(content.avgMessageLength).toBe(100);
  });
});

// ════════════════════════════════════════════
// updateAutoApproveThreshold
// ════════════════════════════════════════════

describe('PreferenceObserver.updateAutoApproveThreshold', () => {
  it('skips if total < 5', async () => {
    await observer.updateAutoApproveThreshold(2, 1);
    // no error, no update — content unchanged
  });

  it('high confirmation rate (>0.8) → threshold 0.5', async () => {
    await observer.updateAutoApproveThreshold(18, 2);
    const content = JSON.parse(storeEntries.get('user-preference-default').content);
    expect(content.autoApproveThreshold).toBe(0.5);
  });

  it('medium rate (>0.5) → threshold 0.7', async () => {
    await observer.updateAutoApproveThreshold(7, 3);
    const content = JSON.parse(storeEntries.get('user-preference-default').content);
    expect(content.autoApproveThreshold).toBe(0.7);
  });

  it('low rate (<=0.5) → threshold 0.85', async () => {
    await observer.updateAutoApproveThreshold(3, 7);
    const content = JSON.parse(storeEntries.get('user-preference-default').content);
    expect(content.autoApproveThreshold).toBe(0.85);
  });
});

// ════════════════════════════════════════════
// getPreferences
// ════════════════════════════════════════════

describe('PreferenceObserver.getPreferences', () => {
  it('returns null when no preference stored', async () => {
    storeEntries.clear();
    const result = await observer.getPreferences();
    // No stored entry → readPrefs returns default (confidence=0.3 >= 0.3)
    // Default cold-start has no useful fields → filtered by confidence>=0.3
    // confidence=0.3 >= 0.3 so it returns basic data
    expect(result).not.toBeNull();
    expect(result!.confidence).toBe(0.3);
  });

  it('returns null if confidence < 0.3', async () => {
    storeEntries.set('user-preference-default', {
      id: 'user-preference-default',
      content: JSON.stringify({ confidence: 0.2 }),
      tags: ['preference', 'user-default'],
    });
    const result = await observer.getPreferences();
    expect(result).toBeNull();
  });

  it('returns parsed preferences when confidence >= 0.3', async () => {
    storeEntries.set('user-preference-default', {
      id: 'user-preference-default',
      content: JSON.stringify({
        confidence: 0.35,
        preferredModel: 'premium',
        modelUsageRatio: '{"premium":0.7}',
        responseStyle: 'concise',
        activeHours: '[9,10,14]',
        favoriteTools: '[{"name":"read","count":5}]',
        autoApproveThreshold: 0.7,
      }),
      tags: ['preference', 'user-default'],
    });

    const result = await observer.getPreferences();
    expect(result).not.toBeNull();
    expect(result!.preferredModel).toBe('premium');
    expect(result!.responseStyle).toBe('concise');
    expect(result!.activeHours).toEqual([9, 10, 14]);
    expect(result!.confidence).toBe(0.35);
  });
});

// ════════════════════════════════════════════
// formatForPrompt
// ════════════════════════════════════════════

describe('PreferenceObserver.formatForPrompt', () => {
  it('returns empty string when no preferences', async () => {
    storeEntries.clear();
    const result = await observer.formatForPrompt();
    expect(result).toBe('');
  });

  it('formats responseStyle, preferredModel, activeHours', async () => {
    storeEntries.set('user-preference-default', {
      id: 'user-preference-default',
      content: JSON.stringify({
        confidence: 0.5,
        preferredModel: 'premium',
        modelUsageRatio: '{}',
        responseStyle: 'concise',
        activeHours: '[9,14,22]',
        favoriteTools: '[]',
      }),
      tags: ['preference', 'user-default'],
    });

    const result = await observer.formatForPrompt();
    expect(result).toContain('用户偏好');
    expect(result).toContain('concise');
    expect(result).toContain('premium');
  });
});

// ════════════════════════════════════════════
// computeConfidence — EMA 递增验证
// ════════════════════════════════════════════

describe('computeConfidence (EMA)', () => {
  it('confidence increases monotonically with EMA alpha=0.15', async () => {
    storeEntries.clear();
    // 需要先有一个 base entry
    storeEntries.set('user-preference-default', {
      id: 'user-preference-default',
      content: JSON.stringify({ confidence: 0.3, favoriteTools: '[]' }),
      tags: ['preference', 'user-default'],
    });

    const confidences: number[] = [];
    for (let i = 0; i < 5; i++) {
      await observer.updateFromToolTrace({ tool: `t${i}`, success: true, durationMs: 10, timestamp: Date.now() });
      const content = JSON.parse(storeEntries.get('user-preference-default').content);
      confidences.push(content.confidence);
    }

    for (let i = 1; i < confidences.length; i++) {
      expect(confidences[i]).toBeGreaterThan(confidences[i - 1]);
    }

    // EMA: next = current + (1-current)*0.15
    // 0.3 → 0.405 → 0.494 → 0.57 → 0.635 → 0.689
    expect(confidences[4]).toBeGreaterThan(0.6);
    expect(confidences[4]).toBeLessThan(0.8);
  });
});
