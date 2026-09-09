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

  // #444：动作片文案——说清点了会发生什么（spec 用户故事 5/6/9/10）
  it('redispatch-review：快照锁定 + 带工单上下文 + hint 说清点击后果', () => {
    const copy = renderSuggestionCopy({
      id: 'redispatch-review',
      kind: 'action',
      params: { wuId: 'WU-1', wuTitle: '登录功能' },
    });
    expect(copy).not.toBeNull();
    expect(copy!.label).toContain('登录功能');
    expect(copy!.hint).toMatch(/点击/); // 必须说清「点了会发生什么」
    expect(copy).toMatchSnapshot();
  });

  // #445：认领动作片文案——说清点了会发生什么（认领到名下 + 频道发说明）
  it('claim-wu：快照锁定 + 带工单上下文 + hint 说清点击后果', () => {
    const copy = renderSuggestionCopy({
      id: 'claim-wu',
      kind: 'action',
      params: { wuId: 'WU-1', wuTitle: '登录功能' },
    });
    expect(copy).not.toBeNull();
    expect(copy!.label).toContain('登录功能');
    expect(copy!.hint).toMatch(/点击/); // 必须说清「点了会发生什么」
    expect(copy).toMatchSnapshot();
  });

  // #446：prompt 形态——阻塞诊断片文案；hint 带阻塞原因上下文 + 说清点击后果（预填可编辑再发送）
  it('diagnose-blocked：快照锁定 + 带工单标题与阻塞原因上下文 + hint 说清点击后果', () => {
    const copy = renderSuggestionCopy({
      id: 'diagnose-blocked',
      kind: 'prompt',
      params: { wuId: 'WU-1', wuTitle: '登录功能', blockReason: '自动验证未通过（3 个用例）' },
      text: '@developer 诊断《登录功能》的阻塞原因并给出修复方案',
    });
    expect(copy).not.toBeNull();
    expect(copy!.label).toContain('登录功能');
    expect(copy!.hint).toContain('自动验证未通过');
    expect(copy!.hint).toMatch(/预填/); // 必须说清「点了会发生什么」
    expect(copy).toMatchSnapshot();
  });

  // #447 快照全量锁定：diagnose-blocked 无阻塞原因变体（hint 不带原因从句，不编造）
  it('diagnose-blocked（无 blockReason 变体）：快照锁定 + hint 不含原因从句', () => {
    const copy = renderSuggestionCopy({
      id: 'diagnose-blocked',
      kind: 'prompt',
      params: { wuId: 'WU-1', wuTitle: '登录功能' },
      text: '@developer 诊断《登录功能》的阻塞原因并给出修复方案',
    });
    expect(copy).not.toBeNull();
    expect(copy!.hint).not.toContain('（自动验证未通过');
    expect(copy).toMatchSnapshot();
  });

  // #446：prompt 形态——前置门禁窗口的可选介入；label 标注「可选」（spec 用户故事 7）
  it('transcribe-review-checklist：可选标注 + 快照锁定 + 带工单上下文 + hint 说清点击后果', () => {
    const copy = renderSuggestionCopy({
      id: 'transcribe-review-checklist',
      kind: 'prompt',
      params: { wuId: 'WU-1', wuTitle: '登录功能' },
      text: '@reviewer 把《登录功能》的验收标准转写成审查清单',
    });
    expect(copy).not.toBeNull();
    expect(copy!.label).toContain('可选');
    expect(copy!.label).toContain('登录功能');
    expect(copy!.hint).toMatch(/预填/);
    expect(copy).toMatchSnapshot();
  });

  it('全部已注册模板输出均无内部术语', () => {
    const samples: ChannelSuggestion[] = [
      { id: 'auto-review-in-flight', kind: 'status', params: { wuId: 'WU-1', wuTitle: '登录功能' } },
      { id: 'redispatch-review', kind: 'action', params: { wuId: 'WU-1', wuTitle: '登录功能' } },
      { id: 'claim-wu', kind: 'action', params: { wuId: 'WU-1', wuTitle: '登录功能' } },
      { id: 'diagnose-blocked', kind: 'prompt', params: { wuId: 'WU-1', wuTitle: '登录功能', blockReason: '自动验证未通过（3 个用例）' } },
      { id: 'transcribe-review-checklist', kind: 'prompt', params: { wuId: 'WU-1', wuTitle: '登录功能' } },
      { id: 'channel-no-members', kind: 'status', params: {} },
    ];
    for (const s of samples) {
      const copy = renderSuggestionCopy(s);
      expect(copy, `模板 ${s.id} 应已注册`).not.toBeNull();
      expect(copy!.label).not.toMatch(JARGON);
      if (copy!.hint) expect(copy!.hint).not.toMatch(JARGON);
    }
  });

  // #465：首用引导——空频道无成员只读提示（status 形态，无点击语义）；引导去 ⋯ 菜单加成员
  it('channel-no-members：快照锁定 + hint 指到成员管理入口', () => {
    const copy = renderSuggestionCopy({ id: 'channel-no-members', kind: 'status', params: {} });
    expect(copy).not.toBeNull();
    expect(copy!.hint).toContain('成员');
    expect(copy).toMatchSnapshot();
  });

  it('未知模板 id → null（fail-closed：后端给了前端不认识的建议，不渲染也不编造）', () => {
    expect(renderSuggestionCopy({ id: 'nope', kind: 'status', params: {} })).toBeNull();
  });
});
