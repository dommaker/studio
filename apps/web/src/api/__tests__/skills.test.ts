// Contract test: Skills API client — #278（决策 #250 D2）retract_confirm 卡退役决策
import { describe, it, expect, vi } from 'vitest';

vi.mock('../index', () => ({
  api: { post: vi.fn().mockResolvedValue({ data: {} }), get: vi.fn().mockResolvedValue({ data: {} }) },
}));

import { skillsApi } from '../skills';
import { api } from '../index';

describe('skillsApi', () => {
  it('retractDecide 带 messageId → POST /skills/:id/retract/decide {decision, messageId}', async () => {
    await skillsApi.retractDecide('skill-1', 'confirm', 'msg-1');
    expect(api.post).toHaveBeenCalledWith('/skills/skill-1/retract/decide', { decision: 'confirm', messageId: 'msg-1' });
  });

  it('retractDecide 无 messageId → body 不含 messageId 字段', async () => {
    await skillsApi.retractDecide('skill-1', 'reject');
    expect(api.post).toHaveBeenCalledWith('/skills/skill-1/retract/decide', { decision: 'reject' });
  });
});
