/**
 * Auth service contract tests — FileStore-based (Spec 4 Phase 2)
 *
 * AC-B1: User → users.json
 * AC-B2: Session → sessions.json
 * AC-B3: RefreshToken → Session.refreshToken
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const TEST_EMAIL = `test-${Date.now()}@test.com`;
const TEST_PW = `test-pw-${Date.now()}`;
const MOCK_WRONG_PW = `wrong-${Date.now()}`;

// ── Mock FileStore ──
const mockReadJson = vi.hoisted(() => vi.fn());
const mockReadJsonUncached = vi.hoisted(() => vi.fn());
const mockWriteJson = vi.hoisted(() => vi.fn());
const mockWithLock = vi.hoisted(() => vi.fn());

vi.mock('@dommaker/studio-shared/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared/node')>();
  return { ...actual, logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() } };
});

vi.mock('@dommaker/studio-shared', () => ({
  FileStore: vi.fn().mockImplementation(function () { return {
    readJson: mockReadJson,
    readJsonUncached: mockReadJsonUncached,
    writeJson: mockWriteJson,
    withLock: mockWithLock,
  }; }),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// ── Imports after mocks ──
import {
  createGuestSession, getOrCreateSession, login, register, logout,
  getCurrentUser, cleanupExpiredSessions, generateRefreshToken,
  exchangeRefreshToken, revokeRefreshToken, verifyToken,
  hashPassword, verifyPassword, JWT_SECRET,
} from '../service.js';

// ── In-memory store ──
let storeUsers: any[] = [];
let storeSessions: any[] = [];

function setupStore(users: any[], sessions: any[]) {
  storeUsers = [...users];
  storeSessions = [...sessions];
  const read = async (path: string) => {
    if (path.includes('users.json')) return [...storeUsers];
    if (path.includes('sessions.json')) return [...storeSessions];
    return null;
  };
  mockReadJson.mockImplementation(read);
  mockReadJsonUncached.mockImplementation(read);
  mockWriteJson.mockImplementation(async (path: string, data: any) => {
    if (path.includes('users.json')) { storeUsers = [...(data as any[])]; }
    if (path.includes('sessions.json')) { storeSessions = [...(data as any[])]; }
  });
  let lockTail = Promise.resolve();
  mockWithLock.mockImplementation(async (_path: string, fn: () => Promise<unknown>) => {
    const previous = lockTail;
    let release!: () => void;
    lockTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  });
}

beforeEach(() => { vi.clearAllMocks(); setupStore([], []); });

// ── Tests ──

describe('verifyToken', () => {
  it('returns null for invalid token', () => {
    expect(verifyToken('bad-token')).toBeNull();
  });
  it('returns null for empty token', () => {
    expect(verifyToken('')).toBeNull();
  });
});

describe('createGuestSession', () => {
  it('creates session and returns token', async () => {
    const result = await createGuestSession({ guestId: 'g-1' });
    expect(result.token).toBeTruthy();
    expect(result.session.guestId).toBe('g-1');
    const decoded = verifyToken(result.token);
    expect(decoded).not.toBeNull();
    expect(mockWriteJson).toHaveBeenCalled();
  });
  it('generates guestId if not provided', async () => {
    const result = await createGuestSession({});
    expect(result.session.guestId).toBeTruthy();
  });
});

describe('getOrCreateSession', () => {
  it('returns existing session if valid', async () => {
    setupStore([], [{
      id: 's-existing', guestId: 'g-1', token: 'existing-token',
      expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: new Date().toISOString(),
    }]);
    const result = await getOrCreateSession({ guestId: 'g-1' });
    expect(result.session.id).toBe('s-existing');
  });
  it('creates new session if no existing guest session', async () => {
    const result = await getOrCreateSession({ guestId: 'g-new' });
    expect(result.token).toBeTruthy();
    expect(mockWriteJson).toHaveBeenCalled();
  });
});

describe('password hashing', () => {
  it('hashPassword and verifyPassword round-trip', () => {
    const hash = hashPassword(TEST_PW);
    expect(hash).toBeTruthy();
    const { valid } = verifyPassword(TEST_PW, hash);
    expect(valid).toBe(true);
  });
  it('verifyPassword returns false for wrong password', () => {
    const hash = hashPassword(TEST_PW);
    const { valid } = verifyPassword(MOCK_WRONG_PW, hash);
    expect(valid).toBe(false);
  });
});

describe('register', () => {
  it('writes user to users.json and creates session', async () => {
    const result = await register({ email: TEST_EMAIL, password: TEST_PW, name: 'Test' });
    expect(result.user.email).toBe(TEST_EMAIL);
    expect(result.user.role).toBe('User');
    expect(result.token).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
    expect(mockWriteJson).toHaveBeenCalled(); // users.json
    expect(mockWriteJson).toHaveBeenCalled(); // sessions
  });
  it('throws when email already registered', async () => {
    setupStore([{ id: 'u1', email: TEST_EMAIL, passwordHash: 'x', role: 'User' }], []);
    await expect(register({ email: TEST_EMAIL, password: TEST_PW })).rejects.toThrow('邮箱已被注册');
  });
});

describe('login', () => {
  beforeEach(() => {
    const hash = hashPassword(TEST_PW);
    setupStore([{
      id: 'u1', email: TEST_EMAIL, passwordHash: hash, name: 'Test',
      role: 'User', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }], []);
  });
  it('returns token for valid credentials', async () => {
    const result = await login({ email: TEST_EMAIL, password: TEST_PW });
    expect(result.user.email).toBe(TEST_EMAIL);
    expect(result.token).toBeTruthy();
    expect(result.refreshToken).toBeTruthy();
  });
  it('throws for unknown email', async () => {
    await expect(login({ email: 'unknown@test.com', password: TEST_PW })).rejects.toThrow('邮箱或密码错误');
  });
  it('throws for wrong password', async () => {
    await expect(login({ email: TEST_EMAIL, password: MOCK_WRONG_PW })).rejects.toThrow('邮箱或密码错误');
  });
});

describe('logout', () => {
  it('expires session and revokes refresh tokens', async () => {
    setupStore([], [{
      id: 's1', userId: 'u1', token: 't',
      expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: new Date().toISOString(),
      refreshToken: 'rt1',
    }]);
    await logout('s1', 'u1');
    expect(mockWriteJson).toHaveBeenCalled();
  });
});

describe('getCurrentUser', () => {
  it('returns user and session when session valid', async () => {
    const user = { id: 'u1', email: TEST_EMAIL, name: 'Test', role: 'User' };
    setupStore([user], [{
      id: 's1', userId: 'u1', token: 't',
      expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: new Date().toISOString(),
    }]);
    const result = await getCurrentUser('s1');
    expect(result.user).toBeTruthy();
    expect(result.user!.email).toBe(TEST_EMAIL);
    expect(result.session).toBeTruthy();
  });
  it('returns null user/session for expired session', async () => {
    setupStore([], [{
      id: 's1', userId: 'u1', token: 't',
      expiresAt: new Date(Date.now() - 1000).toISOString(), createdAt: new Date().toISOString(),
    }]);
    const result = await getCurrentUser('s1');
    expect(result.user).toBeNull();
    expect(result.session).toBeNull();
  });
});

describe('cleanupExpiredSessions', () => {
  it('removes expired sessions', async () => {
    setupStore([], [
      { id: 's1', userId: 'u1', token: 't1', expiresAt: new Date(Date.now() - 86400000).toISOString(), createdAt: new Date().toISOString() },
      { id: 's2', userId: 'u2', token: 't2', expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: new Date().toISOString() },
    ]);
    const count = await cleanupExpiredSessions();
    expect(count).toBe(1);
    expect(mockWriteJson).toHaveBeenCalled();
  });
});

describe('sessions.json 写路径 prune 过期条目 (#525 P2-3)', () => {
  it('写操作后文件不含过期条目，未过期条目原样保留', async () => {
    setupStore([], [
      { id: 's-expired-1', userId: 'u1', token: 't1', guestId: null, ipAddress: null, userAgent: null,
        expiresAt: new Date(Date.now() - 86400000).toISOString(), createdAt: new Date().toISOString(), refreshToken: null },
      { id: 's-expired-2', userId: 'u2', token: 't2', guestId: null, ipAddress: null, userAgent: null,
        expiresAt: new Date(Date.now() - 1000).toISOString(), createdAt: new Date().toISOString(), refreshToken: 'rt' },
      { id: 's-valid', userId: 'u3', token: 't3', guestId: null, ipAddress: null, userAgent: null,
        expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: new Date().toISOString(), refreshToken: 'rt-valid' },
    ]);
    await createGuestSession({ guestId: 'g-prune' });
    const ids = storeSessions.map((s) => s.id);
    expect(ids).not.toContain('s-expired-1');
    expect(ids).not.toContain('s-expired-2');
    // 未过期条目保留；legacy 明文 refresh token 迁移为可轮换的 hash
    const kept = storeSessions.find((s) => s.id === 's-valid');
    expect(kept).toBeTruthy();
    expect(kept.refreshToken).toBeNull();
    expect(kept.refreshTokenHash).toBeTruthy();
    await expect(exchangeRefreshToken('rt-valid')).resolves.not.toBeNull();
    // 新会话写入成功
    expect(storeSessions.some((s) => s.guestId === 'g-prune')).toBe(true);
  });

  it('updateSession 写路径同样 prune 过期条目', async () => {
    setupStore([], [{
      id: 's1', userId: 'u1', token: 't', guestId: null, ipAddress: null, userAgent: null,
      expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: new Date().toISOString(),
      refreshToken: 'rt1',
    }, {
      id: 's-expired', userId: 'u2', token: 't2', guestId: null, ipAddress: null, userAgent: null,
      expiresAt: new Date(Date.now() - 86400000).toISOString(), createdAt: new Date().toISOString(),
      refreshToken: null,
    }]);
    await logout('s1', 'u1');
    // s-expired 被 prune；s1 被 logout 置为已过期（是否当次 prune 取决于毫秒边界，见 service.ts logout 注释）
    const ids = storeSessions.map((s) => s.id);
    expect(ids).not.toContain('s-expired');
    expect(storeSessions.filter((s) => new Date(s.expiresAt) > new Date())).toEqual([]);
  });
});

describe('generateRefreshToken + exchange + revoke', () => {
  it('generateRefreshToken binds the explicit session instead of the user latest session', async () => {
    setupStore([], [{
      id: 's1', userId: 'u1', token: 't1',
      expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: new Date().toISOString(),
    }, {
      id: 's2', userId: 'u1', token: 't2', refreshToken: 'rt-s2',
      expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: new Date().toISOString(),
    }]);
    const refreshToken = await generateRefreshToken('s1');
    expect(refreshToken).toBeTruthy();
    await expect(exchangeRefreshToken(refreshToken)).resolves.toMatchObject({ userId: 'u1' });
    await expect(exchangeRefreshToken('rt-s2')).resolves.not.toBeNull();
  });
  it('exchangeRefreshToken returns new token pair', async () => {
    const oldRt = 'rt-old';
    setupStore([], [{
      id: 's1', userId: 'u1', token: 'access-token-old',
      expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: new Date().toISOString(),
      refreshToken: oldRt,
    }]);
    const result = await exchangeRefreshToken(oldRt);
    expect(result).not.toBeNull();
    expect(result!.userId).toBe('u1');
    expect(result!.accessToken).toBeTruthy();
    expect(result!.refreshToken).toBeTruthy();
    expect(result!.refreshToken).not.toBe(oldRt);
  });
  it('exchangeRefreshToken returns null for invalid token', async () => {
    const result = await exchangeRefreshToken('bad-token');
    expect(result).toBeNull();
  });
  it('revokeRefreshToken clears session.refreshToken', async () => {
    setupStore([], [{
      id: 's1', userId: 'u1', token: 't',
      expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: new Date().toISOString(),
      refreshToken: 'rt-to-revoke',
    }]);
    const result = await revokeRefreshToken('rt-to-revoke');
    expect(result).toBe(true);
    expect(mockWriteJson).toHaveBeenCalled();
  });
  it('revokeRefreshToken returns false for non-existent token', async () => {
    const result = await revokeRefreshToken('non-existent');
    expect(result).toBe(false);
  });
});

describe('SEC-06 refresh lifecycle and atomic writes', () => {
  const user = {
    id: 'u1', email: TEST_EMAIL, passwordHash: null, name: 'Test', avatar: null,
    role: 'User', emailVerified: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const session = (id: string, refreshToken: string, patch: Record<string, unknown> = {}) => ({
    id, userId: 'u1', token: `access-${id}`, guestId: null, ipAddress: null, userAgent: null,
    expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: new Date().toISOString(),
    refreshToken, familyId: `family-${id}`, ...patch,
  });

  it('rejects an absolutely expired legacy session without creating credentials', async () => {
    setupStore([user], [session('s-old', 'rt-absolute', {
      createdAt: new Date(Date.now() - 31 * 86400000).toISOString(),
    })]);
    const before = JSON.stringify(storeSessions);

    await expect(exchangeRefreshToken('rt-absolute')).resolves.toBeNull();
    expect(JSON.stringify(storeSessions)).toBe(before);
    expect(mockWriteJson).not.toHaveBeenCalled();
  });

  it('rejects an idle-expired session without creating credentials', async () => {
    setupStore([user], [session('s-idle', 'rt-idle', {
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    })]);
    const before = JSON.stringify(storeSessions);

    await expect(exchangeRefreshToken('rt-idle')).resolves.toBeNull();
    expect(JSON.stringify(storeSessions)).toBe(before);
    expect(mockWriteJson).not.toHaveBeenCalled();
  });

  it('rejects a revoked session without creating credentials', async () => {
    setupStore([user], [session('s-revoked', 'rt-revoked', { revokedAt: new Date().toISOString() })]);
    const before = JSON.stringify(storeSessions);

    await expect(exchangeRefreshToken('rt-revoked')).resolves.toBeNull();
    expect(JSON.stringify(storeSessions)).toBe(before);
    expect(mockWriteJson).not.toHaveBeenCalled();
  });

  it('rotates a concurrently reused token once and returns the same result', async () => {
    setupStore([user], [session('s-race', 'rt-race')]);

    const [first, second] = await Promise.all([
      exchangeRefreshToken('rt-race'), exchangeRefreshToken('rt-race'),
    ]);

    expect(first).not.toBeNull();
    expect(second).toEqual(first);
    expect(storeSessions.filter((s) => s.userId === 'u1' && !s.revokedAt && new Date(s.expiresAt) > new Date())).toHaveLength(1);
  });

  it('invalidates the old access session and persists no plaintext refresh token', async () => {
    setupStore([user], [session('s-access', 'rt-plaintext')]);

    const result = await exchangeRefreshToken('rt-plaintext');

    expect(result).not.toBeNull();
    await expect(getCurrentUser('s-access')).resolves.toEqual({ user: null, session: null });
    expect(storeSessions.some((s) => s.refreshToken === 'rt-plaintext' || s.refreshToken === result!.refreshToken)).toBe(false);
  });

  it('keeps concurrent sessions on independent families', async () => {
    setupStore([user], [session('s-one', 'rt-one'), session('s-two', 'rt-two')]);

    const first = await exchangeRefreshToken('rt-one');
    const second = await exchangeRefreshToken('rt-two');

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(second!.refreshToken).not.toBe(first!.refreshToken);
  });

  it('logout revokes only the current family', async () => {
    setupStore([user], [session('s-current', 'rt-current'), session('s-other', 'rt-other')]);

    await logout('s-current', 'u1');

    await expect(getCurrentUser('s-current')).resolves.toEqual({ user: null, session: null });
    await expect(getCurrentUser('s-other')).resolves.toMatchObject({ user: { id: 'u1' } });
    await expect(exchangeRefreshToken('rt-other')).resolves.not.toBeNull();
  });

  it('does not lose sessions during parallel logins', async () => {
    setupStore([{ ...user, passwordHash: hashPassword(TEST_PW) }], []);

    await Promise.all([
      login({ email: TEST_EMAIL, password: TEST_PW }),
      login({ email: TEST_EMAIL, password: TEST_PW }),
    ]);

    expect(storeSessions.filter((s) => s.userId === 'u1')).toHaveLength(2);
  });

  it('allows only one registration for a concurrently reused email', async () => {
    const results = await Promise.allSettled([
      register({ email: TEST_EMAIL, password: TEST_PW }),
      register({ email: TEST_EMAIL, password: TEST_PW }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(storeUsers.filter((u) => u.email === TEST_EMAIL)).toHaveLength(1);
  });

  it('random invalid tokens have no revocation or write side effects', async () => {
    setupStore([user], [session('s-valid', 'rt-valid')]);
    const before = JSON.stringify(storeSessions);

    await expect(exchangeRefreshToken('rt-random-invalid')).resolves.toBeNull();
    expect(JSON.stringify(storeSessions)).toBe(before);
    expect(mockWriteJson).not.toHaveBeenCalled();
  });
});
