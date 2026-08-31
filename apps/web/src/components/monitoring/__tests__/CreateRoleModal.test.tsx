// CreateRoleModal — #397 §6.4：创建角色弹框化（替代 /setup/roles 跳页）
// 勾选检测到的 runtime + 命名 → 创建 → 关弹框 + onCreated（页面就地刷新名册），全程不跳页。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

const { mockApiGet, mockCreateAgent } = vi.hoisted(() => ({
  mockApiGet: vi.fn(),
  mockCreateAgent: vi.fn(),
}));

vi.mock('../../../api', () => ({ api: { get: mockApiGet } }));
vi.mock('../../../api/channel', () => ({ channelApi: { createAgent: mockCreateAgent } }));

import { CreateRoleModal } from '../CreateRoleModal';

const runtimes = [
  { nodeId: 'n1', provider: 'claude', version: '1.0.0', workspaceName: 'studio' },
  { nodeId: 'n1', provider: 'kimi', version: '0.9.0', workspaceName: 'studio' },
];

describe('CreateRoleModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockApiGet.mockResolvedValue({ data: { runtimes } });
    mockCreateAgent.mockResolvedValue({ data: {} });
  });

  it('open=false → 不渲染、不拉取', () => {
    const { container } = render(<CreateRoleModal open={false} onClose={() => {}} onCreated={() => {}} />);
    expect(container.innerHTML).toBe('');
    expect(mockApiGet).not.toHaveBeenCalled();
  });

  it('打开即拉取 runtime 清单；空清单 → 未检测到 CLI 提示', async () => {
    mockApiGet.mockResolvedValue({ data: { runtimes: [] } });
    render(<CreateRoleModal open onClose={() => {}} onCreated={() => {}} />);
    expect(await screen.findByText(/未检测到 CLI/)).toBeDefined();
    expect(mockApiGet).toHaveBeenCalledWith('/workspaces/runtimes');
  });

  it('勾选 runtime 展开命名输入；未命名不可创建；保存 → 逐个创建 + 关弹框 + onCreated', async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    render(<CreateRoleModal open onClose={onClose} onCreated={onCreated} />);
    expect(await screen.findByText(/检测到 2 个 runtime/)).toBeDefined();

    const submit = screen.getByRole('button', { name: /创建选中角色/ });
    expect(submit.hasAttribute('disabled')).toBe(true);

    // 勾选 claude 与 kimi；kimi 不命名（应被跳过）
    const boxes = screen.getAllByRole('checkbox');
    fireEvent.click(boxes[0]);
    fireEvent.click(boxes[1]);
    fireEvent.change(screen.getAllByPlaceholderText(/角色名称/)[0], { target: { value: ' qa-agent ' } });
    expect(submit.hasAttribute('disabled')).toBe(false);

    fireEvent.click(submit);
    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledTimes(1));
    expect(mockCreateAgent).toHaveBeenCalledWith({ name: 'qa-agent', description: undefined, provider: 'claude' });
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });

  it('创建失败 → 错误上屏，弹框保持打开', async () => {
    mockCreateAgent.mockRejectedValue(new Error('name taken'));
    const onClose = vi.fn();
    render(<CreateRoleModal open onClose={onClose} onCreated={() => {}} />);
    expect(await screen.findByText(/检测到 2 个 runtime/)).toBeDefined();
    fireEvent.click(screen.getAllByRole('checkbox')[0]);
    fireEvent.change(screen.getByPlaceholderText(/角色名称/), { target: { value: 'qa-agent' } });
    fireEvent.click(screen.getByRole('button', { name: /创建选中角色/ }));
    expect(await screen.findByText(/name taken/)).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('取消 → onClose，不创建', async () => {
    const onClose = vi.fn();
    render(<CreateRoleModal open onClose={onClose} onCreated={() => {}} />);
    expect(await screen.findByText(/检测到 2 个 runtime/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onClose).toHaveBeenCalled();
    expect(mockCreateAgent).not.toHaveBeenCalled();
  });
});
