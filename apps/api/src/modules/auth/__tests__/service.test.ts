/**
 * Auth service contract tests
 *
 * Verifies:
 * - createGuestSession creates session with token
 * - login authenticates user and returns session
 * - register creates user and returns session
 * - verifyToken decodes JWT
 * - generateRefreshToken / exchangeRefreshToken / revokeRefreshToken
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const TEST_PW = `test-pw-${Date.now()}`;

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    session: {
      create: vi.fn(),
      update: vi.fn(),
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      deleteMany: vi.fn(),
    },
    refreshToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { prisma } from '@dommaker/studio-prisma';
import {
  createGuestSession,
  login,
  register,
  verifyToken,
  generateRefreshToken,
  exchangeRefreshToken,
  revokeRefreshToken,
  getCurrentUser,
  logout,
} from '../service.js';

describe('auth service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('createGuestSession', () => {
    it('creates session and returns token', async () => {
      vi.mocked(prisma.session.create).mockResolvedValue({
        id: 'session-1',
        token: '',
        guestId: 'guest-1',
        expiresAt: new Date(Date.now() + 86400000),
      } as any);
      vi.mocked(prisma.session.update).mockResolvedValue({} as any);

      const result = await createGuestSession({ guestId: 'guest-1' });

      expect(result.token).toBeDefined();
      expect(result.session.id).toBe('session-1');
      expect(prisma.session.create).toHaveBeenCalled();
    });

    it('generates guestId if not provided', async () => {
      vi.mocked(prisma.session.create).mockResolvedValue({
        id: 'session-2',
        token: '',
        expiresAt: new Date(Date.now() + 86400000),
      } as any);
      vi.mocked(prisma.session.update).mockResolvedValue({} as any);

      const result = await createGuestSession({});

      expect(result.token).toBeDefined();
      expect(prisma.session.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            guestId: expect.any(String),
          }),
        })
      );
    });
  });

  describe('login', () => {
    it('throws if user not found', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

      await expect(login({ email: 'no@exist.com', password: TEST_PW })).rejects.toThrow(
        '用户不存在'
      );
    });

    it('throws if user has no passwordHash', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: 'u1',
        email: 'test@test.com',
        passwordHash: null,
      } as any);

      await expect(login({ email: 'test@test.com', password: TEST_PW })).rejects.toThrow(
        '未设置密码'
      );
    });

    it('throws if password is wrong', async () => {
      const bcrypt = await import('bcryptjs');
      const hash = bcrypt.hashSync(TEST_PW, 4);
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: 'u1',
        email: 'test@test.com',
        passwordHash: hash,
      } as any);

      await expect(login({ email: 'test@test.com', password: `wrong-${Date.now()}` })).rejects.toThrow(
        '密码错误'
      );
    });

    it('returns user and session on valid login', async () => {
      const bcrypt = await import('bcryptjs');
      const hash = bcrypt.hashSync(TEST_PW, 4);
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: 'u1',
        email: 'test@test.com',
        passwordHash: hash,
        role: 'User',
      } as any);
      vi.mocked(prisma.session.create).mockResolvedValue({
        id: 's1',
        token: '',
        expiresAt: new Date(Date.now() + 604800000),
      } as any);
      vi.mocked(prisma.session.update).mockResolvedValue({} as any);
      vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as any);

      const result = await login({ email: 'test@test.com', password: TEST_PW });

      expect(result.user?.id).toBe('u1');
      expect(result.token).toBeDefined();
      expect(result.refreshToken).toBeDefined();
    });
  });

  describe('register', () => {
    it('throws if email already exists', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: 'existing',
        email: 'taken@test.com',
      } as any);

      await expect(register({ email: 'taken@test.com', password: TEST_PW })).rejects.toThrow(
        '邮箱已被注册'
      );
    });

    it('creates user and returns session', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.user.create).mockResolvedValue({
        id: 'new-u1',
        email: 'new@test.com',
        role: 'User',
      } as any);
      vi.mocked(prisma.session.create).mockResolvedValue({
        id: 's-new',
        token: '',
        expiresAt: new Date(Date.now() + 604800000),
      } as any);
      vi.mocked(prisma.session.update).mockResolvedValue({} as any);
      vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as any);

      const result = await register({ email: 'new@test.com', password: TEST_PW, name: 'New' });

      expect(result.user?.id).toBe('new-u1');
      expect(result.isNewUser).toBe(true);
      expect(result.token).toBeDefined();
    });
  });

  describe('verifyToken', () => {
    it('returns null for invalid token', () => {
      const result = verifyToken('invalid-token');
      expect(result).toBeNull();
    });
  });

  describe('getCurrentUser', () => {
    it('returns null if session expired', async () => {
      vi.mocked(prisma.session.findUnique).mockResolvedValue({
        id: 's1',
        expiresAt: new Date(Date.now() - 1000),
      } as any);

      const result = await getCurrentUser('s1');
      expect(result.user).toBeNull();
    });

    it('returns user if session valid', async () => {
      vi.mocked(prisma.session.findUnique).mockResolvedValue({
        id: 's1',
        expiresAt: new Date(Date.now() + 86400000),
        User: { id: 'u1', email: 'test@test.com', role: 'User' },
      } as any);

      const result = await getCurrentUser('s1');
      expect(result.user?.id).toBe('u1');
    });
  });

  describe('logout', () => {
    it('expires the session', async () => {
      vi.mocked(prisma.session.update).mockResolvedValue({} as any);

      await logout('s1');

      expect(prisma.session.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 's1' },
          data: expect.objectContaining({
            expiresAt: expect.any(Date),
          }),
        })
      );
    });
  });

  describe('refresh tokens', () => {
    it('generateRefreshToken creates a token', async () => {
      vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as any);

      const token = await generateRefreshToken('u1');

      expect(token).toBeDefined();
      expect(token.length).toBeGreaterThan(0);
      expect(prisma.refreshToken.create).toHaveBeenCalled();
    });

    it('exchangeRefreshToken returns null for revoked token', async () => {
      vi.mocked(prisma.refreshToken.findUnique).mockResolvedValue({
        id: 'rt1',
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
      } as any);

      const result = await exchangeRefreshToken('revoked-token');
      expect(result).toBeNull();
    });

    it('exchangeRefreshToken returns null for expired token', async () => {
      vi.mocked(prisma.refreshToken.findUnique).mockResolvedValue({
        id: 'rt1',
        revokedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      } as any);

      const result = await exchangeRefreshToken('expired-token');
      expect(result).toBeNull();
    });

    it('revokeRefreshToken returns false for already revoked token', async () => {
      vi.mocked(prisma.refreshToken.findUnique).mockResolvedValue({
        id: 'rt1',
        revokedAt: new Date(),
      } as any);

      const result = await revokeRefreshToken('already-revoked');
      expect(result).toBe(false);
    });
  });
});
