/**
 * WorkspaceStatusBar tests — P7-01 Agent status bar
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkspaceStatusBar } from '../WorkspaceStatusBar';

// Mock API
vi.mock('../../api', () => ({
  workspaceApi: {
    list: vi.fn(),
  },
}));

import { workspaceApi } from '../../api';

const mockWorkspaces = [
  {
    id: 'ws-1',
    name: '公司电脑',
    status: 'online',
    workspaceRoot: '/qunar',
    runtimes: [
      { id: 'rt-1', provider: 'claude', status: 'online', version: '1.0.0' },
      { id: 'rt-2', provider: 'codex', status: 'online', version: '0.5.0' },
    ],
    _count: { runtimes: 2 },
  },
  {
    id: 'ws-2',
    name: '个人 PC',
    status: 'offline',
    workspaceRoot: '/home',
    runtimes: [],
    _count: { runtimes: 0 },
  },
];

describe('WorkspaceStatusBar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(workspaceApi.list).mockResolvedValue({ data: { data: mockWorkspaces } });
  });

  it('renders workspace list', async () => {
    render(<WorkspaceStatusBar />);
    expect(await screen.findByText('公司电脑')).toBeInTheDocument();
    expect(screen.getByText('个人 PC')).toBeInTheDocument();
  });

  it('shows online/offline status', async () => {
    render(<WorkspaceStatusBar />);
    expect(await screen.findByText('online')).toBeInTheDocument();
    expect(screen.getByText('offline')).toBeInTheDocument();
  });

  it('shows runtime count', async () => {
    render(<WorkspaceStatusBar />);
    expect(await screen.findByText('2 runtimes')).toBeInTheDocument();
  });

  it('shows empty state when no workspaces', async () => {
    vi.mocked(workspaceApi.list).mockResolvedValue({ data: { data: [] } });
    render(<WorkspaceStatusBar />);
    expect(await screen.findByText('No workspaces connected')).toBeInTheDocument();
  });

  it('shows loading state', () => {
    vi.mocked(workspaceApi.list).mockReturnValue(new Promise(() => {}));
    render(<WorkspaceStatusBar />);
    expect(screen.getByText('Loading...')).toBeInTheDocument();
  });
});
