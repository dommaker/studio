// wu-metadata 契约测试：WorkUnitMetadata 访问器三件套（parseWuMetadata / clearSessionBookkeeping / mergedWuView）
// 覆盖：容错解析矩阵（null/undefined/空串/坏 JSON/非对象 JSON）、14 字段会话簿记清除
//       （含列表外字段存活、入参不可变、未知新簿记字段的闭合清单语义）、
//       合并视图语义（updates 覆盖、显式 undefined 清除 hint 的序列化口径）。
// 纯函数无 FileStore 依赖，直接单测。
import { describe, it, expect } from 'vitest';
import { parseWuMetadata, clearSessionBookkeeping, mergedWuView } from '../wu-metadata.js';
import type { WorkUnitMetadata } from '../workunit.service.js';

describe('parseWuMetadata 容错解析矩阵', () => {
  it('null / undefined / 空串 → {}', () => {
    expect(parseWuMetadata(null)).toEqual({});
    expect(parseWuMetadata(undefined)).toEqual({});
    expect(parseWuMetadata('')).toEqual({});
  });

  it('坏 JSON → {}（不抛异常）', () => {
    expect(parseWuMetadata('{bad json')).toEqual({});
    expect(parseWuMetadata('not-json-at-all')).toEqual({});
    expect(parseWuMetadata('{"a":1,')).toEqual({});
  });

  it('非对象 JSON（标量/数组/null 字面量）→ {}', () => {
    expect(parseWuMetadata('123')).toEqual({});
    expect(parseWuMetadata('"str"')).toEqual({});
    expect(parseWuMetadata('[1,2]')).toEqual({});
    expect(parseWuMetadata('null')).toEqual({});
  });

  it('合法 JSON → 解析结果（含 schema 字段与扩展字段）', () => {
    const meta = parseWuMetadata('{"sessionId":"s-1","stepCount":3,"customKey":{"nested":true}}');
    expect(meta.sessionId).toBe('s-1');
    expect(meta.stepCount).toBe(3);
    expect(meta.customKey).toEqual({ nested: true });
  });
});

describe('clearSessionBookkeeping 14 字段权威清单', () => {
  const BOOKKEEPING: Record<string, unknown> = {
    sessionId: 'sess-1',
    startedAt: '2026-08-01T00:00:00Z',
    sessionResumes: 2,
    sessionCount: 1,
    lastSessionResumed: true,
    blockReason: '连续失败',
    stepCount: 7,
    consecutiveStuck: 3,
    errorType: 'execution_failed',
    errorDetail: 'boom',
    errorAt: '2026-08-01T01:00:00Z',
    _cumulativeTokens: 42000,
    lastInputTokens: 1234,
    progressLog: [{ step: 1, action: 'progress', summary: '完成数据层', at: '2026-08-12T10:00:00Z' }],
  };

  it('14 个簿记字段全部清除', () => {
    const cleaned = clearSessionBookkeeping({ ...BOOKKEEPING });
    for (const key of Object.keys(BOOKKEEPING)) {
      expect(cleaned[key], `字段 ${key} 应被清除`).toBeUndefined();
    }
  });

  it('列表外字段原样存活（域血缘/worktree/collab/评审契约）', () => {
    const cleaned = clearSessionBookkeeping({
      ...BOOKKEEPING,
      pmoId: 'pmo-1',
      worktreePath: '/tmp/wt',
      collab: { rootId: 'wu-1', depth: 1, chain: ['p1'], delegationCount: 0 },
      reviewInput: { mode: 'diff-only', skill: 'code-review' },
      title: '评审任务',
    });
    expect(cleaned.pmoId).toBe('pmo-1');
    expect(cleaned.worktreePath).toBe('/tmp/wt');
    expect(cleaned.collab).toEqual({ rootId: 'wu-1', depth: 1, chain: ['p1'], delegationCount: 0 });
    expect(cleaned.reviewInput).toEqual({ mode: 'diff-only', skill: 'code-review' });
    expect(cleaned.title).toBe('评审任务');
  });

  it('不改入参（返回浅拷贝，同 review-dispatcher 原 delete 副本语义）', () => {
    const input: WorkUnitMetadata = { sessionId: 'sess-1', pmoId: 'pmo-1' };
    const cleaned = clearSessionBookkeeping(input);
    expect(input.sessionId).toBe('sess-1');
    expect(cleaned.sessionId).toBeUndefined();
    expect(cleaned).not.toBe(input);
  });

  it('闭合清单语义：未知的新簿记味字段不在清单内 → 保留（新增簿记字段必须同步入清单）', () => {
    const cleaned = clearSessionBookkeeping({ futureBookkeepingField: 1 });
    expect(cleaned.futureBookkeepingField).toBe(1);
  });
});

describe('mergedWuView 合并视图', () => {
  it('持久化 + updates 合并，updates 覆盖同名字段', () => {
    const merged = mergedWuView('{"worktreePath":"/wt","stepCount":3}', { stepCount: 4, sessionId: 's-9' });
    expect(merged.worktreePath).toBe('/wt');
    expect(merged.stepCount).toBe(4);
    expect(merged.sessionId).toBe('s-9');
  });

  it('持久化为 null/坏 JSON → 仅 updates（容错）', () => {
    expect(mergedWuView(null, { stepCount: 1 })).toEqual({ stepCount: 1 });
    expect(mergedWuView('{bad', { stepCount: 1 })).toEqual({ stepCount: 1 });
  });

  it('updates 显式 undefined 覆盖持久化值 → 序列化后键消失（agent-loop hint 清除口径）', () => {
    const merged = mergedWuView('{"commitGuardHint":"先提交","stepCount":2}', { commitGuardHint: undefined });
    // 合并视图中键被 undefined 覆盖（读侧 typeof 检查不再命中）
    expect(merged.commitGuardHint).toBeUndefined();
    expect(merged.stepCount).toBe(2);
    // 落库经 JSON.stringify：undefined 值键被丢弃 → 持久化后即清除
    const persisted = JSON.parse(JSON.stringify(merged)) as WorkUnitMetadata;
    expect('commitGuardHint' in persisted).toBe(false);
    expect(persisted.stepCount).toBe(2);
  });

  it('不改持久化串与 updates 入参', () => {
    const updates: Partial<WorkUnitMetadata> = { stepCount: 5 };
    const merged = mergedWuView('{"stepCount":4}', updates);
    expect(updates.stepCount).toBe(5);
    expect(merged.stepCount).toBe(5);
    expect(merged).not.toBe(updates);
  });
});
