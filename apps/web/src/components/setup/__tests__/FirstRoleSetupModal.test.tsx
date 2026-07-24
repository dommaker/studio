import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FirstRoleSetupModal, isFirstRoleSetupDismissed } from '../FirstRoleSetupModal';

// 2026-07：provider 选项改由运行环境扫描驱动，测试中固定回退态（4 个内置 CLI 全量可选）
vi.mock('../../../hooks/useDetectedProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useDetectedProviders')>();
  return {
    ...actual,
    useDetectedProviders: () => ({ detected: [], loading: false, noneDetected: true }),
  };
});

describe('FirstRoleSetupModal (AC-2.3)', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('open=false 时不渲染', () => {
    render(<FirstRoleSetupModal open={false} onClose={() => {}} onCreate={() => {}} />);
    expect(screen.queryByText('请创建角色')).toBeNull();
  });

  it('open=true 时渲染弹框 + name/description/provider 表单', () => {
    render(<FirstRoleSetupModal open={true} onClose={() => {}} onCreate={() => {}} />);
    expect(screen.getByText('请创建角色')).toBeTruthy();
    expect(screen.getByTestId('first-role-name')).toBeTruthy();
    expect(screen.getByTestId('first-role-provider')).toBeTruthy();
  });

  it('name 为空时创建按钮 disabled', () => {
    render(<FirstRoleSetupModal open={true} onClose={() => {}} onCreate={() => {}} />);
    expect(screen.getByTestId('first-role-create')).toBeDisabled();
  });

  it('填表后创建 -> onCreate 被调用 + onClose', () => {
    const onCreate = vi.fn();
    const onClose = vi.fn();
    render(<FirstRoleSetupModal open={true} onClose={onClose} onCreate={onCreate} />);

    fireEvent.change(screen.getByTestId('first-role-name'), { target: { value: 'dev-agent' } });
    fireEvent.change(screen.getByTestId('first-role-provider'), { target: { value: 'codex' } });
    fireEvent.click(screen.getByTestId('first-role-create'));

    expect(onCreate).toHaveBeenCalledWith({ name: 'dev-agent', description: undefined, provider: 'codex' });
    expect(onClose).toHaveBeenCalled();
  });

  it('点击稍后 -> onClose + sessionStorage 标记', () => {
    const onClose = vi.fn();
    render(<FirstRoleSetupModal open={true} onClose={onClose} onCreate={() => {}} />);

    fireEvent.click(screen.getByText('稍后'));

    expect(onClose).toHaveBeenCalled();
    expect(isFirstRoleSetupDismissed()).toBe(true);
  });
});
