/**
 * system-tokens-smoke tests — 冒烟脚本判定逻辑（#370）
 *
 * 脚本本体手动运行（isMain 守卫，import 本文件不触发真实 LLM 调用），
 * 这里只测 findSmokeEvent 纯函数：防并发追加错位认领、防历史残留假 PASS、
 * 防 payload 字段缺失漏检。
 */
import { describe, it, expect } from 'vitest';
import { findSmokeEvent, SMOKE_EVENT_SOURCE } from '../system-tokens-smoke.js';

const NOW_MS = Date.parse('2026-08-27T12:00:00.000Z');

function smokeLine(opts: {
  createdAt?: string;
  source?: string;
  payload?: Record<string, unknown>;
  omitField?: string;
} = {}): string {
  const fullPayload: Record<string, unknown> = {
    provider: 'claude',
    inputTokens: 100,
    outputTokens: 50,
    durationMs: 7058,
    promptSignature: 'ac74a81e',
    ...opts.payload,
  };
  if (opts.omitField) delete fullPayload[opts.omitField];
  return JSON.stringify({
    type: 'system:tokens',
    source: opts.source ?? SMOKE_EVENT_SOURCE,
    payload: JSON.stringify(fullPayload),
    createdAt: opts.createdAt ?? '2026-08-27T12:00:03.000Z',
  });
}

describe('findSmokeEvent', () => {
  it('冒烟后新增的合法事件命中，返回原行', () => {
    const line = smokeLine();
    const found = findSmokeEvent([], [line], NOW_MS);
    expect(found).toEqual({ ok: true, line });
  });

  it('并发追加的他源 system:tokens 行不认领，双标记行才命中', () => {
    const foreignTokenLine = smokeLine({ source: 'knowledge-distill' });
    const mine = smokeLine();
    const found = findSmokeEvent([], [foreignTokenLine, mine], NOW_MS);
    expect(found).toEqual({ ok: true, line: mine });
  });

  it('历史残留的双标记旧事件不假 PASS（createdAt 早于时间窗）', () => {
    const stale = smokeLine({ createdAt: '2026-08-26T00:00:00.000Z' });
    const found = findSmokeEvent([], [stale], NOW_MS);
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.reason).toContain('time window');
  });

  it('before 已存在的相同行不计入新增（重复运行不认旧账）', () => {
    const existing = smokeLine();
    const found = findSmokeEvent([existing], [existing], NOW_MS);
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.reason).toContain('no smoke-370');
  });

  it('payload 缺必需字段时报 FAIL 并指出缺失', () => {
    const line = smokeLine({ omitField: 'promptSignature' });
    const found = findSmokeEvent([], [line], NOW_MS);
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.reason).toContain('promptSignature');
  });
});
