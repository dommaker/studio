/**
 * DelegateCard tests - AC-5.7 delegate 卡片树开销显示
 * 覆盖：正常加载树开销、loading 状态、API 失败容错、零开销默认值
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { DelegateCard } from '../DelegateCard';

vi.mock('../../../api/workunit', () => ({
  workunitApi: {
    getTreeTokens: vi.fn(),
  },
}));

import { workunitApi } from '../../../api/workunit';

describe('DelegateCard (AC-5.7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state initially', () => {
    (workunitApi.getTreeTokens as any).mockReturnValue(new Promise(() => {}));
    render(<DelegateCard workUnitId="wu-1" />);
    expect(screen.getByText('加载中...')).toBeTruthy();
  });

  it('renders tree cost at card bottom on success', async () => {
    (workunitApi.getTreeTokens as any).mockResolvedValue({
      data: {
        rootId: 'wu-1',
        nodes: [],
        rootTotal: 12345,
        budgetRemaining: 387655,
      },
    });
    render(<DelegateCard workUnitId="wu-1" />);

    await waitFor(() => {
      expect(screen.getByText(/树开销.*12345.*400000.*tokens/)).toBeTruthy();
    });
  });

  it('renders zero cost when no token data', async () => {
    (workunitApi.getTreeTokens as any).mockResolvedValue({
      data: {
        rootId: 'wu-1',
        nodes: [],
        rootTotal: 0,
        budgetRemaining: 400000,
      },
    });
    render(<DelegateCard workUnitId="wu-1" />);

    await waitFor(() => {
      expect(screen.getByText(/树开销.*0.*400000.*tokens/)).toBeTruthy();
    });
  });

  it('renders error message on API failure', async () => {
    (workunitApi.getTreeTokens as any).mockRejectedValue(new Error('Network error'));
    render(<DelegateCard workUnitId="wu-1" />);

    await waitFor(() => {
      expect(screen.getByText(/加载失败/)).toBeTruthy();
    });
  });
});
