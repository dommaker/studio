import { describe, it, expect, beforeAll } from 'vitest';

const API = `http://localhost:${process.env.TEST_PORT || process.env.PORT || '13001'}/api/v1`;
const TIMEOUT = 15_000;

// #219 活端口门禁：默认 skip，显式 STUDIO_E2E_LIVE=1 才打真实服务器
const LIVE = process.env.STUDIO_E2E_LIVE === '1';

async function api(method: string, path: string, body?: unknown, token?: string) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const opts: RequestInit = { method, headers, signal: ctrl.signal };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${API}${path}`, opts);
    const data = await res.json().catch(() => null);
    return { status: res.status, ok: res.ok, data };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { status: 0, ok: false, error: msg, data: null };
  } finally { clearTimeout(t); }
}

async function registerFresh(suffix: string) {
  const email = `e2e-${suffix}-${Date.now()}@example.com`;
  const password = `pw-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const res = await api('POST', '/auth/register', { email, password });
  if (res.status !== 200) throw new Error(`Register failed: ${res.status} ${JSON.stringify(res.data)}`);
  return { email, password, token: res.data.token as string, refreshToken: res.data.refreshToken as string, user: res.data.user };
}

describe.skipIf(!LIVE)('Auth Flow E2E', () => {
  beforeAll(async () => {
    // Wait for server to be ready
    for (let i = 0; i < 20; i++) {
      try {
        const res = await fetch(`${API}/health`, { signal: AbortSignal.timeout(2000) });
        if (res.ok) return;
      } catch { /* not ready */ }
      await new Promise(r => setTimeout(r, 1000));
    }
  }, 30_000);

  describe('Guest session', () => {
    it('POST /auth/guest-session → 200 with session + token', async () => {
      const res = await api('POST', '/auth/guest-session');
      expect(res.status).toBe(200);
      expect(res.data.session).toBeDefined();
      expect(res.data.session.id).toBeDefined();
      expect(res.data.token).toBeDefined();
    }, TIMEOUT);
  });

  describe('Register', () => {
    it('returns 200 with user + session + token + refreshToken', async () => {
      const { email, token, refreshToken, user } = await registerFresh('reg');
      expect(user.email).toBe(email);
      expect(user.role).toBe('User');
      expect(token).toBeDefined();
      expect(refreshToken).toBeDefined();
    }, TIMEOUT);

    it('duplicate email → 409', async () => {
      const { email, password } = await registerFresh('dup');
      const res = await api('POST', '/auth/register', { email, password });
      expect(res.status).toBe(409);
    }, TIMEOUT);
  });

  describe('Me', () => {
    it('with valid token → 200 with user', async () => {
      const { token, email } = await registerFresh('me');
      const res = await api('GET', '/auth/me', undefined, token);
      expect(res.status).toBe(200);
      expect(res.data.user).toBeDefined();
      expect(res.data.user.email).toBe(email);
    }, TIMEOUT);

    it('no token → 200 with user:null (optionalAuth)', async () => {
      const res = await api('GET', '/auth/me');
      expect(res.status).toBe(200);
      expect(res.data.user).toBeNull();
    }, TIMEOUT);
  });

  describe('Login', () => {
    it('valid credentials → 200 with user + token + refreshToken', async () => {
      const { email, password } = await registerFresh('login');
      const res = await api('POST', '/auth/login', { email, password });
      expect(res.status).toBe(200);
      expect(res.data.user).toBeDefined();
      expect(res.data.token).toBeDefined();
      expect(res.data.refreshToken).toBeDefined();
    }, TIMEOUT);

    it('wrong password → 401', async () => {
      const { email } = await registerFresh('loginfail');
      const res = await api('POST', '/auth/login', { email, password: `wrong-${Date.now()}` });
      expect(res.status).toBe(401);
    }, TIMEOUT);
  });

  describe('Refresh token', () => {
    it('valid refresh → 200 with new accessToken + refreshToken', async () => {
      const { refreshToken } = await registerFresh('refresh');
      const res = await api('POST', '/auth/refresh', { refreshToken });
      expect(res.status).toBe(200);
      expect(res.data.accessToken).toBeDefined();
      expect(res.data.refreshToken).toBeDefined();
    }, TIMEOUT);

    it('bad token → 401', async () => {
      const res = await api('POST', '/auth/refresh', { refreshToken: 'bad-token' });
      expect(res.status).toBe(401);
    }, TIMEOUT);
  });

  describe('Logout', () => {
    it('authenticated → 200, session invalidated', async () => {
      const { token } = await registerFresh('logout');
      const res = await api('POST', '/auth/logout', undefined, token);
      expect(res.status).toBe(200);

      const meRes = await api('GET', '/auth/me', undefined, token);
      expect(meRes.data.user).toBeNull();
    }, TIMEOUT);
  });

  describe('Full cycle', () => {
    it('register → refresh → me → logout', async () => {
      const { token, refreshToken } = await registerFresh('cycle');

      const refRes = await api('POST', '/auth/refresh', { refreshToken });
      expect(refRes.status).toBe(200);
      const newToken = refRes.data.accessToken as string;

      const meRes = await api('GET', '/auth/me', undefined, newToken);
      expect(meRes.status).toBe(200);
      expect(meRes.data.user).toBeDefined();

      await api('POST', '/auth/logout', undefined, newToken).then(r => expect(r.status).toBe(200));

      const meRes2 = await api('GET', '/auth/me', undefined, newToken);
      expect(meRes2.data.user).toBeNull();
    }, TIMEOUT);
  });
});
