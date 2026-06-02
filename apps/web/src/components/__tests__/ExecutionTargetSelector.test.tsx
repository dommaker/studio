/**
 * ExecutionTargetSelector tests — P8-02 Execution target selection
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ExecutionTargetSelector } from '../ExecutionTargetSelector';

vi.mock('../../api', () => ({
  workspaceApi: {
    list: vi.fn(),
    discover: vi.fn(),
  },
}));

import { workspaceApi } from '../../api';

const mockWorkspaces = [
  { id: 'ws-1', name: '公司电脑', status: 'online', runtimes: [], _count: { runtimes: 0 } },
  { id: 'ws-2', name: '个人 PC', status: 'offline', runtimes: [], _count: { runtimes: 0 } },
];

const mockEntries = [
  { path: 'project-a', type: 'git-repo', lastModified: '2026-06-01' },
];

describe('ExecutionTargetSelector', () => {
  const mockOnSelect = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (workspaceApi.list as any).mockResolvedValue({ data: { data: mockWorkspaces } });
    (workspaceApi.discover as any).mockResolvedValue({ data: { data: mockEntries } });
  });

  it('renders workspace list', async () => {
    render(<ExecutionTargetSelector onSelect={mockOnSelect} />);
    expect(await screen.findByText('公司电脑')).toBeInTheDocument();
    expect(screen.getByText('个人 PC')).toBeInTheDocument();
  });

  it('selects workspace and shows path browser', async () => {
    render(<ExecutionTargetSelector onSelect={mockOnSelect} />);
    await screen.findByText('公司电脑');
    fireEvent.click(screen.getByText('公司电脑'));

    await waitFor(() => {
      expect(workspaceApi.discover).toHaveBeenCalledWith('ws-1', '');
    });
  });

  it('calls onSelect with target path', async () => {
    (workspaceApi.discover as any)
      .mockResolvedValueOnce({ data: { data: mockEntries } })
      .mockResolvedValueOnce({ data: { data: [] } });

    render(<ExecutionTargetSelector onSelect={mockOnSelect} />);
    await screen.findByText('公司电脑');
    fireEvent.click(screen.getByText('公司电脑'));
    await screen.findByText('project-a');
    fireEvent.click(screen.getByText('project-a'));

    await waitFor(() => {
      expect(mockOnSelect).toHaveBeenCalledWith(expect.stringContaining('project-a'));
    });
  });
});
