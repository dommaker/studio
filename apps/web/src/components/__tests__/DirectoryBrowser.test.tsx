/**
 * DirectoryBrowser tests — P8-01 Directory browser component
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DirectoryBrowser } from '../DirectoryBrowser';

vi.mock('../../api', () => ({
  workspaceApi: {
    discover: vi.fn(),
  },
}));

import { workspaceApi } from '../../api';

const mockEntries = [
  { path: 'project-a', type: 'git-repo', lastModified: '2026-06-01T10:00:00Z' },
  { path: 'project-b', type: 'directory', lastModified: '2026-05-28T15:00:00Z' },
];

describe('DirectoryBrowser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (workspaceApi.discover as any).mockResolvedValue({ data: { data: mockEntries } });
  });

  it('renders entry list', async () => {
    render(<DirectoryBrowser workspaceId="ws-1" />);
    expect(await screen.findByText('project-a')).toBeInTheDocument();
    expect(screen.getByText('project-b')).toBeInTheDocument();
  });

  it('shows entry type', async () => {
    render(<DirectoryBrowser workspaceId="ws-1" />);
    await screen.findByText('project-a');
    expect(screen.getByText('git-repo')).toBeInTheDocument();
    expect(screen.getByText('directory')).toBeInTheDocument();
  });

  it('navigates into subdirectory on click', async () => {
    render(<DirectoryBrowser workspaceId="ws-1" />);
    await screen.findByText('project-a');

    fireEvent.click(screen.getByText('project-a'));

    await waitFor(() => {
      expect(workspaceApi.discover).toHaveBeenCalledWith('ws-1', 'project-a');
    });
  });

  it('shows breadcrumb path', async () => {
    (workspaceApi.discover as any)
      .mockResolvedValueOnce({ data: { data: mockEntries } })
      .mockResolvedValueOnce({ data: { data: [{ path: 'src', type: 'directory', lastModified: '2026-06-01' }] } });

    render(<DirectoryBrowser workspaceId="ws-1" />);
    await screen.findByText('project-a');
    fireEvent.click(screen.getByText('project-a'));

    await waitFor(() => {
      expect(screen.getByText(/project-a/)).toBeInTheDocument();
    });
  });

  it('shows empty state when no entries', async () => {
    (workspaceApi.discover as any).mockResolvedValue({ data: { data: [] } });
    render(<DirectoryBrowser workspaceId="ws-1" />);
    expect(await screen.findByText(/empty/i)).toBeInTheDocument();
  });
});
