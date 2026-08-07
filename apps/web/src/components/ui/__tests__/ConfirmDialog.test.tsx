import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ConfirmDialog } from '../ConfirmDialog';

describe('ConfirmDialog', () => {
  it('open=false 不渲染', () => {
    render(<ConfirmDialog open={false} message="确定删除？" onConfirm={() => {}} onCancel={() => {}} />);
    expect(screen.queryByText('确定删除？')).toBeNull();
  });

  it('渲染标题/正文/双键；确认 → onConfirm，取消 → onCancel', () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog open title="强制停止" message="确认转人工？" onConfirm={onConfirm} onCancel={onCancel} />,
    );
    expect(screen.getByText('强制停止')).toBeInTheDocument();
    expect(screen.getByText('确认转人工？')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '确认' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancelLabel=null → 单按钮 alert 模式（替代原生 alert 的纯告知场景）', () => {
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog open message="创建失败：名称重复" confirmLabel="知道了" cancelLabel={null} onConfirm={onConfirm} onCancel={() => {}} />,
    );
    expect(screen.getByRole('button', { name: '知道了' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull();
  });

  it('danger → 确认键 .btn-danger；自定义文案透传', () => {
    render(
      <ConfirmDialog open danger confirmLabel="强制停止" cancelLabel="再想想" message="确认？" onConfirm={() => {}} onCancel={() => {}} />,
    );
    expect(screen.getByRole('button', { name: '强制停止' }).className).toContain('btn-danger');
    expect(screen.getByRole('button', { name: '再想想' })).toBeInTheDocument();
  });

  it('loading：双键禁用，确认键 aria-busy', () => {
    render(<ConfirmDialog open loading message="确认？" onConfirm={() => {}} onCancel={() => {}} />);
    const confirmBtn = screen.getByRole('button', { name: '确认' });
    const cancelBtn = screen.getByRole('button', { name: '取消' });
    expect(confirmBtn).toBeDisabled();
    expect(confirmBtn).toHaveAttribute('aria-busy', 'true');
    expect(cancelBtn).toBeDisabled();
  });
});
