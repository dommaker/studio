import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

const logger = vi.hoisted(() => ({ error: vi.fn() }));
vi.mock('../../utils/logger.js', () => ({ logger }));

import { errorHandler } from '../error-handler.js';

describe('errorHandler credential logging', () => {
  it('redacts request and nested Error.config credentials before writing application error logs', () => {
    const req = {
      method: 'POST', path: '/api/v1/example', headers: {},
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

  it('production 5xx returns only a generic message and requestId while retaining redacted log details', () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    logger.error.mockClear();
    try {
      const req = {
        method: 'GET', path: '/api/v1/example', headers: { 'x-request-id': 'req-sec09-global' },
        body: { authorization: 'Bearer request-secret' }, query: {},
      } as unknown as Request;
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
      const error = Object.assign(new Error('SEC09_INTERNAL_MARKER'), {
        config: { headers: { authorization: 'Bearer error-secret' } },
      });

      errorHandler(error, req, res, vi.fn() as NextFunction);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: { code: 'INTERNAL_ERROR', message: 'Internal server error', requestId: 'req-sec09-global' },
      });
      expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('SEC09_INTERNAL_MARKER');
      expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({
        requestId: 'req-sec09-global',
        error: expect.objectContaining({
          message: 'SEC09_INTERNAL_MARKER',
          config: { headers: { authorization: '[REDACTED]' } },
        }),
      }), 'Unhandled error');
      expect((req as any).requestId).toBe('req-sec09-global');
    } finally {
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
    }
  });

  it('production 4xx retains its existing code and detailed validation message', () => {
    const previousEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const req = { method: 'POST', path: '/api/v1/example', headers: {}, body: {}, query: {} } as unknown as Request;
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as unknown as Response;
      const error = Object.assign(new Error('Invalid workspace name'), { status: 422, code: 'VALIDATION_FAILED' });

      errorHandler(error, req, res, vi.fn() as NextFunction);

      expect(res.status).toHaveBeenCalledWith(422);
      expect(res.json).toHaveBeenCalledWith({
        error: { code: 'VALIDATION_FAILED', message: 'Invalid workspace name' },
      });
    } finally {
      if (previousEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousEnv;
    }
  });
});
