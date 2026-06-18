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
import crypto from 'crypto';
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
      findMany: vi.fn(),
      deleteMany: vi.fn(),
    },
    refreshToken: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
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
  verifyPassword,
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
      vi.mocked(prisma.session.findMany).mockResolvedValue([]);
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

    it('cleans up old guest sessions on login', async () => {
      const bcrypt = await import('bcryptjs');
      const hash = bcrypt.hashSync(TEST_PW, 4);
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: 'u1',
        email: 'test@test.com',
        passwordHash: hash,
        role: 'User',
      } as any);
      vi.mocked(prisma.session.findMany).mockResolvedValue([
        { id: 'guest-s1' },
        { id: 'guest-s2' },
      ] as any);
      vi.mocked(prisma.session.deleteMany).mockResolvedValue({ count: 2 } as any);
      vi.mocked(prisma.session.create).mockResolvedValue({
        id: 's1',
        token: '',
        expiresAt: new Date(Date.now() + 604800000),
      } as any);
      vi.mocked(prisma.session.update).mockResolvedValue({} as any);
      vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as any);

      await login({ email: 'test@test.com', password: TEST_PW });

      expect(prisma.session.findMany).toHaveBeenCalledWith({
        where: { userId: 'u1', guestId: { not: null }, expiresAt: { gt: expect.any(Date) } },
        select: { id: true },
      });
      expect(prisma.session.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['guest-s1', 'guest-s2'] } },
      });
    });

    it('skips guest cleanup when no guest sessions exist', async () => {
      const bcrypt = await import('bcryptjs');
      const hash = bcrypt.hashSync(TEST_PW, 4);
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: 'u1',
        email: 'test@test.com',
        passwordHash: hash,
        role: 'User',
      } as any);
      vi.mocked(prisma.session.findMany).mockResolvedValue([]);
      vi.mocked(prisma.session.create).mockResolvedValue({
        id: 's1',
        token: '',
        expiresAt: new Date(Date.now() + 604800000),
      } as any);
      vi.mocked(prisma.session.update).mockResolvedValue({} as any);
      vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as any);

      await login({ email: 'test@test.com', password: TEST_PW });

      expect(prisma.session.deleteMany).not.toHaveBeenCalled();
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

    it('revokes all refresh tokens when userId provided', async () => {
      vi.mocked(prisma.session.update).mockResolvedValue({} as any);
      vi.mocked(prisma.refreshToken.updateMany).mockResolvedValue({ count: 3 } as any);

      await logout('s1', 'u1');

      expect(prisma.session.update).toHaveBeenCalled();
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { userId: 'u1' },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('does not revoke refresh tokens when userId not provided', async () => {
      vi.mocked(prisma.session.update).mockResolvedValue({} as any);

      await logout('s1');

      expect(prisma.refreshToken.updateMany).not.toHaveBeenCalled();
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

    it('exchangeRefreshToken returns null for non-existent token', async () => {
      vi.mocked(prisma.refreshToken.findUnique).mockResolvedValue(null);

      const result = await exchangeRefreshToken('nonexistent');
      expect(result).toBeNull();
    });

    it('exchangeRefreshToken revokes old token and returns new pair on valid token', async () => {
      vi.mocked(prisma.refreshToken.findUnique).mockResolvedValue({
        id: 'rt1',
        userId: 'u1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
      } as any);
      vi.mocked(prisma.refreshToken.updateMany).mockResolvedValue({ count: 1 } as any);
      vi.mocked(prisma.session.create).mockResolvedValue({
        id: 'new-s1',
        token: '',
        expiresAt: new Date(Date.now() + 604800000),
      } as any);
      vi.mocked(prisma.session.update).mockResolvedValue({} as any);
      vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as any);

      const result = await exchangeRefreshToken('valid-refresh');

      expect(result).not.toBeNull();
      expect(result!.accessToken).toBeDefined();
      expect(result!.refreshToken).toBeDefined();
      expect(result!.userId).toBe('u1');
      // Old token revoked atomically
      expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'rt1', revokedAt: null },
          data: expect.objectContaining({ revokedAt: expect.any(Date) }),
        })
      );
      // New session created
      expect(prisma.session.create).toHaveBeenCalled();
    });

    it('exchangeRefreshToken concurrency: only first succeeds when two use same token', async () => {
      // Both concurrent calls see the same valid token
      vi.mocked(prisma.refreshToken.findUnique).mockResolvedValue({
        id: 'rt-con',
        userId: 'u1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
      } as any);
      // First updateMany succeeds, second fails (race condition simulated)
      vi.mocked(prisma.refreshToken.updateMany)
        .mockResolvedValueOnce({ count: 1 } as any)
        .mockResolvedValueOnce({ count: 0 } as any);
      vi.mocked(prisma.session.create).mockResolvedValue({
        id: 'new-con-s1',
        token: '',
        expiresAt: new Date(Date.now() + 604800000),
      } as any);
      vi.mocked(prisma.session.update).mockResolvedValue({} as any);
      vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as any);

      const [result1, result2] = await Promise.all([
        exchangeRefreshToken('same-token'),
        exchangeRefreshToken('same-token'),
      ]);

      expect(result1).not.toBeNull();
      expect(result1!.accessToken).toBeDefined();
      expect(result1!.refreshToken).toBeDefined();
      expect(result1!.userId).toBe('u1');
      // Second concurrent call got null because updateMany count was 0
      expect(result2).toBeNull();
    });

    it('exchangeRefreshToken idempotent: calling twice with same token does not throw', async () => {
      // First call: valid token → success
      vi.mocked(prisma.refreshToken.findUnique).mockResolvedValueOnce({
        id: 'rt-idem',
        userId: 'u1',
        revokedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
      } as any);
      vi.mocked(prisma.refreshToken.updateMany).mockResolvedValueOnce({ count: 1 } as any);
      vi.mocked(prisma.session.create).mockResolvedValue({
        id: 'idem-s1',
        token: '',
        expiresAt: new Date(Date.now() + 604800000),
      } as any);
      vi.mocked(prisma.session.update).mockResolvedValue({} as any);
      vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as any);

      const first = await exchangeRefreshToken('idem-token');
      expect(first).not.toBeNull();

      // Second call: same token now revoked → return null, no throw
      vi.mocked(prisma.refreshToken.findUnique).mockResolvedValueOnce({
        id: 'rt-idem',
        userId: 'u1',
        revokedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
      } as any);

      const second = await exchangeRefreshToken('idem-token');
      expect(second).toBeNull();
    });

    it('revokeRefreshToken returns true for valid unredeemed token', async () => {
      vi.mocked(prisma.refreshToken.findUnique).mockResolvedValue({
        id: 'rt1',
        revokedAt: null,
      } as any);
      vi.mocked(prisma.refreshToken.update).mockResolvedValue({} as any);

      const result = await revokeRefreshToken('valid-token');
      expect(result).toBe(true);
      expect(prisma.refreshToken.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'rt1' },
          data: expect.objectContaining({ revokedAt: expect.any(Date) }),
        })
      );
    });
  });

  describe('verifyToken round-trip', () => {
    it('verifyToken returns null for non-JWT string', () => {
      expect(verifyToken('not-a-jwt')).toBeNull();
    });

    it('verifyToken returns null for empty string', () => {
      expect(verifyToken('')).toBeNull();
    });
  });

  describe('verifyPassword (PBKDF2 compatibility)', () => {
    const testPassword = 'legacy-password-123';
    const testSalt = 'test-salt-value';
    const pbkdf2Digest = crypto.pbkdf2Sync(testPassword, testSalt, 1000, 64, 'sha256').toString('hex');
    const legacyHash = `${testSalt}:${pbkdf2Digest}`;

    it('recognizes legacy PBKDF2 format and returns needsRehash=true on valid password', () => {
      const result = verifyPassword(testPassword, legacyHash);
      expect(result.valid).toBe(true);
      expect(result.needsRehash).toBe(true);
    });

    it('returns valid=false and needsRehash=false for wrong PBKDF2 password', () => {
      const result = verifyPassword('wrong-password', legacyHash);
      expect(result.valid).toBe(false);
      expect(result.needsRehash).toBe(false);
    });

    it('returns valid=false and needsRehash=false for malformed hash (no colon)', () => {
      const result = verifyPassword(testPassword, 'malformedhash');
      // bcrypt.compareSync fails → false
      expect(result.valid).toBe(false);
      expect(result.needsRehash).toBe(false);
    });

    it('returns needsRehash=false for bcrypt format hash', async () => {
      const bcrypt = await import('bcryptjs');
      const bcryptHash = bcrypt.hashSync(testPassword, 4);
      const result = verifyPassword(testPassword, bcryptHash);
      expect(result.valid).toBe(true);
      expect(result.needsRehash).toBe(false);
    });

    it('handles PBKDF2 with empty salt or hash gracefully', () => {
      expect(verifyPassword(testPassword, ':hashonly').valid).toBe(false);
      expect(verifyPassword(testPassword, 'saltonly:').valid).toBe(false);
    });
  });

  describe('login with PBKDF2 legacy hash', () => {
    const testPassword = 'legacy-pw';
    const testSalt = 'legacy-salt';
    const pbkdf2Digest = crypto.pbkdf2Sync(testPassword, testSalt, 1000, 64, 'sha256').toString('hex');
    const legacyHash = `${testSalt}:${pbkdf2Digest}`;

    it('silently upgrades PBKDF2 hash to bcrypt on successful login (AC2)', async () => {
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: 'u-legacy',
        email: 'legacy@test.com',
        passwordHash: legacyHash,
        role: 'User',
      } as any);
      vi.mocked(prisma.session.findMany).mockResolvedValue([]);
      vi.mocked(prisma.session.create).mockResolvedValue({
        id: 's-legacy',
        token: '',
        expiresAt: new Date(Date.now() + 604800000),
      } as any);
      vi.mocked(prisma.session.update).mockResolvedValue({} as any);
      vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as any);
      vi.mocked(prisma.user.update).mockResolvedValue({} as any);

      await login({ email: 'legacy@test.com', password: testPassword });

      // Verify silent upgrade: user.update called with bcrypt hash
      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'u-legacy' },
          data: expect.objectContaining({
            passwordHash: expect.stringMatching(/^\$2[aby]\$\d+\$/),
          }),
        })
      );
    });

    it('uses bcrypt path after PBKDF2 upgrade (no rehash on subsequent login) (AC3)', async () => {
      const bcrypt = await import('bcryptjs');
      const bcryptHash = bcrypt.hashSync(testPassword, 4);

      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: 'u-upgraded',
        email: 'upgraded@test.com',
        passwordHash: bcryptHash,
        role: 'User',
      } as any);
      vi.mocked(prisma.session.findMany).mockResolvedValue([]);
      vi.mocked(prisma.session.create).mockResolvedValue({
        id: 's-upgraded',
        token: '',
        expiresAt: new Date(Date.now() + 604800000),
      } as any);
      vi.mocked(prisma.session.update).mockResolvedValue({} as any);
      vi.mocked(prisma.refreshToken.create).mockResolvedValue({} as any);

      await login({ email: 'upgraded@test.com', password: testPassword });

      // bcrypt path: no rehash needed, user.update should not be called
      expect(prisma.user.update).not.toHaveBeenCalled();
    });
  });
});
