// 引导文案模板注册表测试（#443 / spec #441）：
// 文案快照锁定模板渲染输出（人话要求成为可 review 的 diff）；
// 带工单上下文（标题）；无内部术语（禁用词表断言）；未知模板 id → null（fail-closed 不渲染）。
import { describe, it, expect } from 'vitest';
import { renderSuggestionCopy } from '../suggestionCopy';
import type { ChannelSuggestion } from '../../api/channel';

/** 内部术语禁用词表：引导文案说人话（spec 用户故事 9），出现即 fail */
const JARGON = /Invariant|契约锁定|断链|派单|对账|心跳|租约|宽限|fail-closed|派生列|l3|L3/;

describe('renderSuggestionCopy（文案模板机制）', () => {
  it('auto-review-in-flight：快照锁定 + 带工单标题上下文 + 说清「无需操作」', () => {
    const copy = renderSuggestionCopy({
      id: 'auto-review-in-flight',
      kind: 'status',
      params: { wuId: 'WU-1', wuTitle: '登录功能' },
    });
    expect(copy).not.toBeNull();
    expect(copy!.label).toContain('登录功能');
    expect(copy).toMatchSnapshot();
  });

  it('全部已注册模板输出均无内部术语', () => {
    const samples: ChannelSuggestion[] = [
      { id: 'auto-review-in-flight', kind: 'status', params: { wuId: 'WU-1', wuTitle: '登录功能' } },
    ];
    for (const s of samples) {
      const copy = renderSuggestionCopy(s);
      expect(copy, `模板 ${s.id} 应已注册`).not.toBeNull();
      expect(copy!.label).not.toMatch(JARGON);
      if (copy!.hint) expect(copy!.hint).not.toMatch(JARGON);
    }
  });

  it('未知模板 id → null（fail-closed：后端给了前端不认识的建议，不渲染也不编造）', () => {
    expect(renderSuggestionCopy({ id: 'nope', kind: 'status', params: {} })).toBeNull();
  });
});
