// RoleFormModal — #630（ADR 2026-09-23-role-form-module 决策 1/2/3）：角色表单唯一正本。
// create/edit 双模式契约：create 收窄单角色（一个 name + 一个 provider Select，候选唯一来源
// useDetectedProviders）；edit 预填 initial、PATCH 只带脏字段、改 provider 出生效条件提示、
// 409 名称冲突内联报错留窗、pending 锁存。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';

const { mockCreateAgent, mockUpdateAgent, mockUseDetectedProviders, hookState } = vi.hoisted(() => ({
  mockCreateAgent: vi.fn(),
  mockUpdateAgent: vi.fn(),
  mockUseDetectedProviders: vi.fn(),
  // 用例级可变的 hook 返回值（检测到的 CLI 清单）
  hookState: {
    current: { detected: [] as unknown[], loading: false, noneDetected: true },
  },
}));

vi.mock('../../../api/channel', () => ({
  channelApi: { createAgent: mockCreateAgent, updateAgent: mockUpdateAgent },
}));

vi.mock('../../../hooks/useDetectedProviders', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../hooks/useDetectedProviders')>();
  return {
    ...actual,
    useDetectedProviders: (options?: { enabled?: boolean }) => {
      mockUseDetectedProviders(options);
      return hookState.current;
    },
  };
});

import { RoleFormModal } from '../RoleFormModal';

const detectedOk = {
  detected: [
    { provider: 'claude', version: '1.0.0', auth: 'ok' },
    { provider: 'kimi', version: '0.9.0', auth: 'failed', authHint: '请运行 kimi login' },
  ],
  loading: false,
  noneDetected: false,
};

const editInitial = { id: 'p1', name: 'dev-agent', description: 'writes code', provider: 'claude' };

function renderCreate(props: Partial<React.ComponentProps<typeof RoleFormModal>> = {}) {
  return render(
    <RoleFormModal open mode="create" onClose={() => {}} onSaved={() => {}} {...props} />,
  );
}

function renderEdit(props: Partial<React.ComponentProps<typeof RoleFormModal>> = {}) {
  return render(
    <RoleFormModal open mode="edit" initial={editInitial} onClose={() => {}} onSaved={() => {}} {...props} />,
  );
}

describe('RoleFormModal — create 模式（决策 2：收窄单角色）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookState.current = { detected: [], loading: false, noneDetected: true };
    mockCreateAgent.mockResolvedValue({ data: { id: 'a1', name: 'qa-agent' } });
  });

  it('渲染 name/description 输入 + provider Select；name 空时提交键禁用', () => {
    renderCreate();
    expect(screen.getByTestId('role-form-name')).toBeDefined();
    expect(screen.getByPlaceholderText(/描述（可选）/)).toBeDefined();
    expect(screen.getByTestId('role-form-provider')).toBeDefined();
    expect(screen.getByTestId('create-role-submit')).toBeDisabled();
  });

  it('填 name 后提交 → createAgent（trim 后的值 + 默认首个可用 provider）→ onSaved 回传创建结果', async () => {
    hookState.current = { ...detectedOk };
    const onSaved = vi.fn();
    renderCreate({ onSaved });

    fireEvent.change(screen.getByTestId('role-form-name'), { target: { value: ' qa-agent ' } });
    fireEvent.change(screen.getByPlaceholderText(/描述（可选）/), { target: { value: ' 质量守护 ' } });
    fireEvent.click(screen.getByTestId('create-role-submit'));

    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledWith({
      name: 'qa-agent',
      description: '质量守护',
      provider: 'claude',
    }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith({ id: 'a1', name: 'qa-agent' }));
  });

  it('provider Select：未检测到的内置 CLI 列禁用项；auth=failed 带「未登录」徽标', () => {
    hookState.current = { ...detectedOk };
    renderCreate();
    fireEvent.click(screen.getByTestId('role-form-provider'));
    expect(screen.getByRole('option', { name: /claude/ })).toBeDefined();
    // #565 链路：auth=failed 徽标
    expect(screen.getByRole('option', { name: /kimi.*未登录/ })).toBeDefined();
    // 未检测到的内置项禁用
    const codex = screen.getByRole('option', { name: /codex（未检测到）/ });
    expect(codex.getAttribute('aria-disabled')).toBe('true');
  });

  it('选择 provider 后提交带上所选 CLI', async () => {
    hookState.current = { ...detectedOk };
    renderCreate();
    fireEvent.change(screen.getByTestId('role-form-name'), { target: { value: 'qa-agent' } });
    fireEvent.click(screen.getByTestId('role-form-provider'));
    fireEvent.click(screen.getByRole('option', { name: /kimi/ }));
    fireEvent.click(screen.getByTestId('create-role-submit'));
    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'kimi' }),
    ));
  });

  it('一个都没检测到 → 提示「未检测到 CLI」+ 全部内置项回退可选（不卡死用户）', () => {
    renderCreate();
    expect(screen.getByText(/未检测到 CLI/)).toBeDefined();
    fireEvent.click(screen.getByTestId('role-form-provider'));
    expect(screen.getByRole('option', { name: 'claude' }).getAttribute('aria-disabled')).toBeNull();
  });

  it('pending 锁存：提交中双键禁用 + 提交键文案「创建中…」，完成后恢复', async () => {
    let resolveCreate: (v: unknown) => void = () => {};
    mockCreateAgent.mockImplementation(() => new Promise((r) => { resolveCreate = r; }));
    renderCreate();
    fireEvent.change(screen.getByTestId('role-form-name'), { target: { value: 'qa-agent' } });
    const submit = screen.getByTestId('create-role-submit');
    fireEvent.click(submit);

    expect(await screen.findByText('创建中…')).toBeDefined();
    expect(submit).toBeDisabled();
    expect(screen.getByRole('button', { name: '取消' })).toBeDisabled();

    resolveCreate({ data: { id: 'a1', name: 'qa-agent' } });
    await waitFor(() => expect(screen.queryByText('创建中…')).toBeNull());
  });

  it('创建失败（409 名称冲突）→ 服务端 message 内联报错留窗，不调 onClose/onSaved', async () => {
    mockCreateAgent.mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { error: { code: 'DUPLICATE', message: 'AgentProfile with name "qa-agent" already exists' } } },
    });
    const onClose = vi.fn();
    const onSaved = vi.fn();
    renderCreate({ onClose, onSaved });
    fireEvent.change(screen.getByTestId('role-form-name'), { target: { value: 'qa-agent' } });
    fireEvent.click(screen.getByTestId('create-role-submit'));

    expect(await screen.findByText(/already exists/)).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('lockProvider（WorkspacePage 行内「设为角色」映射）→ 不扫 runtime、provider 只读展示、提交带锁定值', async () => {
    const onSaved = vi.fn();
    renderCreate({ lockProvider: 'claude', onSaved });
    // provider 只读文本，无 Select
    expect(screen.getByText('claude')).toBeDefined();
    expect(screen.queryByTestId('role-form-provider')).toBeNull();
    // 锁定时不发起 runtime 扫描
    expect(mockUseDetectedProviders).toHaveBeenCalledWith({ enabled: false });

    fireEvent.change(screen.getByTestId('role-form-name'), { target: { value: 'Executor' } });
    fireEvent.click(screen.getByTestId('create-role-submit'));
    await waitFor(() => expect(mockCreateAgent).toHaveBeenCalledWith({
      name: 'Executor',
      description: undefined,
      provider: 'claude',
    }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});

describe('RoleFormModal — edit 模式（决策 3：name/description/provider 三项）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hookState.current = { ...detectedOk };
    mockUpdateAgent.mockResolvedValue({ data: { ...editInitial, name: 'dev-agent-2' } });
  });

  it('预填 initial 三项；skills 不进表单；无改动时提交键禁用', () => {
    renderEdit();
    expect((screen.getByTestId('role-form-name') as HTMLInputElement).value).toBe('dev-agent');
    expect((screen.getByPlaceholderText(/描述（可选）/) as HTMLInputElement).value).toBe('writes code');
    // provider 触发器显示当前值
    expect(screen.getByTestId('role-form-provider').textContent).toContain('claude');
    // 表单无 skills 字段（RoleSkillsModal 是技能编辑正本）
    expect(screen.queryByText(/技能|skills/i)).toBeNull();
    expect(screen.getByTestId('create-role-submit')).toBeDisabled();
  });

  it('改名后提交 → PATCH 只带脏字段（name），onSaved 回传更新结果', async () => {
    const onSaved = vi.fn();
    renderEdit({ onSaved });
    fireEvent.change(screen.getByTestId('role-form-name'), { target: { value: 'dev-agent-2' } });
    const submit = screen.getByTestId('create-role-submit');
    expect(submit).not.toBeDisabled();
    fireEvent.click(submit);

    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledWith('p1', { name: 'dev-agent-2' }));
    await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ name: 'dev-agent-2' })));
  });

  it('清空描述 → PATCH description: null', async () => {
    renderEdit();
    fireEvent.change(screen.getByPlaceholderText(/描述（可选）/), { target: { value: ' ' } });
    fireEvent.click(screen.getByTestId('create-role-submit'));
    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledWith('p1', { description: null }));
  });

  it('改 provider → 表单内 inline 生效条件提示；提交 PATCH 只带 provider', async () => {
    renderEdit();
    expect(screen.queryByText(/重启或停用再启用后使用新 CLI/)).toBeNull();
    fireEvent.click(screen.getByTestId('role-form-provider'));
    fireEvent.click(screen.getByRole('option', { name: /kimi/ }));
    expect(await screen.findByText(/正在运行的实例将在重启或停用再启用后使用新 CLI/)).toBeDefined();
    fireEvent.click(screen.getByTestId('create-role-submit'));
    await waitFor(() => expect(mockUpdateAgent).toHaveBeenCalledWith('p1', { provider: 'kimi' }));
  });

  it('当前 provider 未检测到（如 CLI 已卸载）→ 候选补「当前」可选项，现状值不丢', () => {
    renderEdit({ initial: { ...editInitial, provider: 'openclaw' } });
    expect(screen.getByTestId('role-form-provider').textContent).toContain('openclaw');
    // 未改动 → 提交键禁用（现状值未被回退冲掉）
    expect(screen.getByTestId('create-role-submit')).toBeDisabled();
  });

  it('保存失败（409 名称冲突）→ 服务端 message 内联报错留窗', async () => {
    mockUpdateAgent.mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { error: { code: 'DUPLICATE', message: 'AgentProfile with name "taken" already exists' } } },
    });
    const onClose = vi.fn();
    renderEdit({ onClose });
    fireEvent.change(screen.getByTestId('role-form-name'), { target: { value: 'taken' } });
    fireEvent.click(screen.getByTestId('create-role-submit'));
    expect(await screen.findByText(/already exists/)).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('pending 锁存：保存中提交键禁用 + 文案「保存中…」', async () => {
    let resolveUpdate: (v: unknown) => void = () => {};
    mockUpdateAgent.mockImplementation(() => new Promise((r) => { resolveUpdate = r; }));
    renderEdit();
    fireEvent.change(screen.getByTestId('role-form-name'), { target: { value: 'dev-agent-2' } });
    fireEvent.click(screen.getByTestId('create-role-submit'));
    expect(await screen.findByText('保存中…')).toBeDefined();
    expect(screen.getByTestId('create-role-submit')).toBeDisabled();
    resolveUpdate({ data: { ...editInitial, name: 'dev-agent-2' } });
    await waitFor(() => expect(screen.queryByText('保存中…')).toBeNull());
  });

  it('系统保留角色（studio）→ name 输入禁用（服务端拒绝改名到/自 studio，正本不给入口）', () => {
    renderEdit({ initial: { id: 'p0', name: 'studio', description: '系统执行', provider: null } });
    expect((screen.getByTestId('role-form-name') as HTMLInputElement).disabled).toBe(true);
  });
});
