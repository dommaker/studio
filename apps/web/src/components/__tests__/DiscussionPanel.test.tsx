// Contract test: DiscussionPanel — MVP-4
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return { ...actual, default: actual };
});

vi.mock('../../api/workunit', () => ({
  workunitApi: {
    getMessages: vi.fn().mockResolvedValue({ data: { data: [] } }),
    postMessage: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { DiscussionPanel } from '../DiscussionPanel';

describe('DiscussionPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders discussion panel title', () => {
    render(<DiscussionPanel workUnitId="wu-1" />);
    expect(screen.getByText('讨论空间')).toBeDefined();
  });

  it('shows empty state when no messages', async () => {
    render(<DiscussionPanel workUnitId="wu-1" />);
    expect(await screen.findByText('暂无消息')).toBeDefined();
  });

  it('renders input field for sending messages', () => {
    render(<DiscussionPanel workUnitId="wu-1" />);
    expect(screen.getByPlaceholderText('输入消息...')).toBeDefined();
  });
});
