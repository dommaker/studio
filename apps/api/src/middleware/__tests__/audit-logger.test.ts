/**
 * AC: audit-logger unit tests
 *
 * Covers:
 * - Login event recording (auth paths)
 * - Role change recording (roles paths)
 * - Audit log field completeness (userId, action, ipAddress, userAgent)
 * - Helper functions (getClientIP, getResourceType, getResourceId, isCriticalOperation)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response } from 'express';

// Mock log function — hoisted so vi.mock can capture it
const mockAuditLogFn = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 'log-1' }));

vi.mock('@dommaker/studio-audit', () => ({
  AuditService: vi.fn().mockImplementation(() => ({
    log: mockAuditLogFn,
  })),
}));

vi.mock('../auth.js', () => ({
  getAuthInfo: vi.fn().mockReturnValue({
    sessionId: 's-test-123',
    userId: 'u-test-456',
    anonymousId: 'anon_test_hash',
  }),
}));

vi.mock('../core/database.js', () => ({
  prisma: {},
}));

vi.mock('../../utils/logger.js', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import {
  getClientIP,
  isCriticalOperation,
  getResourceType,
  getResourceId,
  auditLogger,
  recordAuditLog,
} from '../audit-logger.js';

describe('getClientIP', () => {
  it('returns first IP from x-forwarded-for', () => {
    const req = { headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }, socket: {} } as Request;
    expect(getClientIP(req)).toBe('1.2.3.4');
  });

  it('returns x-forwarded-for when single value', () => {
    const req = { headers: { 'x-forwarded-for': '1.2.3.4' }, socket: {} } as Request;
    expect(getClientIP(req)).toBe('1.2.3.4');
  });

  it('falls back to remoteAddress when no x-forwarded-for', () => {
    const req = { headers: {}, socket: { remoteAddress: '10.0.0.1' } } as Request;
    expect(getClientIP(req)).toBe('10.0.0.1');
  });

  it('returns unknown when no IP source available', () => {
    const req = { headers: {}, socket: {} } as Request;
    expect(getClientIP(req)).toBe('unknown');
  });
});

describe('getResourceType', () => {
  it('extracts resource type from /api/v1/roles/123', () => {
    expect(getResourceType('/api/v1/roles/123')).toBe('roles');
  });

  it('extracts resource type from /api/v1/auth/login', () => {
    expect(getResourceType('/api/v1/auth/login')).toBe('auth');
  });

  it('returns unknown for short path', () => {
    expect(getResourceType('/api')).toBe('unknown');
  });
});

describe('getResourceId', () => {
  it('extracts resource ID from /api/v1/roles/abc-123', () => {
    expect(getResourceId('/api/v1/roles/abc-123')).toBe('abc-123');
  });

  it('returns undefined when no resource ID in path', () => {
    expect(getResourceId('/api/v1/roles')).toBeUndefined();
  });

  it('returns undefined for short path', () => {
    expect(getResourceId('/api/v1')).toBeUndefined();
  });
});

describe('isCriticalOperation', () => {
  it('returns true for auth paths', () => {
    const req = { method: 'POST', path: '/api/v1/auth/login' } as Request;
    expect(isCriticalOperation(req)).toBe(true);
  });

  it('returns true for roles paths', () => {
    const req = { method: 'POST', path: '/api/v1/roles/admin' } as Request;
    expect(isCriticalOperation(req)).toBe(true);
  });

  it('returns true for workflow paths', () => {
    const req = { method: 'PUT', path: '/api/v1/workflows/wf-1' } as Request;
    expect(isCriticalOperation(req)).toBe(true);
  });

  it('returns true for DELETE regardless of path', () => {
    const req = { method: 'DELETE', path: '/api/v1/health/ping' } as Request;
    expect(isCriticalOperation(req)).toBe(true);
  });

  it('returns false for non-critical paths', () => {
    const req = { method: 'GET', path: '/api/v1/health/ping' } as Request;
    expect(isCriticalOperation(req)).toBe(false);
  });

  it('returns false for GET to critical-like path without matching prefix', () => {
    const req = { method: 'GET', path: '/api/v1/other/path' } as Request;
    expect(isCriticalOperation(req)).toBe(false);
  });
});

describe('recordAuditLog', () => {
  let req: Request;
  let res: Response;
  const authInfo = { sessionId: 's1', userId: 'u1', anonymousId: 'anon1' };

  beforeEach(() => {
    vi.clearAllMocks();
    req = {
      method: 'POST',
      path: '/api/v1/auth/login',
      query: {},
      headers: {},
    } as unknown as Request;
    res = { statusCode: 200 } as Response;
  });

  it('calls auditService.log with required fields: userId, action, ipAddress, userAgent', async () => {
    await recordAuditLog(req, res, authInfo, '192.168.1.1', 'test-agent', {});

    const callArg = mockAuditLogFn.mock.calls[0][0];
    expect(callArg.userId).toBe('u1');
    expect(callArg.action).toBe('post');
    expect(callArg.ipAddress).toBe('192.168.1.1');
    expect(callArg.userAgent).toBe('test-agent');
  });

  it('sets status success when statusCode < 400', async () => {
    res.statusCode = 200;
    await recordAuditLog(req, res, authInfo, '10.0.0.1', 'agent', {});
    expect(mockAuditLogFn.mock.calls[0][0].status).toBe('success');
  });

  it('sets status failure when statusCode >= 400', async () => {
    res.statusCode = 401;
    await recordAuditLog(req, res, authInfo, '10.0.0.1', 'agent', { error: { code: 'UNAUTHORIZED', message: 'Bad' } });
    expect(mockAuditLogFn.mock.calls[0][0].status).toBe('failure');
  });

  it('includes errorCode and errorMessage on failure', async () => {
    res.statusCode = 403;
    await recordAuditLog(req, res, authInfo, '10.0.0.1', 'agent', { error: { code: 'FORBIDDEN', message: 'No access' } });
    const arg = mockAuditLogFn.mock.calls[0][0];
    expect(arg.errorCode).toBe('FORBIDDEN');
    expect(arg.errorMessage).toBe('No access');
  });

  it('includes resource and resourceId from path', async () => {
    req.path = '/api/v1/roles/r-999';
    await recordAuditLog(req, res, authInfo, '10.0.0.1', 'agent', {});
    const arg = mockAuditLogFn.mock.calls[0][0];
    expect(arg.resource).toBe('roles');
    expect(arg.resourceId).toBe('r-999');
  });

  it('includes anonymousId in details', async () => {
    await recordAuditLog(req, res, authInfo, '10.0.0.1', 'agent', {});
    const arg = mockAuditLogFn.mock.calls[0][0];
    expect(arg.details?.anonymousId).toBe('anon1');
  });
});

describe('auditLogger middleware', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: ReturnType<typeof vi.fn>;
  let jsonSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    jsonSpy = vi.fn();
    req = {
      method: 'POST',
      path: '/api/v1/auth/login',
      headers: {
        'user-agent': 'test-agent',
        'x-forwarded-for': '1.2.3.4',
      },
      query: {},
    };
    res = {
      statusCode: 200,
      json: jsonSpy,
      bind: vi.fn().mockReturnThis(),
    };
    next = vi.fn();
  });

  it('skips non-critical operations and calls next', async () => {
    req.method = 'GET';
    req.path = '/api/v1/health/ping';
    const middleware = auditLogger();
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    // res.json should not be overridden for non-critical
    expect(res.json).toBe(jsonSpy);
  });

  it('overrides res.json for critical operations', async () => {
    const middleware = auditLogger();
    await middleware(req as Request, res as Response, next);

    // res.json should have been replaced
    expect(res.json).not.toBe(jsonSpy);
    expect(next).toHaveBeenCalled();
  });

  it('records audit log when res.json is called after middleware (login event)', async () => {
    const middleware = auditLogger();
    await middleware(req as Request, res as Response, next);

    // Call the overridden res.json
    (res.json as any)({ ok: true });

    // Wait for async recordAuditLog
    await vi.waitFor(() => {
      expect(mockAuditLogFn).toHaveBeenCalled();
    });

    const arg = mockAuditLogFn.mock.calls[0][0];
    expect(arg.action).toBe('post');
    expect(arg.resource).toBe('auth');
    expect(arg.userId).toBe('u-test-456');
    expect(arg.ipAddress).toBe('1.2.3.4');
    expect(arg.userAgent).toBe('test-agent');
    // Verify the original json was called with the body
    expect(jsonSpy).toHaveBeenCalledWith({ ok: true });
  });

  it('records audit log for role change paths', async () => {
    req.path = '/api/v1/roles/admin';
    const middleware = auditLogger();
    await middleware(req as Request, res as Response, next);

    (res.json as any)({ ok: true });

    await vi.waitFor(() => {
      expect(mockAuditLogFn).toHaveBeenCalled();
    });

    const arg = mockAuditLogFn.mock.calls[0][0];
    expect(arg.resource).toBe('roles');
    expect(arg.resourceId).toBe('admin');
  });
});
