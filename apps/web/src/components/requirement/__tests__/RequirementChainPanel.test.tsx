/**
 * RequirementChainPanel tests — REQ 全链路面板（vision §5.3）
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { RequirementChainPanel } from '../RequirementChainPanel';
import { requirementApi, type RequirementChain } from '../../../api/requirements';

vi.mock('../../../api/requirements', () => ({
  requirementApi: { getChain: vi.fn() },
}));

beforeEach(() => vi.clearAllMocks());

const chainFixture: RequirementChain = {
  requirement: {
    id: 'REQ-0042',
    seq: 42,
    title: '忘记密码流程修复',
    status: 'in-progress',
    channelId: 'ch-1',
    createdAt: '2026-07-19T00:00:00.000Z',
    createdBy: 'human',
  },
  workunits: [
    { id: 'wu-1', title: '定位 bug', status: 'done', assigneeId: 'agent-1' },
    { id: 'wu-2', title: '编写修复', status: 'active', assigneeId: 'agent-1' },
  ],
} as unknown as RequirementChain;

describe('RequirementChainPanel', () => {
  it('renders requirement info and workunit chain from getChain', async () => {
    vi.mocked(requirementApi.getChain).mockResolvedValue({ data: { data: chainFixture } } as any);
    render(<RequirementChainPanel reqId="REQ-0042" onClose={() => {}} />);
    await waitFor(() => screen.getByText(/忘记密码流程修复/));
    expect(requirementApi.getChain).toHaveBeenCalledWith('REQ-0042');
    expect(screen.getAllByText(/REQ-0042/).length).toBeGreaterThan(0);
    expect(screen.getByText('定位 bug')).toBeTruthy();
    expect(screen.getByText('编写修复')).toBeTruthy();
  });

  it('shows error state when the chain request fails', async () => {
    vi.mocked(requirementApi.getChain).mockRejectedValue(new Error('not found'));
    render(<RequirementChainPanel reqId="REQ-9999" onClose={() => {}} />);
    await waitFor(() => screen.getByText(/失败|错误|not found/i));
  });

  it('calls onClose when the close control is clicked', async () => {
    vi.mocked(requirementApi.getChain).mockResolvedValue({ data: { data: chainFixture } } as any);
    const onClose = vi.fn();
    render(<RequirementChainPanel reqId="REQ-0042" onClose={onClose} />);
    await waitFor(() => screen.getByText(/忘记密码流程修复/));
    const btn = screen.getByRole('button', { name: /✕/ });
    fireEvent.click(btn);
    expect(onClose).toHaveBeenCalled();
  });

  it('does not fetch when reqId is null', () => {
    render(<RequirementChainPanel reqId={null} onClose={() => {}} />);
    expect(requirementApi.getChain).not.toHaveBeenCalled();
  });
});
