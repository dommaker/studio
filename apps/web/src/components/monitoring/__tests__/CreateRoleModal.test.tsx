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

// 契约（2026-09-10 收敛）：/workspaces/runtimes 只返回本机 CLI 清单 {provider, version}，
// 节点维度（nodeId/workspaceName）随远程节点方向一起废弃，见 workspaces/CONTEXT.md
const runtimes = [
  { provider: 'claude', version: '1.0.0' },
  { provider: 'kimi', version: '0.9.0' },
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

  it('同一 provider 重复条目只渲染一行（去重键 = provider，不再是 nodeId:provider）', async () => {
    mockApiGet.mockResolvedValue({ data: { runtimes: [...runtimes, { provider: 'claude', version: '9.9.9' }] } });
    render(<CreateRoleModal open onClose={() => {}} onCreated={() => {}} />);
    expect(await screen.findByText(/检测到 2 个 runtime/)).toBeDefined();
    expect(screen.getAllByText('claude')).toHaveLength(1);
    expect(screen.queryByText('v9.9.9')).toBeNull();
  });

  it('候选行不展示节点名（@ workspace 维度已随远程节点方向废弃）', async () => {
    const { container } = render(<CreateRoleModal open onClose={() => {}} onCreated={() => {}} />);
    expect(await screen.findByText(/检测到 2 个 runtime/)).toBeDefined();
    // 不用 /@\s/：testing-library 的空白归一化会把尾随空格吃掉，断言会空过
    expect(container.textContent).not.toContain('@');
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

  it('清单拉取失败 → 提示获取失败，不误报「未检测到 CLI」', async () => {
    mockApiGet.mockRejectedValue(new Error('network down'));
    render(<CreateRoleModal open onClose={() => {}} onCreated={() => {}} />);
    expect(await screen.findByText(/获取本机 CLI 清单失败/)).toBeDefined();
    expect(screen.queryByText(/未检测到 CLI/)).toBeNull();
  });

  // E8-4：presetProvider（WorkspacePage 行内「设为角色」复用正本）
  it('presetProvider → 不拉取 runtime 清单，单项固定预选 + provider 只读', async () => {
    render(<CreateRoleModal open presetProvider="claude" onClose={() => {}} onCreated={() => {}} />);
    // provider 只读展示，无勾选列表
    expect(screen.getByText('claude')).toBeDefined();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/检测到 .* runtime/)).toBeNull();
    expect(mockApiGet).not.toHaveBeenCalled();
    // 已预选但未命名 → 提交键禁用
    expect(screen.getByTestId('create-role-submit').hasAttribute('disabled')).toBe(true);
  });

  it('presetProvider → 命名后创建带锁定 provider，成功关弹框 + onCreated', async () => {
    const onClose = vi.fn();
    const onCreated = vi.fn();
    render(<CreateRoleModal open presetProvider="claude" onClose={onClose} onCreated={onCreated} />);
    fireEvent.change(screen.getByTestId('role-name-preset:claude'), { target: { value: 'Executor' } });
    fireEvent.change(screen.getByPlaceholderText(/描述（可选）/), { target: { value: '代码实现' } });
    fireEvent.click(screen.getByTestId('create-role-submit'));
    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledWith({
      name: 'Executor',
      description: '代码实现',
      provider: 'claude',
    }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
  });
});
