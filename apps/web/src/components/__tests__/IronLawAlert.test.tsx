import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { IronLawAlert, type IronLaw } from '../IronLawAlert';

describe('IronLawAlert', () => {
  const mockLaw: IronLaw = {
    id: 'no_fix_without_root_cause',
    rule: 'NO FIXES WITHOUT ROOT CAUSE',
    message: '禁止在没有找到根本原因的情况下进行修复',
    trigger: 'code_implementation',
    enforcement: '请先进行根因分析',
    severity: 'error',
    description: '任何修复之前必须明确问题的根本原因',
  };

  const mockCallbacks = {
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should not render when visible is false', () => {
    render(<IronLawAlert law={mockLaw} visible={false} {...mockCallbacks} />);
    expect(screen.queryByText('铁律提示')).not.toBeInTheDocument();
  });

  it('should render law rule', () => {
    render(<IronLawAlert law={mockLaw} visible={true} {...mockCallbacks} />);
    expect(screen.getByText('NO FIXES WITHOUT ROOT CAUSE')).toBeInTheDocument();
  });

  it('should render law message', () => {
    render(<IronLawAlert law={mockLaw} visible={true} {...mockCallbacks} />);
    expect(screen.getByText('禁止在没有找到根本原因的情况下进行修复')).toBeInTheDocument();
  });

  it('should render description', () => {
    render(<IronLawAlert law={mockLaw} visible={true} {...mockCallbacks} />);
    expect(screen.getByText('任何修复之前必须明确问题的根本原因')).toBeInTheDocument();
  });

  it('should render enforcement suggestion', () => {
    render(<IronLawAlert law={mockLaw} visible={true} {...mockCallbacks} />);
    expect(screen.getByText('请先进行根因分析')).toBeInTheDocument();
  });

  it('should call onCancel when cancel button clicked', () => {
    render(<IronLawAlert law={mockLaw} visible={true} {...mockCallbacks} />);
    const cancelButton = screen.getByText('取消');
    fireEvent.click(cancelButton);
    expect(mockCallbacks.onCancel).toHaveBeenCalled();
  });

  it('should call onConfirm when confirm button clicked', () => {
    render(<IronLawAlert law={mockLaw} visible={true} {...mockCallbacks} />);
    const confirmButton = screen.getByText('执行建议操作');
    fireEvent.click(confirmButton);
    expect(mockCallbacks.onConfirm).toHaveBeenCalled();
  });

  it('should show error icon for error severity', () => {
    render(<IronLawAlert law={mockLaw} visible={true} {...mockCallbacks} />);
    expect(screen.getByText('🚫')).toBeInTheDocument();
  });

  it('should show warning icon for warning severity', () => {
    const warningLaw = { ...mockLaw, severity: 'warning' as const };
    render(<IronLawAlert law={warningLaw} visible={true} {...mockCallbacks} />);
    expect(screen.getByText('⚠️')).toBeInTheDocument();
  });

  it('should show info icon for info severity', () => {
    const infoLaw = { ...mockLaw, severity: 'info' as const };
    render(<IronLawAlert law={infoLaw} visible={true} {...mockCallbacks} />);
    expect(screen.getByText('ℹ️')).toBeInTheDocument();
  });

  it('should render without description', () => {
    const lawWithoutDesc = { ...mockLaw, description: undefined };
    render(<IronLawAlert law={lawWithoutDesc} visible={true} {...mockCallbacks} />);
    expect(screen.getByText('铁律提示')).toBeInTheDocument();
  });
});