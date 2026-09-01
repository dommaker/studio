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

  it('未知动作 id → null（fail-closed：后端给了前端不认识的动作，不执行也不编造）', () => {
    expect(getSuggestionAction('nope')).toBeNull();
  });
});
