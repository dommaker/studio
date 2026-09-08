// CreateOkrDialog — #448 问题2：创建失败 toast 显示服务端具体原因
// 409 撞重等 4xx 带 error.message → 展示该 message；无 message 时回退通用文案。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockCreate, mockToastError } = vi.hoisted(() => ({
  mockCreate: vi.fn(),
  mockToastError: vi.fn(),
}));
vi.mock('../../../api/pmo', () => ({
  okrApi: { create: (...args: unknown[]) => mockCreate(...args) },
}));
vi.mock('../../../utils/toast', () => ({
  toast: { success: vi.fn(), error: (...args: unknown[]) => mockToastError(...args), warning: vi.fn(), info: vi.fn() },
}));

import { CreateOkrDialog } from '../CreateOkrDialog';

beforeEach(() => {
  vi.clearAllMocks();
});

function renderOpen() {
  return render(
    <CreateOkrDialog open companyId="co-1" onClose={vi.fn()} onCreated={vi.fn()} />,
  );
}

async function fillAndSubmit() {
  fireEvent.change(screen.getByPlaceholderText('管线效率提升 Q2'), { target: { value: 'O' } });
  fireEvent.click(screen.getByText('创建'));
  await waitFor(() => expect(mockCreate).toHaveBeenCalled());
}

describe('#448: 创建 OKR 失败提示', () => {
  it('409 撞重：toast 展示服务端返回的具体原因', async () => {
    mockCreate.mockRejectedValue({
      response: { status: 409, data: { error: { code: 'CONFLICT', message: 'OKR for quarter 2099-Q1 already exists' } } },
    });
    renderOpen();
    await fillAndSubmit();
    await waitFor(() => expect(mockToastError).toHaveBeenCalled());
    expect(mockToastError.mock.calls[0][0]).toContain('OKR for quarter 2099-Q1 already exists');
  });

  it('无服务端 message（如网络错误）：回退通用文案', async () => {
    mockCreate.mockRejectedValue(new Error('Network Error'));
    renderOpen();
    await fillAndSubmit();
    await waitFor(() => expect(mockToastError).toHaveBeenCalledWith('创建 OKR 失败'));
  });
});
