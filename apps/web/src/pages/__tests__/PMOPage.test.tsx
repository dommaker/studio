// AC-6: PMO UI publish button tests
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const { mockGet, mockPost, mockChannelList } = vi.hoisted(() => ({
  mockGet: vi.fn(),
  mockPost: vi.fn(),
  mockChannelList: vi.fn(),
}));

vi.mock('../../api', () => ({
  api: {
    get: mockGet,
    post: mockPost,
  },
  projectApi: {
    publish: vi.fn(),
  },
}));

vi.mock('../../api/channel', () => ({
  channelApi: {
    list: mockChannelList,
  },
}));

import { PMOPage } from '../PMOPage';
import { projectApi } from '../../api';

const mockProjects = [
  { id: 'p1', pmoNumber: 'PM-001', title: 'Pending Project', status: 'pending', progress: 0, createdAt: '2026-01-01' },
  { id: 'p2', pmoNumber: 'PM-002', title: 'Active Project', status: 'active', progress: 50, createdAt: '2026-01-02' },
];

const mockChannels = [
  { id: 'ch-1', name: '#general', type: 'rnd' },
];

describe('AC-6: PMO publish button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue({ data: { data: [] } });
    mockChannelList.mockResolvedValue({ data: { data: mockChannels } });

    // Mock the loadData Promise.all — companies, okr, project
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/companies')) return Promise.resolve({ data: { data: [{ id: 'co-1' }] } });
      if (url.includes('/pmo/okr')) return Promise.resolve({ data: { data: [] } });
      if (url.includes('/pmo/project')) return Promise.resolve({ data: { data: mockProjects } });
      return Promise.resolve({ data: { data: [] } });
    });
  });

  const renderPMO = () =>
    render(
      <MemoryRouter>
        <PMOPage companyId="co-1" />
      </MemoryRouter>
    );

  it('shows publish button for pending project', async () => {
    renderPMO();

    await waitFor(() => {
      const buttons = screen.getAllByText('发布');
      expect(buttons.length).toBeGreaterThan(0);
    });
  });

  it('does not show publish button for non-pending project', async () => {
    mockGet.mockImplementation((url: string) => {
      if (url.includes('/companies')) return Promise.resolve({ data: { data: [{ id: 'co-1' }] } });
      if (url.includes('/pmo/okr')) return Promise.resolve({ data: { data: [] } });
      if (url.includes('/pmo/project')) return Promise.resolve({
        data: { data: [mockProjects[1]] }, // only active project
      });
      return Promise.resolve({ data: { data: [] } });
    });

    renderPMO();

    await waitFor(() => {
      expect(screen.getByText('Active Project')).toBeTruthy();
    });

    expect(screen.queryAllByText('发布')).toHaveLength(0);
  });

  it('disables button when no channels available', async () => {
    mockChannelList.mockResolvedValue({ data: { data: [] } });

    renderPMO();

    await waitFor(() => {
      const btn = screen.getAllByText('发布')[0];
      expect(btn).toBeDisabled();
    });
  });
});
