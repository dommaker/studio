/**
 * TokenManager tests — P7-03 Token management UI
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TokenManager } from '../TokenManager';

vi.mock('../../api', () => ({
  workspaceTokenApi: {
    list: vi.fn(),
    revoke: vi.fn(),
  },
}));

import { workspaceTokenApi } from '../../api';

const mockTokens = [
  { id: 'tok-1', name: '公司电脑', createdAt: '2026-06-01T10:00:00Z' },
  { id: 'tok-2', name: '个人 PC', createdAt: '2026-06-02T08:00:00Z' },
];

describe('TokenManager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (workspaceTokenApi.list as any).mockResolvedValue({ data: { data: mockTokens } });
  });

  it('renders token list', async () => {
    render(<TokenManager />);
    expect(await screen.findByText('公司电脑')).toBeInTheDocument();
    expect(screen.getByText('个人 PC')).toBeInTheDocument();
  });

  it('shows revoke button for each token', async () => {
    render(<TokenManager />);
    await screen.findByText('公司电脑');
    const revokeButtons = screen.getAllByRole('button', { name: /revoke/i });
    expect(revokeButtons).toHaveLength(2);
  });

  it('revokes token on confirm', async () => {
    (workspaceTokenApi.revoke as any).mockResolvedValue({});
    render(<TokenManager />);
    await screen.findByText('公司电脑');

    fireEvent.click(screen.getAllByRole('button', { name: /revoke/i })[0]);

    await waitFor(() => {
      expect(workspaceTokenApi.revoke).toHaveBeenCalledWith('tok-1');
    });
  });

  it('removes revoked token from list', async () => {
    (workspaceTokenApi.revoke as any).mockResolvedValue({});
    render(<TokenManager />);
    await screen.findByText('公司电脑');

    fireEvent.click(screen.getAllByRole('button', { name: /revoke/i })[0]);

    await waitFor(() => {
      expect(screen.queryByText('公司电脑')).not.toBeInTheDocument();
    });
    expect(screen.getByText('个人 PC')).toBeInTheDocument();
  });

  it('shows empty state when no tokens', async () => {
    (workspaceTokenApi.list as any).mockResolvedValue({ data: { data: [] } });
    render(<TokenManager />);
    expect(await screen.findByText(/no tokens/i)).toBeInTheDocument();
  });
});
