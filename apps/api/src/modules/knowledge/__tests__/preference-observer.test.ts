/**
 * PreferenceObserver 独立测试
 *
 * 覆盖：updateFromToolTrace、updateFromRoutingFeedback、updateActiveHours、
 *       updateResponseStyle、updateAutoApproveThreshold、getPreferences、formatForPrompt
 *
 * 约定：真 SQLite (test.db)，无 Prisma mock，测试后清理数据
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';

let observer: InstanceType<typeof import('../preference-observer.js').PreferenceObserver>;

beforeAll(async () => {
  // 动态 import 获取新鲜实例
  const { PreferenceObserver } = await import('../preference-observer.js');
  observer = new PreferenceObserver();

  // 清理遗留测试数据
  await prisma.userPreference.deleteMany({ where: { userId: 'default' } });
});

afterAll(async () => {
  await prisma.userPreference.deleteMany({ where: { userId: 'default' } });
});

// ════════════════════════════════════════════
// updateFromToolTrace
// ════════════════════════════════════════════

describe('PreferenceObserver.updateFromToolTrace', () => {
  it('creates preference and records tool usage', async () => {
    await observer.updateFromToolTrace({
      tool: 'read',
      success: true,
      durationMs: 100,
      timestamp: Date.now(),
    });

    const pref = await prisma.userPreference.findFirst({ where: { userId: 'default' } });
    expect(pref).not.toBeNull();
    const tools = JSON.parse(pref!.favoriteTools);
    expect(tools).toContainEqual(expect.objectContaining({ name: 'read', count: 1 }));
  });

  it('increments count for repeated tool', async () => {
    await observer.updateFromToolTrace({ tool: 'read', success: true, durationMs: 50, timestamp: Date.now() });
    await observer.updateFromToolTrace({ tool: 'edit', success: true, durationMs: 200, timestamp: Date.now() });
    await observer.updateFromToolTrace({ tool: 'read', success: true, durationMs: 80, timestamp: Date.now() });

    const pref = await prisma.userPreference.findFirst({ where: { userId: 'default' } });
    const tools = JSON.parse(pref!.favoriteTools) as Array<{ name: string; count: number }>;
    const readEntry = tools.find(t => t.name === 'read');
    expect(readEntry!.count).toBe(3); // 1 from first test + 2 from this test
  });

  it('sorts tools by count descending, keeps top 10', async () => {
    // 添加多个不同工具
    for (let i = 0; i < 3; i++) {
      await observer.updateFromToolTrace({ tool: 'exec', success: true, durationMs: 500, timestamp: Date.now() });
    }

    const pref = await prisma.userPreference.findFirst({ where: { userId: 'default' } });
    const tools = JSON.parse(pref!.favoriteTools) as Array<{ name: string; count: number }>;
    // 验证排序
    for (let i = 1; i < tools.length; i++) {
      expect(tools[i - 1].count).toBeGreaterThanOrEqual(tools[i].count);
    }
    expect(tools.length).toBeLessThanOrEqual(10);
  });

  it('increases confidence via EMA', async () => {
    const before = await prisma.userPreference.findFirst({ where: { userId: 'default' } });
    const confBefore = before!.confidence;

    await observer.updateFromToolTrace({ tool: 'grep', success: true, durationMs: 30, timestamp: Date.now() });

    const after = await prisma.userPreference.findFirst({ where: { userId: 'default' } });
    expect(after!.confidence).toBeGreaterThan(confBefore);
  });
});

// ════════════════════════════════════════════
// updateFromRoutingFeedback
// ════════════════════════════════════════════

describe('PreferenceObserver.updateFromRoutingFeedback', () => {
  it('skips empty array', async () => {
    await observer.updateFromRoutingFeedback([]);
    // no error
  });

  it('updates modelUsageRatio and preferredModel', async () => {
    await observer.updateFromRoutingFeedback([
      { taskId: 't1', tier: 'premium', result: 'success', duration: 100, timestamp: Date.now() },
      { taskId: 't2', tier: 'premium', result: 'success', duration: 200, timestamp: Date.now() },
      { taskId: 't3', tier: 'fast', result: 'success', duration: 50, timestamp: Date.now() },
    ]);

    const pref = await prisma.userPreference.findFirst({ where: { userId: 'default' } });
    const ratio = JSON.parse(pref!.modelUsageRatio) as Record<string, number>;
    expect(ratio['premium']).toBeGreaterThan(ratio['fast']);
    expect(pref!.preferredModel).toBe('premium');
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

    const pref = await prisma.userPreference.findFirst({ where: { userId: 'default' } });
    const hours = JSON.parse(pref!.activeHours) as number[];
    expect(hours).toContain(9);
    expect(hours).toContain(14);
    expect(hours.length).toBeLessThanOrEqual(8);
    // sorted ascending
    for (let i = 1; i < hours.length; i++) {
      expect(hours[i]).toBeGreaterThan(hours[i - 1]);
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

    const pref = await prisma.userPreference.findFirst({ where: { userId: 'default' } });
    expect(pref!.responseStyle).toBe('concise');
  });

  it('medium messages → balanced', async () => {
    const messages = Array(10).fill({ content: 'A'.repeat(100), createdAt: new Date().toISOString() });
    await observer.updateResponseStyle(messages);

    const pref = await prisma.userPreference.findFirst({ where: { userId: 'default' } });
    expect(pref!.responseStyle).toBe('balanced');
  });

  it('long messages → detailed', async () => {
    const messages = Array(10).fill({ content: 'A'.repeat(300), createdAt: new Date().toISOString() });
    await observer.updateResponseStyle(messages);

    const pref = await prisma.userPreference.findFirst({ where: { userId: 'default' } });
    expect(pref!.responseStyle).toBe('detailed');
  });

  it('sets avgMessageLength', async () => {
    const messages = Array(10).fill({ content: 'A'.repeat(100), createdAt: new Date().toISOString() });
    await observer.updateResponseStyle(messages);

    const pref = await prisma.userPreference.findFirst({ where: { userId: 'default' } });
    expect(pref!.avgMessageLength).toBe(100);
  });
});

// ════════════════════════════════════════════
// updateAutoApproveThreshold
// ════════════════════════════════════════════

describe('PreferenceObserver.updateAutoApproveThreshold', () => {
  it('skips if total < 5', async () => {
    await observer.updateAutoApproveThreshold(2, 1); // 3 < 5
    // no error, no update
  });

  it('high confirmation rate (>0.8) → threshold 0.5', async () => {
    await observer.updateAutoApproveThreshold(18, 2); // rate=0.9
    const pref = await prisma.userPreference.findFirst({ where: { userId: 'default' } });
    expect(pref!.autoApproveThreshold).toBe(0.5);
  });

  it('medium rate (>0.5) → threshold 0.7', async () => {
    await observer.updateAutoApproveThreshold(7, 3); // rate=0.7
    const pref = await prisma.userPreference.findFirst({ where: { userId: 'default' } });
    expect(pref!.autoApproveThreshold).toBe(0.7);
  });

  it('low rate (<=0.5) → threshold 0.85', async () => {
    await observer.updateAutoApproveThreshold(3, 7); // rate=0.3
    const pref = await prisma.userPreference.findFirst({ where: { userId: 'default' } });
    expect(pref!.autoApproveThreshold).toBe(0.85);
  });
});

// ════════════════════════════════════════════
// getPreferences
// ════════════════════════════════════════════

describe('PreferenceObserver.getPreferences', () => {
  it('returns null if no preference exists', async () => {
    // 清理
    await prisma.userPreference.deleteMany({ where: { userId: 'default' } });
    const result = await observer.getPreferences();
    expect(result).toBeNull();
  });

  it('returns null if confidence < 0.3', async () => {
    await prisma.userPreference.create({
      data: { userId: 'default', confidence: 0.2 },
    });
    const result = await observer.getPreferences();
    expect(result).toBeNull();
    await prisma.userPreference.deleteMany({ where: { userId: 'default' } });
  });

  it('returns parsed preferences when confidence >= 0.3', async () => {
    await prisma.userPreference.create({
      data: {
        userId: 'default',
        confidence: 0.35,
        preferredModel: 'premium',
        modelUsageRatio: '{"premium":0.7}',
        responseStyle: 'concise',
        activeHours: '[9,10,14]',
        favoriteTools: '[{"name":"read","count":5}]',
        autoApproveThreshold: 0.7,
      },
    });

    const result = await observer.getPreferences();
    expect(result).not.toBeNull();
    expect(result!.preferredModel).toBe('premium');
    expect(result!.responseStyle).toBe('concise');
    expect(result!.activeHours).toEqual([9, 10, 14]);
    expect(result!.confidence).toBe(0.35);
    await prisma.userPreference.deleteMany({ where: { userId: 'default' } });
  });
});

// ════════════════════════════════════════════
// formatForPrompt
// ════════════════════════════════════════════

describe('PreferenceObserver.formatForPrompt', () => {
  it('returns empty string when no preferences', async () => {
    await prisma.userPreference.deleteMany({ where: { userId: 'default' } });
    const result = await observer.formatForPrompt();
    expect(result).toBe('');
  });

  it('formats responseStyle, preferredModel, activeHours', async () => {
    await prisma.userPreference.create({
      data: {
        userId: 'default',
        confidence: 0.5,
        preferredModel: 'premium',
        modelUsageRatio: '{}',
        responseStyle: 'concise',
        activeHours: '[9,14,22]',
        favoriteTools: '[]',
      },
    });

    const result = await observer.formatForPrompt();
    expect(result).toContain('用户偏好');
    expect(result).toContain('concise');
    expect(result).toContain('premium');
    expect(result).toContain('9,14,22');
    await prisma.userPreference.deleteMany({ where: { userId: 'default' } });
  });
});

// ════════════════════════════════════════════
// computeConfidence — EMA 递增验证
// ════════════════════════════════════════════

describe('computeConfidence (EMA)', () => {
  it('confidence increases monotonically with EMA alpha=0.15', async () => {
    // 创建低 confidence 记录
    await prisma.userPreference.create({
      data: { userId: 'default', confidence: 0.3 },
    });

    const confidences: number[] = [];
    for (let i = 0; i < 5; i++) {
      await observer.updateFromToolTrace({ tool: `t${i}`, success: true, durationMs: 10, timestamp: Date.now() });
      const pref = await prisma.userPreference.findFirst({ where: { userId: 'default' } });
      confidences.push(pref!.confidence);
    }

    // 每次递增
    for (let i = 1; i < confidences.length; i++) {
      expect(confidences[i]).toBeGreaterThan(confidences[i - 1]);
    }

    // EMA: next = current + (1-current)*0.15
    // 0.3 → 0.405 → 0.494 → 0.57 → 0.635 → 0.689
    expect(confidences[4]).toBeGreaterThan(0.6);
    expect(confidences[4]).toBeLessThan(0.8);

    await prisma.userPreference.deleteMany({ where: { userId: 'default' } });
  });
});
