// Contract test: WorkUnit API client — MVP-3 + MVP-4
import { describe, it, expect, vi } from 'vitest';

vi.mock('../index', () => ({
  api: {
    get: vi.fn().mockResolvedValue({ data: {} }),
    post: vi.fn().mockResolvedValue({ data: {} }),
    put: vi.fn().mockResolvedValue({ data: {} }),
    delete: vi.fn().mockResolvedValue({ data: {} }),
  },
}));

import { workunitApi } from '../workunit';
import { api } from '../index';

describe('workunitApi', () => {
  it('reviewRejected passes reason param', async () => {
    await workunitApi.reviewRejected('wu-1', 'quality issue');
    expect(api.post).toHaveBeenCalledWith('/workunits/wu-1/review-rejected', { reason: 'quality issue' });
  });

  it('reviewRejected works without reason', async () => {
    await workunitApi.reviewRejected('wu-1');
    expect(api.post).toHaveBeenCalledWith('/workunits/wu-1/review-rejected', { reason: undefined });
  });

  it('getMessages calls correct endpoint', async () => {
    await workunitApi.getMessages('wu-1', { limit: 10 });
    expect(api.get).toHaveBeenCalledWith('/workunits/wu-1/messages', { params: { limit: 10 } });
  });

  it('postMessage passes content and authorType', async () => {
    await workunitApi.postMessage('wu-1', 'hello', 'human');
    expect(api.post).toHaveBeenCalledWith('/workunits/wu-1/messages', { content: 'hello', authorType: 'human' });
  });
});
