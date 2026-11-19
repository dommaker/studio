import { describe, expect, it, vi, afterEach } from 'vitest';
import type { Request, Response } from 'express';
import { localNetworkGuard } from '../local-network.js';

function invoke(host: string | undefined, origin?: string) {
  const req = { headers: { host, ...(origin === undefined ? {} : { origin }) } } as unknown as Request;
  const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
  const next = vi.fn();
  localNetworkGuard(req, res, next);
  return { res, next };
}

afterEach(() => {
  delete process.env.STUDIO_AUTH;
});

describe('localNetworkGuard', () => {
  it.each([
    ['127.0.0.1:3001', undefined],
    ['localhost:3001', undefined],
    ['[::1]:3001', undefined],
    ['127.0.0.1', 'http://127.0.0.1:3001'],
    ['localhost', 'https://localhost'],
  ])('allows a local browser or CLI request: Host=%s Origin=%s', (host, origin) => {
    process.env.STUDIO_AUTH = 'none';
    const { res, next } = invoke(host, origin);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, undefined],
    ['example.test', undefined],
    ['127.0.0.1.example.test', undefined],
    ['127.0.0.1:3001', 'https://example.test'],
    ['127.0.0.1:3001', 'null'],
    ['127.0.0.1:3001', 'not-a-url'],
  ])('denies an untrusted browser origin without calling the route: Host=%s Origin=%s', (host, origin) => {
    process.env.STUDIO_AUTH = 'none';
    const { res, next } = invoke(host, origin);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('does not add Host requirements to authenticated deployments', () => {
    process.env.STUDIO_AUTH = 'on';
    const { next } = invoke('studio.example.test', 'https://studio.example.test');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
