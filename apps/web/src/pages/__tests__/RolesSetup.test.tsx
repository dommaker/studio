import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RolesSetup } from '../RolesSetup';

// Mock api 对象
const { mockApiGet } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
}));
const { mockCreateAgent } = vi.hoisted(() => ({
  mockCreateAgent: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: { get: mockApiGet },
}));

vi.mock('../../api/channel', () => ({
  channelApi: { createAgent: mockCreateAgent },
}));

function renderWithRouter() {
  return render(
    <MemoryRouter>
      <RolesSetup />
    </MemoryRouter>
  );
}

describe('RolesSetup (AC-2.5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('空 runtime 清单时显示"未检测到 CLI"提示', async () => {
    mockApiGet.mockResolvedValue({ data: { runtimes: [] } });
    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByText(/未检测到 CLI/)).toBeTruthy();
    });
  });

  it('有 runtime 时渲染清单', async () => {
    mockApiGet.mockResolvedValue({
      data: {
        runtimes: [
          { nodeId: 'ws-1', provider: 'claude', version: '2.1.80', workspaceName: 'local' },
          { nodeId: 'ws-1', provider: 'kimi', version: '0.27.0', workspaceName: 'local' },
        ],
      },
    });
    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByText('claude')).toBeTruthy();
      expect(screen.getByText('kimi')).toBeTruthy();
    });
  });

  it('勾选 runtime 后显示 name 输入框', async () => {
    mockApiGet.mockResolvedValue({
      data: {
        runtimes: [
          { nodeId: 'ws-1', provider: 'claude', version: '2.1.80', workspaceName: 'local' },
        ],
      },
    });
    renderWithRouter();
    await waitFor(() => expect(screen.getByText('claude')).toBeTruthy());

    // 勾选 checkbox
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);

    expect(screen.getByTestId('role-name-ws-1:claude')).toBeTruthy();
  });

  it('填 name 后点创建 -> 调 createAgent', async () => {
    mockApiGet.mockResolvedValue({
      data: {
        runtimes: [
          { nodeId: 'ws-1', provider: 'claude', version: '2.1.80', workspaceName: 'local' },
        ],
      },
    });
    mockCreateAgent.mockResolvedValue({ data: { id: 'new-id' } });
    renderWithRouter();
    await waitFor(() => expect(screen.getByText('claude')).toBeTruthy());

    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByTestId('role-name-ws-1:claude'), { target: { value: 'dev-agent' } });
    fireEvent.click(screen.getByTestId('roles-setup-create'));

    await waitFor(() => {
      expect(mockCreateAgent).toHaveBeenCalledWith({
        name: 'dev-agent',
        description: undefined,
        provider: 'claude',
      });
    });
  });
});
