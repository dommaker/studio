/**
 * AC1.4: middleware-invocation test
 *
 * Verifies:
 * - requireAuth() returns a function (middleware), not the factory itself
 * - optionalAuth() returns a function (middleware), not the factory itself
 * - Express mock: next() is called when middleware runs
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';

// Mock dependencies that requireAuth/optionalAuth use internally
vi.mock('../../../modules/auth/service.js', () => ({
  verifyToken: vi.fn().mockReturnValue({ sessionId: 's1', userId: 'u1' }),
}));

const mockReadJson = vi.hoisted(() => vi.fn());
const mockWriteJson = vi.hoisted(() => vi.fn());

vi.mock('@dommaker/studio-shared', () => ({
  FileStore: vi.fn().mockImplementation(() => ({
    readJson: mockReadJson,
    writeJson: mockWriteJson,
  })),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { requireAuth, optionalAuth, requireRole } from '../../../middleware/auth.js';

describe('middleware-invocation', () => {
  const OLD_AUTH = process.env.STUDIO_AUTH;

  beforeEach(() => {
    process.env.STUDIO_AUTH = 'required';
  });

  afterEach(() => {
    process.env.STUDIO_AUTH = OLD_AUTH;
  });
  describe('requireAuth', () => {
    it('requireAuth() returns a function, not the factory', () => {
      const middleware = requireAuth();
      expect(typeof middleware).toBe('function');
    });

    it('returned middleware calls next() when valid token provided', async () => {
      const middleware = requireAuth();
      const req = {
        headers: { authorization: 'Bearer test-token' },
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;
      const next = vi.fn() as NextFunction;

      // findSessionWithUser: session readJson → user readJson
      mockReadJson.mockResolvedValueOnce({ id: 's1', userId: 'u1', expiresAt: new Date(Date.now() + 86400000).toISOString() });
      mockReadJson.mockResolvedValueOnce({ id: 'u1', email: 'test@test.com', role: 'User' });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('returned middleware returns 401 when no token provided', async () => {
      const middleware = requireAuth();
      const req = {
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;
      const next = vi.fn() as NextFunction;

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(next).not.toHaveBeenCalled();
    });
  });

  describe('requireRole', () => {
    it('returns 403 when user role does not match', async () => {
      const middleware = requireRole('Admin');
      const req = {
        headers: { authorization: 'Bearer test-token' },
        socket: { remoteAddress: '127.0.0.1' },
        session: { id: 's1', userId: 'u1' },
        user: { id: 'u1', role: 'User' },
      } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;
      const next = vi.fn() as NextFunction;

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(403);
      expect(next).not.toHaveBeenCalled();
    });

    it('calls next() when user role matches', async () => {
      const middleware = requireRole('Admin');
      const req = {
        headers: { authorization: 'Bearer test-token' },
        socket: { remoteAddress: '127.0.0.1' },
        session: { id: 's1', userId: 'u1' },
        user: { id: 'u1', role: 'Admin' },
      } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;
      const next = vi.fn() as NextFunction;

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe('optionalAuth', () => {
    it('optionalAuth() returns a function, not the factory', () => {
      const middleware = optionalAuth();
      expect(typeof middleware).toBe('function');
    });

    it('returned middleware calls next() even without token', async () => {
      const middleware = optionalAuth();
      const req = {
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;
      const next = vi.fn() as NextFunction;

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it('returned middleware calls next() with valid token', async () => {
      const middleware = optionalAuth();
      const req = {
        headers: { authorization: 'Bearer test-token' },
        socket: { remoteAddress: '127.0.0.1' },
      } as unknown as Request;
      const res = {
        status: vi.fn().mockReturnThis(),
        json: vi.fn(),
      } as unknown as Response;
      const next = vi.fn() as NextFunction;

      // findSessionWithUser: session readJson → user readJson
      mockReadJson.mockResolvedValueOnce({ id: 's1', userId: 'u1', expiresAt: new Date(Date.now() + 86400000).toISOString() });
      mockReadJson.mockResolvedValueOnce({ id: 'u1', email: 'test@test.com', role: 'User' });

      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });
});
