// Contract test: WorkUnitListPage — MVP-1 + MVP-3 + MVP-4
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, default: actual };
});

vi.mock('react-router-dom', () => ({
  Link: ({ children, to }: { children: React.ReactNode; to: string }) => React.createElement('a', { href: to }, children),
}));

vi.mock('../../stores/workunitStore', () => ({
  useWorkUnitStore: Object.assign(
    () => ({
      workunits: [],
      total: 0,
      loading: false,
      error: null,
      loadWorkUnits: vi.fn(),
      reviewPassed: vi.fn(),
      reviewRejected: vi.fn(),
    }),
    { getState: vi.fn().mockReturnValue({ workunits: [], total: 0, loading: false, error: null, loadWorkUnits: vi.fn() }) }
  ),
}));

import { WorkUnitListPage } from '../WorkUnitListPage';

describe('WorkUnitListPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders page title', () => {
    render(<WorkUnitListPage />);
    expect(screen.getByText('WorkUnit')).toBeDefined();
  });

  it('renders create toggle button', () => {
    render(<WorkUnitListPage />);
    expect(screen.getByText('+ 新建')).toBeDefined();
  });

  it('shows empty state when no workunits', () => {
    render(<WorkUnitListPage />);
    expect(screen.getByText('暂无 WorkUnit')).toBeDefined();
  });
});
