// wu-display 词表契约（#358）：7 份散装拷贝收口后的唯一正本——表内容即渲染契约，改动需走行为对齐决策
import { describe, expect, it } from 'vitest';
import {
  WU_STATUS_LABELS,
  WU_STATUS_COLORS,
  WU_TYPE_LABELS,
  LIBRARY_DOC_STATUS_LABELS,
  LIBRARY_DOC_STATUS_COLORS,
} from '../wu-display';

describe('WU_STATUS_LABELS', () => {
  it('七列看板状态 + failed/completed 原始状态全覆盖（ProjectActivity 超集口径）', () => {
    expect(WU_STATUS_LABELS).toEqual({
      pending: '待确认',
      unassigned: '待分配',
      active: '执行中',
      in_review: '审查中',
      done: '已完成',
      closed: '已关闭',
      blocked: '阻塞',
      failed: '失败',
      completed: '已完成',
    });
  });
});

describe('WU_STATUS_COLORS', () => {
  it('七列 chip 配色（u-* 工具类，定义在 apps/web 样式层）', () => {
    expect(WU_STATUS_COLORS).toEqual({
      pending: 'u-warn-dim u-warn',
      unassigned: 'u-surface-2 u-text-3',
      active: 'u-accent-dim u-accent',
      in_review: 'u-warn-dim u-warn',
      done: 'u-ok-dim u-ok',
      closed: 'u-ok-dim u-ok',
      blocked: 'u-err-dim u-err',
    });
  });
});

describe('WU_TYPE_LABELS', () => {
  it('WU 类型文案', () => {
    expect(WU_TYPE_LABELS).toEqual({
      task: '任务',
      monitor: '监控',
      analysis: '分析',
      discussion: '讨论',
    });
  });
});

describe('LIBRARY_DOC_STATUS_*', () => {
  it('阅览室文档状态文案与配色（LibraryPage/LibraryDocPage 同源）', () => {
    expect(LIBRARY_DOC_STATUS_LABELS).toEqual({
      draft: '草稿',
      confirmed: '已确认',
      done: '已完成',
      stale: '已过期',
    });
    expect(LIBRARY_DOC_STATUS_COLORS).toEqual({
      draft: 'u-warn-dim',
      confirmed: 'u-ok-dim',
      done: 'u-surface-2 u-text-3',
      stale: 'u-surface-2 u-text-3',
    });
  });
});

describe('web 入口透出', () => {
  it('@dommaker/studio-shared/web 可导入词表', async () => {
    const web = await import('../web');
    expect(web.WU_STATUS_LABELS).toBe(WU_STATUS_LABELS);
    expect(web.WU_STATUS_COLORS).toBe(WU_STATUS_COLORS);
    expect(web.WU_TYPE_LABELS).toBe(WU_TYPE_LABELS);
    expect(web.LIBRARY_DOC_STATUS_LABELS).toBe(LIBRARY_DOC_STATUS_LABELS);
    expect(web.LIBRARY_DOC_STATUS_COLORS).toBe(LIBRARY_DOC_STATUS_COLORS);
  });
});
