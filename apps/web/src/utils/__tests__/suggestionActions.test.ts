// 动作片 → 确定性接口注册表测试（#444 / spec #441）。
// 契约断言：redispatch-review 的点击效果 = POST /workunits/:id/dispatch-review
// ——与 ReviewDispatcher 自动派发同一原语（dispatchReviewNow）的服务端入口；
// 不经 @mention 消息路由、不新建普通工单。fail-closed：未注册 id → null。
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockApiPost } = vi.hoisted(() => ({ mockApiPost: vi.fn() }));
vi.mock('../../api', () => ({ api: { get: vi.fn(), post: mockApiPost } }));

import { getSuggestionAction } from '../suggestionActions';

describe('suggestionActions（动作片 → 确定性接口注册表）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('redispatch-review → 直调 POST /workunits/:id/dispatch-review（与自动派发同原语端点）', async () => {
    mockApiPost.mockResolvedValue({ data: { data: { reviewWorkUnitId: 'WU-2' } } });
    const def = getSuggestionAction('redispatch-review');
    expect(def).not.toBeNull();
    await def!.run('WU-1');
    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(mockApiPost).toHaveBeenCalledWith('/workunits/WU-1/dispatch-review');
  });

  it('确认文案带工单上下文、说清会发生什么（不新建普通工单、不在频道发消息）', () => {
    const def = getSuggestionAction('redispatch-review')!;
    const msg = def.confirmMessage('登录功能');
    expect(msg).toContain('登录功能');
    expect(msg).toMatch(/审查/);
  });

  it('claim-wu → 直调 POST /workunits/:id/claim（认领即发声端点，与 loop 自动认领同原语路径；认领人由服务端按会话用户解析，前端不带身份）', async () => {
    mockApiPost.mockResolvedValue({ data: {} });
    const def = getSuggestionAction('claim-wu');
    expect(def).not.toBeNull();
    await def!.run('WU-1');
    expect(mockApiPost).toHaveBeenCalledTimes(1);
    expect(mockApiPost).toHaveBeenCalledWith('/workunits/WU-1/claim', {});
  });

  it('claim-wu 确认文案带工单上下文、说清会发生什么（认领到名下 + 频道发认领说明）', () => {
    const def = getSuggestionAction('claim-wu')!;
    const msg = def.confirmMessage('登录功能');
    expect(msg).toContain('登录功能');
    expect(msg).toMatch(/认领/);
    expect(msg).toMatch(/频道/);
  });

  it('未知动作 id → null（fail-closed：后端给了前端不认识的动作，不执行也不编造）', () => {
    expect(getSuggestionAction('nope')).toBeNull();
  });
});
