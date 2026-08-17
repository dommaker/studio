/**
 * prompt-injection 路由层（A3：渲染收编进 harness renderConstraintsByTrigger）
 *
 * 行为钉：role → trigger 数组路由 + projectRoot 透传 + 未知 role 空串；
 * 渲染（生效集过滤/层级分组/文案）归 harness，本模块不再手写。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockRender } = vi.hoisted(() => ({
  mockRender: vi.fn().mockReturnValue(''),
}));

vi.mock('@dommaker/harness', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/harness')>();
  return { ...actual, renderConstraintsByTrigger: mockRender };
});

import { formatConstraintsForPrompt, ROLE_TRIGGERS } from '../prompt-injection';
import type { AgentRole } from '../prompt-injection';

describe('prompt-injection — role→trigger 路由层', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('executor 角色 → 以对应 trigger 集调用 renderer 并透传渲染结果', () => {
    mockRender.mockReturnValue('## 行为约束\n- 测试约束');

    const out = formatConstraintsForPrompt('executor');

    expect(mockRender).toHaveBeenCalledWith(ROLE_TRIGGERS.executor, undefined);
    expect(out).toBe('## 行为约束\n- 测试约束');
  });

  it('options.projectRoot 透传给 renderer（worktree 生效集口径）', () => {
    formatConstraintsForPrompt('analyst', { projectRoot: '/repo' });

    expect(mockRender).toHaveBeenCalledWith(ROLE_TRIGGERS.analyst, { projectRoot: '/repo' });
  });

  it('未知 role → 空串且不调用渲染器', () => {
    const out = formatConstraintsForPrompt('unknown' as AgentRole);

    expect(out).toBe('');
    expect(mockRender).not.toHaveBeenCalled();
  });

  it('7 个 AgentRole 均有非空 trigger 路由', () => {
    const roles: AgentRole[] = ['analyst', 'executor', 'integration', 'reviewer', 'deploy', 'monitor', 'triage'];
    expect(Object.keys(ROLE_TRIGGERS).sort()).toEqual([...roles].sort());
    for (const role of roles) {
      expect(ROLE_TRIGGERS[role].length).toBeGreaterThan(0);
    }
  });
});
