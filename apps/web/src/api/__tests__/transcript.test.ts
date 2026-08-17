// Contract test: Transcript API client — #174 WU transcript 只读查看（#60 C5）
import { describe, it, expect, vi } from 'vitest';

vi.mock('../index', () => ({
  api: { get: vi.fn().mockResolvedValue({ data: {} }) },
}));

import { transcriptsApi } from '../transcript';
import { api } from '../index';

describe('transcriptsApi', () => {
  it('get calls GET /transcripts/:workUnitId with pagination params', async () => {
    await transcriptsApi.get('WU-42', { offset: 20, limit: 20 });
    expect(api.get).toHaveBeenCalledWith('/transcripts/WU-42', { params: { offset: 20, limit: 20 } });
  });

  it('get omits params when not given', async () => {
    await transcriptsApi.get('WU-7');
    expect(api.get).toHaveBeenCalledWith('/transcripts/WU-7', { params: undefined });
  });

  it('get URL-encodes workUnitId', async () => {
    await transcriptsApi.get('WU/a b');
    expect(api.get).toHaveBeenCalledWith('/transcripts/WU%2Fa%20b', { params: undefined });
  });
});
