/**
 * Registration tests — registerWorkspace HTTP client
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { registerWorkspace, type RegistrationPayload } from '../registration.js';
import type { WorkspaceConfig } from '../workspace-config.js';

const fetchMock = vi.fn();
vi.stubGlobal('fetch', fetchMock);

function makeConfig(overrides?: Partial<WorkspaceConfig>): WorkspaceConfig {
  return {
    name: 'test-workspace',
    serverUrl: 'http://localhost:3000',
    token: 'st_mach_testtoken123',
    workspaceRoot: '/tmp/test',
    hasDocker: false,
    os: 'linux',
    arch: 'x64',
    ...overrides,
  };
}

const runtimes = [
  { provider: 'claude', version: '1.0.0' },
  { provider: 'codex', version: '0.5.0' },
];

describe('registerWorkspace', () => {
  beforeEach(() => {
    fetchMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sends POST to /api/v1/workspaces/register', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ workspaceId: 'ws-123' }),
    });

    await registerWorkspace(makeConfig(), runtimes);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/v1/workspaces/register');
    expect(opts.method).toBe('POST');
  });

  it('sends token in Authorization header', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ workspaceId: 'ws-1' }),
    });

    await registerWorkspace(makeConfig({ token: 'st_mach_secret' }), runtimes);

    const [, opts] = fetchMock.mock.calls[0];
    expect(opts.headers.Authorization).toBe('Bearer st_mach_secret');
  });

  it('includes payload fields', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ workspaceId: 'ws-1' }),
    });

    const config = makeConfig({ name: 'my-ws', workspaceRoot: '/home/user/project' });
    await registerWorkspace(config, runtimes);

    const [, opts] = fetchMock.mock.calls[0];
    const payload: RegistrationPayload = JSON.parse(opts.body);
    expect(payload.name).toBe('my-ws');
    expect(payload.workspaceRoot).toBe('/home/user/project');
    expect(payload.runtimes).toEqual(runtimes);
    expect(payload.os).toBe('linux');
    expect(payload.arch).toBe('x64');
  });

  it('returns success with workspaceId', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ workspaceId: 'ws-abc' }),
    });

    const result = await registerWorkspace(makeConfig(), runtimes);
    expect(result).toEqual({ success: true, workspaceId: 'ws-abc' });
  });

  it('falls back to id field if workspaceId missing', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'ws-fallback' }),
    });

    const result = await registerWorkspace(makeConfig(), runtimes);
    expect(result.workspaceId).toBe('ws-fallback');
  });

  it('returns error on non-ok response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => 'Unauthorized',
    });

    const result = await registerWorkspace(makeConfig(), runtimes);
    expect(result.success).toBe(false);
    expect(result.error).toContain('401');
    expect(result.error).toContain('Unauthorized');
  });

  it('returns error on network failure', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const result = await registerWorkspace(makeConfig(), runtimes);
    expect(result.success).toBe(false);
    expect(result.error).toContain('ECONNREFUSED');
  });

  it('strips trailing slash from serverUrl', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ workspaceId: 'ws-1' }),
    });

    await registerWorkspace(makeConfig({ serverUrl: 'http://localhost:3000/' }), runtimes);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:3000/api/v1/workspaces/register');
  });
});
