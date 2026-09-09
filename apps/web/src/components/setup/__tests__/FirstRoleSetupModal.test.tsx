import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { FirstRoleSetupModal } from '../FirstRoleSetupModal';
import { isFirstRoleSetupDismissed } from '../dismissed';

const { mockUseDetectedProviders } = vi.hoisted(() => ({
  mockUseDetectedProviders: vi.fn(),
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

describe('FirstRoleSetupModal (AC-2.3)', () => {
  // #465：onCreate 改为异步返回创建结果（AgentProfile 形最小子集 / null=失败）；
  // 新建两步流需 onJoinChannel（一键加入 #研发）
  const noopCreate = () => Promise.resolve(null);
  const noopJoin = () => Promise.resolve(true);

  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
  });

  it('open=false 时不渲染', () => {
    render(<FirstRoleSetupModal open={false} onClose={() => {}} onCreate={noopCreate} onJoinChannel={noopJoin} />);
    expect(screen.queryByText('请创建角色')).toBeNull();
  });

  // #448 问题3：弹框关着不扫运行环境（/workspaces/runtimes 注定 403 / 进页即扫数十秒）
  it('open=false 时 useDetectedProviders enabled=false（不发请求）；open=true 才启用', () => {
    render(<FirstRoleSetupModal open={false} onClose={() => {}} onCreate={noopCreate} onJoinChannel={noopJoin} />);
    expect(mockUseDetectedProviders).toHaveBeenCalledWith({ enabled: false });

    vi.clearAllMocks();
    render(<FirstRoleSetupModal open={true} onClose={() => {}} onCreate={noopCreate} onJoinChannel={noopJoin} />);
    expect(mockUseDetectedProviders).toHaveBeenCalledWith({ enabled: true });
  });

  it('open=true 时渲染弹框 + name/description/provider 表单', () => {
    render(<FirstRoleSetupModal open={true} onClose={() => {}} onCreate={noopCreate} onJoinChannel={noopJoin} />);
    expect(screen.getByText('请创建角色')).toBeTruthy();
    expect(screen.getByTestId('first-role-name')).toBeTruthy();
    expect(screen.getByTestId('first-role-provider')).toBeTruthy();
  });

  it('name 为空时创建按钮 disabled', () => {
    render(<FirstRoleSetupModal open={true} onClose={() => {}} onCreate={noopCreate} onJoinChannel={noopJoin} />);
    expect(screen.getByTestId('first-role-create')).toBeDisabled();
  });

  // #465：创建成功不再直接关窗——进「加入频道」引导步
  it('填表后创建成功 -> onCreate 被调用 + 进入加入频道引导步（不立即关窗）', async () => {
    const onCreate = vi.fn().mockResolvedValue({ id: 'agent-1', name: 'dev-agent' });
    const onClose = vi.fn();
    render(<FirstRoleSetupModal open={true} onClose={onClose} onCreate={onCreate} onJoinChannel={noopJoin} />);

    fireEvent.change(screen.getByTestId('first-role-name'), { target: { value: 'dev-agent' } });
    // 自定义 Select：点触发器 → 点选项
    fireEvent.click(screen.getByTestId('first-role-provider'));
    fireEvent.click(screen.getByRole('option', { name: 'codex' }));
    fireEvent.click(screen.getByTestId('first-role-create'));

    await waitFor(() => expect(onCreate).toHaveBeenCalledWith({ name: 'dev-agent', description: undefined, provider: 'codex' }));
    expect(await screen.findByTestId('first-role-join-channel')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('引导步点「加入 #研发频道」-> onJoinChannel(新建角色 id)，成功后关窗', async () => {
    const onCreate = vi.fn().mockResolvedValue({ id: 'agent-1', name: 'dev-agent' });
    const onJoinChannel = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    render(<FirstRoleSetupModal open={true} onClose={onClose} onCreate={onCreate} onJoinChannel={onJoinChannel} />);

    fireEvent.change(screen.getByTestId('first-role-name'), { target: { value: 'dev-agent' } });
    fireEvent.click(screen.getByTestId('first-role-create'));
    fireEvent.click(await screen.findByTestId('first-role-join-channel'));

    await waitFor(() => expect(onJoinChannel).toHaveBeenCalledWith('agent-1'));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('引导步点「跳过」-> 直接关窗，不调 onJoinChannel', async () => {
    const onCreate = vi.fn().mockResolvedValue({ id: 'agent-1', name: 'dev-agent' });
    const onJoinChannel = vi.fn().mockResolvedValue(true);
    const onClose = vi.fn();
    render(<FirstRoleSetupModal open={true} onClose={onClose} onCreate={onCreate} onJoinChannel={onJoinChannel} />);

    fireEvent.change(screen.getByTestId('first-role-name'), { target: { value: 'dev-agent' } });
    fireEvent.click(screen.getByTestId('first-role-create'));
    fireEvent.click(await screen.findByText('跳过'));

    expect(onJoinChannel).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('加入失败 -> 显示错误提示且不关窗（可重试或跳过）', async () => {
    const onCreate = vi.fn().mockResolvedValue({ id: 'agent-1', name: 'dev-agent' });
    const onJoinChannel = vi.fn().mockResolvedValue(false);
    const onClose = vi.fn();
    render(<FirstRoleSetupModal open={true} onClose={onClose} onCreate={onCreate} onJoinChannel={onJoinChannel} />);

    fireEvent.change(screen.getByTestId('first-role-name'), { target: { value: 'dev-agent' } });
    fireEvent.click(screen.getByTestId('first-role-create'));
    fireEvent.click(await screen.findByTestId('first-role-join-channel'));

    expect(await screen.findByText(/加入失败/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('创建失败（onCreate 返回 null）-> 静默关窗（保持原 best-effort 语义）', async () => {
    const onCreate = vi.fn().mockResolvedValue(null);
    const onClose = vi.fn();
    render(<FirstRoleSetupModal open={true} onClose={onClose} onCreate={onCreate} onJoinChannel={noopJoin} />);

    fireEvent.change(screen.getByTestId('first-role-name'), { target: { value: 'dev-agent' } });
    fireEvent.click(screen.getByTestId('first-role-create'));

    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(screen.queryByTestId('first-role-join-channel')).toBeNull();
  });

  it('点击稍后 -> onClose + sessionStorage 标记', () => {
    const onClose = vi.fn();
    render(<FirstRoleSetupModal open={true} onClose={onClose} onCreate={noopCreate} onJoinChannel={noopJoin} />);

    fireEvent.click(screen.getByText('稍后'));

    expect(onClose).toHaveBeenCalled();
    expect(isFirstRoleSetupDismissed()).toBe(true);
  });
});
