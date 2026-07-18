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
  mockReadJson.mockImplementation(async (path: string) => {
    if (path.includes('users.json')) return [...storeUsers];
    if (path.includes('sessions.json')) return [...storeSessions];
    return null;
  });
  mockWriteJson.mockImplementation(async (path: string, data: any) => {
    if (path.includes('users.json')) { storeUsers = [...(data as any[])]; }
    else if (path.includes('sessions.json')) { storeSessions = [...(data as any[])]; }
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
    expect(mockWriteJson).toHaveBeenCalled();
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
    await expect(login({ email: 'unknown@test.com', password: TEST_PW })).rejects.toThrow('用户不存在');
  });
  it('throws for wrong password', async () => {
    await expect(login({ email: TEST_EMAIL, password: MOCK_WRONG_PW })).rejects.toThrow('密码错误');
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

describe('generateRefreshToken + exchange + revoke', () => {
  it('generateRefreshToken stores token in session record', async () => {
    setupStore([], [{
      id: 's1', userId: 'u1', token: 't1',
      expiresAt: new Date(Date.now() + 86400000).toISOString(), createdAt: new Date().toISOString(),
    }]);
    const refreshToken = await generateRefreshToken('u1');
    expect(refreshToken).toBeTruthy();
    expect(mockWriteJson).toHaveBeenCalled();
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
