import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { StudioRoleSetupModal, isStudioRoleSetupDismissed } from '../StudioRoleSetupModal';

describe('StudioRoleSetupModal (AC-2.2)', () => {
  beforeEach(() => {
    sessionStorage.clear();
  });

  it('open=false 时不渲染', () => {
    render(<StudioRoleSetupModal open={false} onClose={() => {}} onSave={() => {}} />);
    expect(screen.queryByText('系统执行角色未配置')).toBeNull();
  });

  it('open=true 时渲染弹框 + provider 下拉', () => {
    render(<StudioRoleSetupModal open={true} onClose={() => {}} onSave={() => {}} />);
    expect(screen.getByText('系统执行角色未配置')).toBeTruthy();
    expect(screen.getByTestId('studio-provider-select')).toBeTruthy();
  });

  it('选 provider 后确认 -> onSave 被调用 + onClose', () => {
    const onSave = vi.fn();
    const onClose = vi.fn();
    render(<StudioRoleSetupModal open={true} onClose={onClose} onSave={onSave} />);

    fireEvent.change(screen.getByTestId('studio-provider-select'), { target: { value: 'kimi' } });
    fireEvent.click(screen.getByTestId('studio-provider-save'));

    expect(onSave).toHaveBeenCalledWith('kimi');
    expect(onClose).toHaveBeenCalled();
  });

  it('点击稍后 -> onClose + sessionStorage 标记', () => {
    const onClose = vi.fn();
    render(<StudioRoleSetupModal open={true} onClose={onClose} onSave={() => {}} />);

    fireEvent.click(screen.getByText('稍后'));

    expect(onClose).toHaveBeenCalled();
    expect(isStudioRoleSetupDismissed()).toBe(true);
  });

  it('点击 backdrop -> onClose + sessionStorage 标记', () => {
    const onClose = vi.fn();
    const { container } = render(<StudioRoleSetupModal open={true} onClose={onClose} onSave={() => {}} />);

    fireEvent.click(container.querySelector('.modal-overlay')!);

    expect(onClose).toHaveBeenCalled();
    expect(isStudioRoleSetupDismissed()).toBe(true);
  });
});
