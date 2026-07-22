import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TreeTokenDrawer } from '../TreeTokenDrawer';

vi.mock('../../../api/workunit', () => ({
  workunitApi: {
    getTreeTokens: vi.fn(),
  },
}));

import { workunitApi } from '../../../api/workunit';

const mockReport = {
  rootId: 'wu-root',
  nodes: [
    {
      workUnitId: 'wu-root-xxxxxxxx',
      profileName: 'Analyst',
      status: 'done',
      injectedTokens: 5000,
      executionTokens: 10000,
      totalTokens: 15000,
    },
    {
      workUnitId: 'wu-child-yyyyyyyy',
      profileName: 'Reviewer',
      status: 'active',
      injectedTokens: 2000,
      executionTokens: 3000,
      totalTokens: 5000,
    },
  ],
  rootTotal: 20000,
  budgetRemaining: 80000,
};

describe('TreeTokenDrawer (AC-5.4 ~ AC-5.7)', () => {
  const mockOnClose = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders loading state initially', () => {
    (workunitApi.getTreeTokens as any).mockReturnValue(new Promise(() => {}));
    render(<TreeTokenDrawer workUnitId="wu-root" onClose={mockOnClose} />);
    expect(screen.getByText('加载中...')).toBeTruthy();
  });

  it('renders report on success', async () => {
    (workunitApi.getTreeTokens as any).mockResolvedValue(mockReport);
    render(<TreeTokenDrawer workUnitId="wu-root" onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText('20.0k')).toBeTruthy();
    });
    expect(screen.getByText('80.0k')).toBeTruthy();
    // first node has 5.0k (inj), 10.0k (exec), 15.0k (total)
    expect(screen.getByText('10.0k')).toBeTruthy();
    const fives = screen.getAllByText('5.0k');
    expect(fives).toHaveLength(2); // node1 injected + node2 total
    expect(screen.getByText('15.0k')).toBeTruthy();
    // row data
    expect(screen.getByText('Analyst')).toBeTruthy();
    expect(screen.getByText('Reviewer')).toBeTruthy();
  });

  it('renders error on API failure', async () => {
    (workunitApi.getTreeTokens as any).mockRejectedValue(new Error('Network error'));
    render(<TreeTokenDrawer workUnitId="wu-root" onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText('加载失败: Network error')).toBeTruthy();
    });
  });

  it('renders hyphen for null tokens', async () => {
    (workunitApi.getTreeTokens as any).mockResolvedValue({
      rootId: 'wu-root',
      nodes: [
        {
          workUnitId: 'wu-null-xxxxxxxx',
          profileName: null,
          status: 'pending',
          injectedTokens: null,
          executionTokens: null,
          totalTokens: null,
        },
      ],
      rootTotal: 0,
      budgetRemaining: 100000,
    });
    render(<TreeTokenDrawer workUnitId="wu-root" onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getAllByText('-')).toHaveLength(4); // profileName + 3 null tokens
    });
  });

  it('calls onClose when close button clicked', async () => {
    (workunitApi.getTreeTokens as any).mockResolvedValue(mockReport);
    render(<TreeTokenDrawer workUnitId="wu-root" onClose={mockOnClose} />);

    await waitFor(() => {
      expect(screen.getByText('20.0k')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: '关闭' }));
    expect(mockOnClose).toHaveBeenCalledTimes(1);
  });

  it('cancels effect on unmount (no state update after unmount)', async () => {
    (workunitApi.getTreeTokens as any).mockImplementation(
      () => new Promise((resolve) => setTimeout(() => resolve(mockReport), 100))
    );
    const { unmount } = render(
      <TreeTokenDrawer workUnitId="wu-root" onClose={mockOnClose} />
    );
    unmount();
    // should not throw — cleanup avoided setState on unmounted component
  });
});
