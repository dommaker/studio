/**
 * R1 反馈环度量 — getFlywheelMetrics() 从 outcome 事件实算 hitRate / improvement。
 *
 * 使用 tmp fixture 事件文件（opts.eventsFile 注入），不 mock FileStore，
 * 验证从 recordOutcome() 事件形态（knowledge:outcome:success|failure）
 * 到指标的真实计算链路。
 */
import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { KnowledgeService } from '../knowledge-service.js';

// ── Mock factories (同 knowledge-service.test.ts 的最小形态) ──

function createKS(entries: any[] = []) {
  const store = {
    list: vi.fn(() => entries),
    get: vi.fn((id: string) => entries.find(e => e.id === id) || null),
    save: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
  const deps = {
    store: store as any,
    lifecycle: { recordReference: vi.fn() } as any,
    ingest: { ingestEntry: vi.fn() } as any,
    linter: { validateEntry: vi.fn(() => []) } as any,
    query: {} as any,
    eventEmitter: { emit: vi.fn() } as any,
  };
  return { ks: new KnowledgeService(deps), store };
}

// ── Fixture helpers（与 recordOutcome 写入形态一致）──

function outcomeLine(success: boolean, consumedKnowledge: string[], createdAt: Date): string {
  return JSON.stringify({
    type: `knowledge:outcome:${success ? 'success' : 'failure'}`,
    source: 'claude',
    payload: JSON.stringify({
      executionId: `exec-${Math.random().toString(36).slice(2, 8)}`,
      agentType: 'claude',
      success,
      consumedKnowledge,
      details: '',
    }),
    createdAt: createdAt.toISOString(),
  });
}

function withTmpEvents(lines: string[], fn: (eventsFile: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flywheel-metrics-'));
  const eventsFile = path.join(dir, 'studio-events.jsonl');
  fs.writeFileSync(eventsFile, lines.join('\n') + (lines.length > 0 ? '\n' : ''), 'utf-8');
  return fn(eventsFile).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

const DAYS = 24 * 3600 * 1000;

describe('KnowledgeService R1: getFlywheelMetrics from outcome events', () => {
  it('computes hitRate = tasks with ≥1 consumed knowledge / total tasks with outcomes', async () => {
    const now = Date.now();
    const lines = [
      outcomeLine(true, ['k-1'], new Date(now - 1 * 3600_000)),        // hit
      outcomeLine(false, [], new Date(now - 2 * 3600_000)),            // miss
      outcomeLine(true, ['k-2', 'k-3'], new Date(now - 3 * 3600_000)), // hit
      // 噪音：非 outcome 事件应被忽略
      JSON.stringify({ type: 'knowledge:consumption', source: 'prompt-inject', payload: '{}', createdAt: new Date(now - 3600_000).toISOString() }),
      // 窗口外（40 天前）应被忽略
      outcomeLine(true, ['k-old'], new Date(now - 40 * DAYS)),
    ];

    await withTmpEvents(lines, async (eventsFile) => {
      const { ks } = createKS([{ id: '1', maturity: 'proven', lastReferenced: new Date().toISOString() }]);
      const m = await ks.getFlywheelMetrics({ eventsFile });
      expect(m.hitRate).toBe(67); // 2/3，四舍五入
      expect(m.source).toBe('events');
      // quality/freshness 保持原有实算
      expect(m.quality).toBeGreaterThan(0);
      expect(m.freshness).toBe(100);
    });
  });

  it('computes improvement = second-half success rate − first-half success rate (percentage points)', async () => {
    const now = Date.now();
    const lines = [
      // 前半窗口（15–30 天前）：1/4 成功 = 25%
      outcomeLine(true, [], new Date(now - 20 * DAYS)),
      outcomeLine(false, [], new Date(now - 21 * DAYS)),
      outcomeLine(false, [], new Date(now - 22 * DAYS)),
      outcomeLine(false, [], new Date(now - 23 * DAYS)),
      // 后半窗口（0–15 天前）：3/3 成功 = 100%
      outcomeLine(true, [], new Date(now - 1 * DAYS)),
      outcomeLine(true, [], new Date(now - 2 * DAYS)),
      outcomeLine(true, [], new Date(now - 3 * DAYS)),
    ];

    await withTmpEvents(lines, async (eventsFile) => {
      const { ks } = createKS([]);
      const m = await ks.getFlywheelMetrics({ eventsFile });
      expect(m.improvement).toBe(75); // 100% − 25%
      expect(m.hitRate).toBe(0);      // 全部 consumed 为空 — 诚实的 0，有事件所以 source='events'
      expect(m.source).toBe('events');
    });
  });

  it('returns source=insufficient-data (not fabricated) when no outcome events exist', async () => {
    const lines = [
      JSON.stringify({ type: 'knowledge:consumption', source: 'prompt-inject', payload: '{}', createdAt: new Date().toISOString() }),
    ];

    await withTmpEvents(lines, async (eventsFile) => {
      const { ks } = createKS([{ id: '1', maturity: 'draft', lastReferenced: null }]);
      const m = await ks.getFlywheelMetrics({ eventsFile });
      expect(m.hitRate).toBe(0);
      expect(m.improvement).toBe(0);
      expect(m.source).toBe('insufficient-data');
    });
  });

  it('returns insufficient-data when events file does not exist', async () => {
    const { ks } = createKS([]);
    const m = await ks.getFlywheelMetrics({ eventsFile: path.join(os.tmpdir(), `no-such-file-${Date.now()}.jsonl`) });
    expect(m.hitRate).toBe(0);
    expect(m.improvement).toBe(0);
    expect(m.source).toBe('insufficient-data');
  });

  it('skips corrupt payload lines instead of fabricating consumed=0', async () => {
    const now = Date.now();
    const lines = [
      outcomeLine(true, ['k-1'], new Date(now - 3600_000)), // hit
      JSON.stringify({ type: 'knowledge:outcome:success', source: 'x', payload: '{broken json', createdAt: new Date(now - 3600_000).toISOString() }),
    ];

    await withTmpEvents(lines, async (eventsFile) => {
      const { ks } = createKS([]);
      const m = await ks.getFlywheelMetrics({ eventsFile });
      expect(m.hitRate).toBe(100); // 1/1 — 坏行被跳过而不是计为 miss
      expect(m.source).toBe('events');
    });
  });
});
