import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FirstRoleSetupModal } from '../FirstRoleSetupModal';
import { isFirstRoleSetupDismissed } from '../dismissed';

const { mockUseDetectedProviders, mockCreateAgent } = vi.hoisted(() => ({
  mockUseDetectedProviders: vi.fn(),
  mockCreateAgent: vi.fn(),
}));

// 2026-07：provider 选项改由运行环境扫描驱动，测试中固定回退态（4 个内置 CLI 全量可选）
vi.mock('../../../hooks/useDetectedProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useDetectedProviders')>();
  return {
    ...actual,
    useDetectedProviders: (options?: { enabled?: boolean }) => {
      mockUseDetectedProviders(options);
      return { detected: [], loading: false, noneDetected: true };
    },
  };
});

// #630：提交收口 RoleFormModal 正本（channelApi.createAgent），壳不再有 onCreate 注入
// #633：正本 create 模式打开时拉 preset 清单，桩为空清单（模板入口行为由 RoleFormModal.test 承担）
vi.mock('../../../api/channel', () => ({
  channelApi: {
    createAgent: mockCreateAgent,
    listRolePresets: vi.fn().mockResolvedValue({ data: { data: [] } }),
  },
}));

describe('FirstRoleSetupModal (AC-2.3)', () => {
  // #465 两步流需 onJoinChannel（一键加入 #研发）；#630：onCreated = 创建成功回调（App 刷 roster）
  const noopJoin = () => Promise.resolve(true);

  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    mockCreateAgent.mockResolvedValue({ data: { id: 'agent-1', name: 'dev-agent' } });
  });

  it('open=false 时不渲染', () => {
    render(<FirstRoleSetupModal open={false} onClose={() => {}} onJoinChannel={noopJoin} />);
    expect(screen.queryByText('请创建角色')).toBeNull();
  });

  // #448 问题3：弹框关着不扫运行环境（/workspaces/runtimes 注定 403 / 进页即扫数十秒）
  it('open=false 时 useDetectedProviders enabled=false（不发请求）；open=true 才启用', () => {
    render(<FirstRoleSetupModal open={false} onClose={() => {}} onJoinChannel={noopJoin} />);
    expect(mockUseDetectedProviders).toHaveBeenCalledWith({ enabled: false });

    vi.clearAllMocks();
    render(<FirstRoleSetupModal open={true} onClose={() => {}} onJoinChannel={noopJoin} />);
    expect(mockUseDetectedProviders).toHaveBeenCalledWith({ enabled: true });
  });

  it('open=true 时渲染弹框 + name/description/provider 表单（正本字段）', () => {
    render(<FirstRoleSetupModal open={true} onClose={() => {}} onJoinChannel={noopJoin} />);
    expect(screen.getByText('请创建角色')).toBeTruthy();
    expect(screen.getByTestId('role-form-name')).toBeTruthy();
    expect(screen.getByTestId('role-form-provider')).toBeTruthy();
  });

  it('name 为空时创建按钮 disabled', () => {
    render(<FirstRoleSetupModal open={true} onClose={() => {}} onJoinChannel={noopJoin} />);
    expect(screen.getByTestId('create-role-submit')).toBeDisabled();
  });

  // #465：创建成功不再直接关窗——进「加入频道」引导步
  it('填表后创建成功 -> createAgent 被调用 + onCreated + 进入加入频道引导步（不立即关窗）', async () => {
    const onCreated = vi.fn();
    const onClose = vi.fn();
    render(<FirstRoleSetupModal open={true} onClose={onClose} onCreated={onCreated} onJoinChannel={noopJoin} />);

    fireEvent.change(screen.getByTestId('role-form-name'), { target: { value: 'dev-agent' } });
    // 自定义 Select：点触发器 → 点选项
    fireEvent.click(screen.getByTestId('role-form-provider'));
    fireEvent.click(screen.getByRole('option', { name: 'codex' }));
    fireEvent.click(screen.getByTestId('create-role-submit'));

    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledWith({ name: 'dev-agent', description: undefined, provider: 'codex' }));
    expect(await screen.findByTestId('first-role-join-channel')).toBeTruthy();
    expect(onCreated).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('引导步点「加入 #研发频道」-> onJoinChannel(新建角色 id)，成功后关窗', async () => {
    const onJoinChannel = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    render(<FirstRoleSetupModal open={true} onClose={onClose} onJoinChannel={onJoinChannel} />);

    fireEvent.change(screen.getByTestId('role-form-name'), { target: { value: 'dev-agent' } });
    fireEvent.click(screen.getByTestId('create-role-submit'));
    fireEvent.click(await screen.findByTestId('first-role-join-channel'));

    await waitFor(() => expect(onJoinChannel).toHaveBeenCalledWith('agent-1'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('引导步点「跳过」-> 直接关窗，不调 onJoinChannel', async () => {
    const onJoinChannel = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    render(<FirstRoleSetupModal open={true} onClose={onClose} onJoinChannel={onJoinChannel} />);

    fireEvent.change(screen.getByTestId('role-form-name'), { target: { value: 'dev-agent' } });
    fireEvent.click(screen.getByTestId('create-role-submit'));
    fireEvent.click(await screen.findByText('跳过'));

    expect(onJoinChannel).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('加入失败 -> 显示错误提示且不关窗（可重试或跳过）', async () => {
    const onJoinChannel = vi.fn().mockResolvedValue(false);
    const onClose = vi.fn();
    render(<FirstRoleSetupModal open={true} onClose={onClose} onJoinChannel={onJoinChannel} />);

    fireEvent.change(screen.getByTestId('role-form-name'), { target: { value: 'dev-agent' } });
    fireEvent.click(screen.getByTestId('create-role-submit'));
    fireEvent.click(await screen.findByTestId('first-role-join-channel'));

    expect(await screen.findByText(/加入失败/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  // #630 决策 1：创建失败语义归一为正本「内联报错留窗」——原「静默关窗」（best-effort）断言改写：
  // 失败不再调 onClose，错误文案上屏、不进引导步
  it('创建失败（createAgent 拒绝）-> 内联报错留窗，不关窗不进引导步', async () => {
    mockCreateAgent.mockRejectedValue(new Error('name taken'));
    const onClose = vi.fn();
    render(<FirstRoleSetupModal open={true} onClose={onClose} onJoinChannel={noopJoin} />);

    fireEvent.change(screen.getByTestId('role-form-name'), { target: { value: 'dev-agent' } });
    fireEvent.click(screen.getByTestId('create-role-submit'));

    expect(await screen.findByText(/name taken/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId('first-role-join-channel')).toBeNull();
    // 表单仍在（可修正重试）
    expect(screen.getByTestId('role-form-name')).toBeTruthy();
  });

  // #630：关窗键随正本统一为「取消」（原壳内「稍后」），onClose=handleDismiss 的标记语义不变
  it('点击取消 -> onClose + sessionStorage 标记', () => {
    const onClose = vi.fn();
    render(<FirstRoleSetupModal open={true} onClose={onClose} onJoinChannel={noopJoin} />);

    fireEvent.click(screen.getByText('取消'));

    expect(onClose).toHaveBeenCalled();
    expect(isFirstRoleSetupDismissed()).toBe(true);
  });
});
