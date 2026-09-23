// CreateRoleModal — #630（ADR 2026-09-23 决策 1/2）后退为壳：表单段 = RoleFormModal 正本。
// 本组用例只验壳契约（props 映射 + 保存语义），表单域行为由 RoleFormModal.test.tsx 承担；
// 端到端链路（真实 RoleFormModal 渲染）由 WorkspacePage.test / AgentDashboardPage.test 覆盖。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

const { roleFormProps } = vi.hoisted(() => ({
  roleFormProps: { current: null as null as Record<string, unknown> | null },
}));

// 打桩正本：捕获 props，暴露 onSaved/onClose 触发钮
vi.mock('../RoleFormModal', () => ({
  RoleFormModal: (props: Record<string, unknown>) => {
    roleFormProps.current = props;
    if (!props.open) return null;
    return React.createElement('div', { 'data-testid': 'role-form-stub' },
      React.createElement('button', {
        'data-testid': 'stub-saved',
        onClick: () => (props.onSaved as (p: unknown) => void)({ id: 'a1', name: 'x' }),
      }),
      React.createElement('button', {
        'data-testid': 'stub-close',
        onClick: () => (props.onClose as () => void)(),
      }),
    );
  },
}));

import { CreateRoleModal } from '../CreateRoleModal';

describe('CreateRoleModal（壳，#630）', () => {
  beforeEach(() => {
    roleFormProps.current = null;
  });

  it('表单段 = RoleFormModal 正本：mode=create + 标题「创建角色」+ open/onClose 透传', () => {
    const onClose = vi.fn();
    render(<CreateRoleModal open onClose={onClose} onCreated={() => {}} />);
    expect(screen.getByTestId('role-form-stub')).toBeDefined();
    expect(roleFormProps.current).toMatchObject({ mode: 'create', title: '创建角色', open: true });
    expect(roleFormProps.current?.lockProvider).toBeUndefined();

    fireEvent.click(screen.getByTestId('stub-close'));
    expect(onClose).toHaveBeenCalled();
  });

  it('open=false → 正本关闭态（不渲染内容）', () => {
    render(<CreateRoleModal open={false} onClose={() => {}} onCreated={() => {}} />);
    expect(screen.queryByTestId('role-form-stub')).toBeNull();
    expect(roleFormProps.current?.open).toBe(false);
  });

  it('presetProvider（WorkspacePage 行内「设为角色」）→ 映射为 lockProvider', () => {
    render(<CreateRoleModal open presetProvider="claude" onClose={() => {}} onCreated={() => {}} />);
    expect(roleFormProps.current?.lockProvider).toBe('claude');
  });

  it('正本 onSaved → onCreated + 关弹框（§6.4：就地刷新名册，不跳页）', () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<CreateRoleModal open onClose={onClose} onCreated={onCreated} />);
    fireEvent.click(screen.getByTestId('stub-saved'));
    expect(onCreated).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
