// 工单 38: CompanySection 公司名自动保存防抖 — 连续击键合并为一次保存；防抖期间输入即时回显
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

const { mockUpdate, mockCreate } = vi.hoisted(() => ({
  mockUpdate: vi.fn(),
  mockCreate: vi.fn(),
}));

vi.mock('../../../api/company', () => ({
  companyApi: { update: mockUpdate, create: mockCreate },
}));

import { CompanySection, type Company } from '../CompanySection';

const COMPANY: Company = { id: 'co-1', name: '初始公司', size: '' };

const renderSection = () =>
  render(
    <CompanySection
      company={COMPANY}
      newCompanyName=""
      setCompany={vi.fn()}
      setNewCompanyName={vi.fn()}
    />
  );

describe('工单 38: CompanySection 公司名防抖', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mockUpdate.mockResolvedValue({ data: {} });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('连续击键在防抖窗口内只触发一次保存，且保存的是最终值', async () => {
    renderSection();
    const input = screen.getByPlaceholderText('输入公司名称');

    fireEvent.change(input, { target: { value: '初' } });
    fireEvent.change(input, { target: { value: '初始' } });
    fireEvent.change(input, { target: { value: '初始公司改' } });

    // 防抖窗口内不落库
    await act(async () => { vi.advanceTimersByTime(400); });
    expect(mockUpdate).not.toHaveBeenCalled();

    await act(async () => { vi.advanceTimersByTime(200); });
    expect(mockUpdate).toHaveBeenCalledTimes(1);
    expect(mockUpdate).toHaveBeenCalledWith('co-1', { name: '初始公司改' });
  });

  it('防抖期间输入框即时回显本地草稿', () => {
    renderSection();
    const input = screen.getByPlaceholderText('输入公司名称') as HTMLInputElement;

    fireEvent.change(input, { target: { value: '新名字' } });
    // 未等保存完成，输入框已显示新值（不被 company.name 回退打断）
    expect(input.value).toBe('新名字');
  });

  it('空名称不落库', async () => {
    renderSection();
    const input = screen.getByPlaceholderText('输入公司名称');

    fireEvent.change(input, { target: { value: '   ' } });
    await act(async () => { vi.advanceTimersByTime(600); });
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});
