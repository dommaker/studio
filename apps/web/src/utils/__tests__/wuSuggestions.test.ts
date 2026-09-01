// wuSuggestions（#440 Phase 1）— 建议 prompt 片静态映射 + 频道当前 WU 拣选
import { describe, it, expect } from 'vitest';
import { suggestionsForWu, pickCurrentWu } from '../wuSuggestions';
import type { WorkUnit } from '../../api/workunit';

const wu = (over: Partial<WorkUnit>): WorkUnit => ({
  id: 'WU-1', parentId: null, dependsOn: '', type: 'task', scope: 's',
  assigneeId: null, status: 'active', failureType: null, retryCount: 0,
  timeoutAt: null, channelId: 'ch-1', metadata: null,
  createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
  claimedAt: null, completedAt: null,
  ...over,
});

describe('suggestionsForWu — 按展示列静态映射（MVP，后端推导另开票）', () => {
  it('in_review → 可选的审查建议：标注「可选」+ 说明点击后果，预填文本不变（#442 止血）', () => {
    const list = suggestionsForWu('in_review', {});
    expect(list).toHaveLength(1);
    const s = list[0];
    // 预填文本（发给 agent 的指令本体）不被展示文案污染
    expect(s.text).toBe('@reviewer 把 AC 转写成审查清单');
    // 展示文案标注「可选」——语义 = 前置门禁场景的人工介入，而非"下一步该做的事"
    expect(s.label).toContain('可选');
    expect(s.label).toContain(s.text);
    // hint 说清点了会发生什么（预填进输入框、可改再发），且无内部术语
    expect(s.hint).toBeTruthy();
    expect(s.hint).toContain('预填');
  });

  it('in_review + 已有活跃 review 子工单 → 不出片（自动评审在途，防重复派单）', () => {
    expect(suggestionsForWu('in_review', { hasActiveReview: true })).toEqual([]);
  });

  it('unassigned → 认领建议（@developer）', () => {
    const list = suggestionsForWu('unassigned', {});
    expect(list.some(s => s.text.includes('@developer'))).toBe(true);
  });

  it('active → 契约锁定建议', () => {
    const list = suggestionsForWu('active', {});
    expect(list.some(s => s.text.includes('契约'))).toBe(true);
  });

  it('blocked + waitingForInput → 空（NeedInputOptions 已覆盖该交互）', () => {
    expect(suggestionsForWu('blocked', { waitingForInput: true })).toEqual([]);
  });

  it('blocked 非挂起（失败）→ 诊断建议', () => {
    const list = suggestionsForWu('blocked', {});
    expect(list.some(s => s.text.includes('诊断'))).toBe(true);
  });

  it('pending / done / closed → 空（人闸与终态不给指令建议）', () => {
    expect(suggestionsForWu('pending', {})).toEqual([]);
    expect(suggestionsForWu('done', {})).toEqual([]);
    expect(suggestionsForWu('closed', {})).toEqual([]);
  });
});

describe('pickCurrentWu — 频道当前 WU 拣选（阶段条与建议片共用数据源）', () => {
  it('空列表 → null', () => {
    expect(pickCurrentWu([])).toBeNull();
  });

  it('优先拣非终态（done/closed 之外）中 updatedAt 最新者', () => {
    const list = [
      wu({ id: 'WU-old', status: 'active', updatedAt: '2026-09-01T01:00:00Z' }),
      wu({ id: 'WU-done', status: 'done', completedAt: '2026-09-01T03:00:00Z', updatedAt: '2026-09-01T03:00:00Z' }),
      wu({ id: 'WU-new', status: 'in_review', updatedAt: '2026-09-01T02:00:00Z' }),
    ];
    expect(pickCurrentWu(list)?.id).toBe('WU-new');
  });

  it('done 但证据缺 l3 → 派生列 in_review，仍算非终态（与 deriveDisplayState 口径一致）', () => {
    const metadata = JSON.stringify({
      attestations: { l1: { verdict: 'approved', by: 'a', at: '2026-09-01T01:00:00Z', kind: 'verify' } },
    });
    const list = [
      wu({ id: 'WU-legacy', status: 'done', metadata: null, updatedAt: '2026-09-01T03:00:00Z' }),
      wu({ id: 'WU-needs-l3', status: 'done', metadata, updatedAt: '2026-09-01T02:00:00Z' }),
    ];
    expect(pickCurrentWu(list)?.id).toBe('WU-needs-l3');
  });

  it('全部终态 → 回退 updatedAt 最新者', () => {
    const list = [
      wu({ id: 'WU-1', status: 'done', updatedAt: '2026-09-01T01:00:00Z' }),
      wu({ id: 'WU-2', status: 'closed', updatedAt: '2026-09-01T02:00:00Z' }),
    ];
    expect(pickCurrentWu(list)?.id).toBe('WU-2');
  });
});
