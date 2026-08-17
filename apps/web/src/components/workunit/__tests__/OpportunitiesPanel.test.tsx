// #163 T8-E2: OpportunitiesPanel — 巡检机会清单（三态渲染 / 采纳 / 忽略 / prompt 取消）
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// React 19 CJS interop: `act` is an ESM-only named export（与 ManualTaskButton.test.tsx 同款 polyfill）
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, default: actual };
});

const { mockAdopt, mockIgnore, mockSuccess, mockError } = vi.hoisted(() => ({
  mockAdopt: vi.fn(),
  mockIgnore: vi.fn(),
  mockSuccess: vi.fn(),
  mockError: vi.fn(),
}));

vi.mock('../../../api/workunit', () => ({
  workunitApi: { adoptOpportunity: mockAdopt, ignoreOpportunity: mockIgnore },
}));
vi.mock('../../../utils/toast', () => ({
  toast: { success: mockSuccess, error: mockError },
}));

import { OpportunitiesPanel } from '../OpportunitiesPanel';
import type { Opportunity } from '../../../api/workunit';

const threeOpps: Opportunity[] = [
  { id: 'opp-1', problem: '构建脚本重复跑两遍', suggestion: '合并为单次构建', estimate: '半天', status: 'pending' },
  { id: 'opp-2', problem: '测试覆盖缺口', suggestion: '补边界用例', status: 'adopted', wuId: 'wu-abcdef123456' },
  { id: 'opp-3', problem: '文档过期', suggestion: '重写 README', status: 'ignored', ignoreReason: '下季度统一处理' },
];

describe('OpportunitiesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAdopt.mockResolvedValue({ data: { workUnit: {}, opportunities: [] } });
    mockIgnore.mockResolvedValue({ data: { opportunities: [] } });
  });

  it('三态条目齐备：pending 有采纳/忽略按钮，adopted 显示已开单+短码，ignored 显示已忽略+理由', () => {
    render(<OpportunitiesPanel workUnitId="wu-1" opportunities={threeOpps} onChanged={vi.fn()} />);

    // 内容
    expect(screen.getByText('构建脚本重复跑两遍')).toBeInTheDocument();
    expect(screen.getByText('建议：合并为单次构建')).toBeInTheDocument();
    expect(screen.getByText('预估：半天')).toBeInTheDocument();
    // pending：两个按钮
    expect(screen.getByRole('button', { name: '采纳' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '忽略' })).toBeInTheDocument();
    // adopted：已开单 + wuId 前 8 位
    expect(screen.getByText('已开单 wu-abcde')).toBeInTheDocument();
    // ignored：已忽略 + 理由
    expect(screen.getByText('已忽略：下季度统一处理')).toBeInTheDocument();
  });

  it('点采纳 → 调 adoptOpportunity(wuId, oppId) 并触发 onChanged；处理中按钮禁用', async () => {
    let resolveAdopt!: (v: unknown) => void;
    mockAdopt.mockReturnValue(new Promise(res => { resolveAdopt = res; }));
    const onChanged = vi.fn();
    render(<OpportunitiesPanel workUnitId="wu-1" opportunities={threeOpps} onChanged={onChanged} />);

    const btn = screen.getByRole('button', { name: '采纳' });
    fireEvent.click(btn);
    expect(mockAdopt).toHaveBeenCalledWith('wu-1', 'opp-1');
    // loading 态防重复点击
    expect(screen.getByRole('button', { name: '处理中…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '处理中…' }));
    expect(mockAdopt).toHaveBeenCalledTimes(1);

    resolveAdopt({ data: { workUnit: {}, opportunities: [] } });
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(mockSuccess).toHaveBeenCalledWith('已采纳，跟进工单已创建');
  });

  it('点忽略填理由 → 调 ignoreOpportunity(wuId, oppId, reason) 并触发 onChanged', async () => {
    vi.spyOn(window, 'prompt').mockReturnValue('与现有计划重复');
    const onChanged = vi.fn();
    render(<OpportunitiesPanel workUnitId="wu-1" opportunities={threeOpps} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: '忽略' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
    expect(mockIgnore).toHaveBeenCalledWith('wu-1', 'opp-1', '与现有计划重复');
    expect(mockSuccess).toHaveBeenCalledWith('已忽略');
  });

  it('忽略理由留空 → reason 传 undefined；prompt 取消 → 不调用接口', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('');
    const onChanged = vi.fn();
    render(<OpportunitiesPanel workUnitId="wu-1" opportunities={threeOpps} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: '忽略' }));
    await waitFor(() => expect(mockIgnore).toHaveBeenCalledWith('wu-1', 'opp-1', undefined));

    // 取消（prompt 返回 null）→ 完全不动
    mockIgnore.mockClear();
    onChanged.mockClear();
    promptSpy.mockReturnValue(null);
    fireEvent.click(screen.getByRole('button', { name: '忽略' }));
    expect(mockIgnore).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });
});
