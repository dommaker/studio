import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const logger = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({ logger }));

import { errorHandler } from '../error-handler.js';

describe('errorHandler credential logging', () => {
  it('redacts request and nested Error.config credentials before writing application error logs', () => {
    const req = {
      method: 'POST', path: '/api/v1/example',
      body: { authorization: 'Bearer body-secret', nested: { refreshToken: 'refresh-secret' } },
      query: { token: 'query-secret', access_token: 'access-secret' },
    } as unknown as Request;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
    const error = Object.assign(new Error('failure'), {
      config: { headers: { authorization: 'Bearer error-secret' }, query: { access_token: 'error-query-secret' } },
    });
    errorHandler(error, req, res, vi.fn() as NextFunction);
    const entry = logger.error.mock.calls[0][0];
    expect(entry.body).toEqual({ authorization: '[REDACTED]', nested: { refreshToken: '[REDACTED]' } });
    expect(entry.query).toEqual({ token: '[REDACTED]', access_token: '[REDACTED]' });
    expect(entry.error.config).toEqual({ headers: { authorization: '[REDACTED]' }, query: { access_token: '[REDACTED]' } });
    expect(JSON.stringify(entry)).not.toContain('secret');
  });
});
