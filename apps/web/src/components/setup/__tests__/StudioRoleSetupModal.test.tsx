import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { StudioRoleSetupModal } from '../StudioRoleSetupModal';
import { isStudioRoleSetupDismissed } from '../dismissed';

const { mockUseDetectedProviders, mockUpdateAgent } = vi.hoisted(() => ({
  mockUseDetectedProviders: vi.fn(),
  mockUpdateAgent: vi.fn(),
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

// #630：提交收口 RoleFormModal 正本（edit 模式 channelApi.updateAgent，只 PATCH 脏字段）
vi.mock('../../../api/channel', () => ({
  channelApi: { updateAgent: mockUpdateAgent },
}));

const studioProfile = { id: 'p-studio', name: 'studio', description: '系统执行角色', provider: null };

describe('StudioRoleSetupModal (AC-2.2)', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    mockUpdateAgent.mockResolvedValue({ data: { data: { ...studioProfile, provider: 'kimi' } } });
  });

  it('open=false 时不渲染', () => {
    render(<StudioRoleSetupModal open={false} profile={studioProfile} onClose={() => {}} />);
    expect(screen.queryByText('系统执行角色未配置')).toBeNull();
  });

  it('profile 未加载（null）时不渲染', () => {
    render(<StudioRoleSetupModal open profile={null} onClose={() => {}} />);
    expect(screen.queryByText('系统执行角色未配置')).toBeNull();
  });

  // #448 问题3：弹框关着不扫运行环境（/workspaces/runtimes 注定 403 / 进页即扫数十秒）
  it('open=false 时 useDetectedProviders enabled=false（不发请求）；open=true 才启用', () => {
    render(<StudioRoleSetupModal open={false} profile={studioProfile} onClose={() => {}} />);
    expect(mockUseDetectedProviders).toHaveBeenCalledWith({ enabled: false });

    vi.clearAllMocks();
    render(<StudioRoleSetupModal open={true} profile={studioProfile} onClose={() => {}} />);
    expect(mockUseDetectedProviders).toHaveBeenCalledWith({ enabled: true });
  });

  it('open=true 时渲染弹框 + provider 下拉（正本字段）；studio 保留名 name 输入禁用', () => {
    render(<StudioRoleSetupModal open={true} profile={studioProfile} onClose={() => {}} />);
    expect(screen.getByText('系统执行角色未配置')).toBeTruthy();
    expect(screen.getByTestId('role-form-provider')).toBeTruthy();
    expect((screen.getByTestId('role-form-name') as HTMLInputElement).disabled).toBe(true);
  });

  it('选 provider 后确认 -> updateAgent 只 PATCH provider 脏字段 + onSaved + onClose（成功关窗不打 dismiss 标记）', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    render(<StudioRoleSetupModal open={true} profile={studioProfile} onClose={onClose} onSaved={onSaved} />);

    // 自定义 Select：点触发器 → 点选项（选项面板 portal 到 body）
    fireEvent.click(screen.getByTestId('role-form-provider'));
    fireEvent.click(screen.getByRole('option', { name: 'kimi' }));
    fireEvent.click(screen.getByTestId('create-role-submit'));

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledWith('p-studio', { provider: 'kimi' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    expect(isStudioRoleSetupDismissed()).toBe(false);
  });

  // #630：关窗键随正本统一为「取消」（原壳内「稍后」），dismiss 标记语义不变
  it('点击取消 -> onClose + sessionStorage 标记', () => {
    const onClose = vi.fn();
    render(<StudioRoleSetupModal open={true} profile={studioProfile} onClose={onClose} />);

    fireEvent.click(screen.getByText('取消'));

    expect(onClose).toHaveBeenCalled();
    expect(isStudioRoleSetupDismissed()).toBe(true);
  });

  it('点击 backdrop -> onClose + sessionStorage 标记', () => {
    const onClose = vi.fn();
    const { container } = render(<StudioRoleSetupModal open={true} profile={studioProfile} onClose={onClose} />);

    fireEvent.click(container.querySelector('.modal-overlay')!);

    expect(onClose).toHaveBeenCalled();
    expect(isStudioRoleSetupDismissed()).toBe(true);
  });
});
