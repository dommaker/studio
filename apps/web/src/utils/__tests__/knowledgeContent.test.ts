// #435 B7：统一视图内容消化——JSON 结构化键值 / 其余按文本；徽标色映射 chart 类别色
import { describe, it, expect } from 'vitest';
import { digestContent, CONSUMPTION_MODE_CHART } from '../knowledgeContent';

describe('digestContent', () => {
  it('JSON 对象原文 → 键值字段，字符串值直出', () => {
    const d = digestContent('{"responseStyle":"简洁","preferredModel":"k2"}');
    expect(d).toEqual({
      kind: 'json',
      fields: [
        { key: 'responseStyle', value: '简洁' },
        { key: 'preferredModel', value: 'k2' },
      ],
    });
  });

  it('JSON 对象嵌套值 → 紧凑 JSON 串', () => {
    const d = digestContent('{"activeHours":[9,10],"threshold":0.8}');
    expect(d).toEqual({
      kind: 'json',
      fields: [
        { key: 'activeHours', value: '[9,10]' },
        { key: 'threshold', value: '0.8' },
      ],
    });
  });

  it('普通文本（Monitor 告警原文）→ text 原文', () => {
    const d = digestContent('Agent X 连续 3 次执行失败');
    expect(d).toEqual({ kind: 'text', text: 'Agent X 连续 3 次执行失败' });
  });

  it('JSON 数组 / 标量 → 按文本处理', () => {
    expect(digestContent('[1,2,3]')).toEqual({ kind: 'text', text: '[1,2,3]' });
    expect(digestContent('123')).toEqual({ kind: 'text', text: '123' });
  });

  it('空 / undefined → 空文本', () => {
    expect(digestContent(undefined)).toEqual({ kind: 'text', text: '' });
    expect(digestContent('  ')).toEqual({ kind: 'text', text: '' });
  });

  it('空 JSON 对象 → 按文本处理（无字段可展示）', () => {
    expect(digestContent('{}')).toEqual({ kind: 'text', text: '{}' });
  });
});

describe('CONSUMPTION_MODE_CHART（§6.5：类别不占状态色）', () => {
  it('rule / signal / context 映射 chart 类别色序号', () => {
    expect(CONSUMPTION_MODE_CHART.rule).toBe(2);
    expect(CONSUMPTION_MODE_CHART.signal).toBe(7);
    expect(CONSUMPTION_MODE_CHART.context).toBe(1);
  });

  it('reference / 未知 → 无映射（走中性色）', () => {
    expect(CONSUMPTION_MODE_CHART.reference).toBeUndefined();
    expect(CONSUMPTION_MODE_CHART.whatever).toBeUndefined();
  });
});
