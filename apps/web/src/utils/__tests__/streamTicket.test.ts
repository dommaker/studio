import { describe, expect, it, vi } from 'vitest';

const post = vi.hoisted(() => vi.fn());
vi.mock('../../api/client', () => ({ api: { post } }));

import { fetchStreamTicket } from '../streamTicket';

describe('fetchStreamTicket', () => {
  it('exchanges the authenticated API client for a resource-bound ticket', async () => {
    post.mockResolvedValue({ data: { data: { token: 'short-ticket', expiresIn: 60 } } });
    await expect(fetchStreamTicket('/api/v1/events/stream')).resolves.toBe('short-ticket');
    expect(post).toHaveBeenCalledWith('/auth/stream-ticket', { resource: '/api/v1/events/stream' });
  });
});
