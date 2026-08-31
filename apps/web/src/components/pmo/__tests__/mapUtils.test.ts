// #114 T8：地图区纯函数测试 — 徽章口径 / 下一个该干什么排序 / 依赖图拼装
import { describe, it, expect } from 'vitest';
import {
  resolveFogBadge,
  pickNextAction,
  toNextActionCandidate,
  parseBlockedBy,
  buildMapOpeningPrefill,
  buildTaskDepRows,
  FOG_BADGE_META,
} from '../mapUtils';

describe('resolveFogBadge：待决问题徽章四态', () => {
  it('fog resolved → 已定（决策单状态不再影响）', () => {
    expect(resolveFogBadge({ status: 'resolved', wuId: 'wu-1' }, 'done')).toBe('resolved');
    expect(resolveFogBadge({ status: 'resolved', wuId: 'wu-1' }, 'in_review')).toBe('resolved');
    expect(FOG_BADGE_META.resolved.label).toBe('已定');
  });

  it('决策单在审（in_review）且 fog 未 resolved → 待确认', () => {
    expect(resolveFogBadge({ status: 'open', wuId: 'wu-1' }, 'in_review')).toBe('confirming');
    expect(FOG_BADGE_META.confirming.label).toBe('待确认');
  });

  it('fog in-discussion 或决策单已被认领（active/waitingForInput）→ 讨论中', () => {
    expect(resolveFogBadge({ status: 'in-discussion', wuId: 'wu-1' }, 'active')).toBe('discussing');
    expect(resolveFogBadge({ status: 'open', wuId: 'wu-1' }, 'active')).toBe('discussing');
    expect(resolveFogBadge({ status: 'open', wuId: 'wu-1' }, 'waitingForInput')).toBe('discussing');
    expect(FOG_BADGE_META.discussing.label).toBe('讨论中');
  });

  it('未建单（wuId=null）或单未认领 → 待认领', () => {
    expect(resolveFogBadge({ status: 'open', wuId: null }, undefined)).toBe('claimable');
    expect(resolveFogBadge({ status: 'open', wuId: 'wu-1' }, 'unassigned')).toBe('claimable');
    // WU 详情拉取失败（wuStatus undefined）但已建单 → 待认领兜底
    expect(resolveFogBadge({ status: 'open', wuId: 'wu-1' }, undefined)).toBe('claimable');
    expect(FOG_BADGE_META.claimable.label).toBe('待认领');
  });
});

describe('pickNextAction：下一个该干什么排序细则', () => {
  const t = (id: string, daysAgo: number) => ({
    id,
    title: `任务 ${id}`,
    createdAt: new Date(Date.now() - daysAgo * 86400000).toISOString(),
  });

  it('空候选 → null', () => {
    expect(pickNextAction([], ['fog-1'])).toBeNull();
  });

  it('无决策单 → 创建时间最早的', () => {
    const a = { ...t('wu-a', 1), type: 'task' };
    const b = { ...t('wu-b', 3), type: 'task' };
    expect(pickNextAction([a, b], [])?.id).toBe('wu-b');
  });

  it('决策单优先于任务单，按地图 fog 顺序（不看创建时间）', () => {
    const task = { ...t('wu-task', 9), type: 'task' };
    const d1 = { ...t('wu-d1', 1), type: 'decision', fogId: 'fog-1' };
    const d2 = { ...t('wu-d2', 5), type: 'decision', fogId: 'fog-2' };
    // d1 创建更晚，但 fog-1 在地图里排前面 → d1 先
    expect(pickNextAction([task, d2, d1], ['fog-1', 'fog-2'])?.id).toBe('wu-d1');
    expect(pickNextAction([task, d2, d1], ['fog-2', 'fog-1'])?.id).toBe('wu-d2');
  });

  it('决策单 fogId 不在地图顺序里 → 排末尾按创建时间兜底', () => {
    const d1 = { ...t('wu-d1', 1), type: 'decision', fogId: 'fog-1' };
    const dx = { ...t('wu-dx', 8), type: 'decision', fogId: 'fog-ghost' };
    expect(pickNextAction([dx, d1], ['fog-1'])?.id).toBe('wu-d1');
  });
});

describe('toNextActionCandidate：列表行 → 下一个该干什么候选', () => {
  it('claimable=true 且 pmoId 属本 PMO → 候选（标题取 metadata.title，带 fogId）', () => {
    const wu = {
      id: 'wu-1',
      type: 'decision',
      scope: '待决问题 PMO-1: 存储选型？',
      createdAt: '2026-08-01T00:00:00Z',
      metadata: JSON.stringify({ pmoId: 'p1', fogId: 'fog-1', title: '存储选型？' }),
      claimable: true,
    };
    expect(toNextActionCandidate(wu, 'p1')).toEqual({
      id: 'wu-1', title: '存储选型？', type: 'decision', createdAt: '2026-08-01T00:00:00Z', fogId: 'fog-1',
    });
  });

  it('claimable 非 true / pmoId 不匹配 / 坏 metadata → null', () => {
    const base = { id: 'wu-1', scope: 'x', metadata: JSON.stringify({ pmoId: 'p1' }) };
    expect(toNextActionCandidate({ ...base, claimable: false }, 'p1')).toBeNull();
    expect(toNextActionCandidate({ ...base, claimable: true }, 'p2')).toBeNull();
    expect(toNextActionCandidate({ ...base, claimable: true, metadata: 'oops' }, 'p1')).toBeNull();
    expect(toNextActionCandidate({ ...base, claimable: true, metadata: null }, 'p1')).toBeNull();
  });

  it('metadata 无 title → 回退 scope 首行', () => {
    const wu = {
      id: 'wu-2', scope: '实现登录\n第二行', claimable: true,
      metadata: JSON.stringify({ pmoId: 'p1' }),
    };
    expect(toNextActionCandidate(wu, 'p1')?.title).toBe('实现登录');
  });
});

describe('parseBlockedBy：metadata 依赖解析', () => {
  it('正常解析字符串数组；缺失/坏 JSON/非数组 → []', () => {
    expect(parseBlockedBy(JSON.stringify({ blockedBy: ['wu-1', 'wu-2'] }))).toEqual(['wu-1', 'wu-2']);
    expect(parseBlockedBy(null)).toEqual([]);
    expect(parseBlockedBy('not-json')).toEqual([]);
    expect(parseBlockedBy(JSON.stringify({ blockedBy: 'wu-1' }))).toEqual([]);
    expect(parseBlockedBy(JSON.stringify({ other: 1 }))).toEqual([]);
    expect(parseBlockedBy(JSON.stringify({ blockedBy: ['wu-1', 42, ''] }))).toEqual(['wu-1']);
  });
});

describe('buildMapOpeningPrefill：analysis 确认弹窗清单预填（#106 M7；#401 起中文别名键）', () => {
  it('analysisDestination + analysisFog → 目标：/待决： 逐行还原', () => {
    const metadata = JSON.stringify({
      analysisDestination: '三仓特性联动上线',
      analysisFog: ['存储选型用哪个？', '部署形态先单机还是分布式？'],
    });
    expect(buildMapOpeningPrefill(metadata)).toBe(
      '目标：三仓特性联动上线\n待决：存储选型用哪个？\n待决：部署形态先单机还是分布式？',
    );
  });

  it('只有 analysisFog → 无目标行；空白项剔除', () => {
    const metadata = JSON.stringify({ analysisFog: ['队列方案？', '  ', 42] });
    expect(buildMapOpeningPrefill(metadata)).toBe('待决：队列方案？');
  });

  it('无清单 / 坏 JSON / null → 空串（非探路型，弹窗空手填）', () => {
    expect(buildMapOpeningPrefill(null)).toBe('');
    expect(buildMapOpeningPrefill('not-json')).toBe('');
    expect(buildMapOpeningPrefill(JSON.stringify({ analysisTasks: ['x'] }))).toBe('');
  });
});

describe('buildTaskDepRows：任务单依赖图', () => {
  it('只收有依赖的单；依赖对象能解析出标题/状态', () => {
    const wus = [
      { id: 'wu-1', title: '搭框架', status: 'done', metadata: null },
      {
        id: 'wu-2', title: '写逻辑', status: 'unassigned',
        metadata: JSON.stringify({ blockedBy: ['wu-1'] }),
      },
      { id: 'wu-3', title: '独立任务', status: 'active', metadata: null },
    ];
    const rows = buildTaskDepRows(wus);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      id: 'wu-2',
      title: '写逻辑',
      status: 'unassigned',
      deps: [{ id: 'wu-1', title: '搭框架', status: 'done' }],
    });
  });

  it('依赖对象不在本批 WU 里（跨 PMO/已删）→ title/status null 防御', () => {
    const rows = buildTaskDepRows([
      {
        id: 'wu-9', title: '跨项目任务', status: 'blocked',
        metadata: JSON.stringify({ blockedBy: ['wu-other'] }),
      },
    ]);
    expect(rows[0].deps).toEqual([{ id: 'wu-other', title: null, status: null }]);
  });

  it('全部无依赖 → 空数组（页面空态）', () => {
    expect(buildTaskDepRows([{ id: 'wu-1', title: 'a', status: 'done', metadata: null }])).toEqual([]);
  });
});
