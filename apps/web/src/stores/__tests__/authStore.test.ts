import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../api', () => ({
  authApi: {
    createGuestSession: vi.fn(),
    checkAuth: vi.fn(),
    login: vi.fn(),
    register: vi.fn(),
    logout: vi.fn(),
    fetchMe: vi.fn(),
  },
}));

import { useAuthStore } from '../authStore';
import { authApi } from '../../api';

function resetStore() {
  useAuthStore.setState({
    token: null,
    user: null,
    session: null,
    refreshToken: null,
    guestId: null,
    isLoading: false,
    error: null,
  });
}

describe('authStore', () => {
  beforeEach(() => {
    localStorage.clear();
    resetStore();
    vi.clearAllMocks();
  });

  // ─── initial state ───

  describe('initial state', () => {
    it('starts with null token, user, session', () => {
      const s = useAuthStore.getState();
      expect(s.token).toBeNull();
      expect(s.user).toBeNull();
      expect(s.session).toBeNull();
      expect(s.refreshToken).toBeNull();
      expect(s.guestId).toBeNull();
      expect(s.isLoading).toBe(false);
      expect(s.error).toBeNull();
    });

    it('isAuthenticated returns false when no user', () => {
      expect(useAuthStore.getState().isAuthenticated()).toBe(false);
    });

    it('isGuest returns true when no user', () => {
      expect(useAuthStore.getState().isGuest()).toBe(true);
    });

    it('isAdmin returns false when no user', () => {
      expect(useAuthStore.getState().isAdmin()).toBe(false);
    });

    it('getRole returns Guest when no user', () => {
      expect(useAuthStore.getState().getRole()).toBe('Guest');
    });
  });

  // ─── computed properties ───

  describe('computed properties', () => {
    it('isAuthenticated returns true for non-Guest user', () => {
      useAuthStore.setState({ user: { id: '1', email: 'a@b.com', role: 'User' } });
      expect(useAuthStore.getState().isAuthenticated()).toBe(true);
    });

    it('isAuthenticated returns false for Guest user', () => {
      useAuthStore.setState({ user: { id: '1', email: '', role: 'Guest' } });
      expect(useAuthStore.getState().isAuthenticated()).toBe(false);
    });

    it('isAdmin returns true when role is Admin', () => {
      useAuthStore.setState({ user: { id: '1', email: 'a@b.com', role: 'Admin' } });
      expect(useAuthStore.getState().isAdmin()).toBe(true);
    });

    it('isAdmin returns false when role is User', () => {
      useAuthStore.setState({ user: { id: '1', email: 'a@b.com', role: 'User' } });
      expect(useAuthStore.getState().isAdmin()).toBe(false);
    });

    it('isGuest returns false for Authenticated user', () => {
      useAuthStore.setState({ user: { id: '1', email: 'a@b.com', role: 'User' } });
      expect(useAuthStore.getState().isGuest()).toBe(false);
    });

    it('getRole returns correct role', () => {
      useAuthStore.setState({ user: { id: '1', email: 'a@b.com', role: 'Admin' } });
      expect(useAuthStore.getState().getRole()).toBe('Admin');
    });
  });

  // ─── login ───

  describe('login', () => {
    it('sets token, refreshToken, user, session on success', async () => {
      vi.mocked(authApi.login).mockResolvedValueOnce({
        data: {
          token: 'jwt-token',
          refreshToken: 'refresh-token',
          user: { id: 'u1', email: 'a@b.com', role: 'User' },
          session: { id: 's1', expiresAt: '2026-07-01T00:00:00Z' },
        },
      });

      const result = await useAuthStore.getState().login('a@b.com', 'pass');

      expect(result).toBe(true);
      const s = useAuthStore.getState();
      expect(s.token).toBe('jwt-token');
      expect(s.refreshToken).toBe('refresh-token');
      expect(s.user).toEqual({ id: 'u1', email: 'a@b.com', role: 'User' });
      expect(s.session).toEqual({ id: 's1', expiresAt: '2026-07-01T00:00:00Z' });
      expect(s.isLoading).toBe(false);
      expect(s.error).toBeNull();
    });

    it('returns false and sets error when data.error is present', async () => {
      vi.mocked(authApi.login).mockResolvedValueOnce({
        data: { error: 'Invalid credentials' },
      });

      const result = await useAuthStore.getState().login('a@b.com', 'wrong');

      expect(result).toBe(false);
      expect(useAuthStore.getState().error).toBe('Invalid credentials');
      expect(useAuthStore.getState().isLoading).toBe(false);
    });

    it('returns false and sets error on API exception', async () => {
      vi.mocked(authApi.login).mockRejectedValueOnce(new Error('Network error'));

      const result = await useAuthStore.getState().login('a@b.com', 'pass');

      expect(result).toBe(false);
      expect(useAuthStore.getState().error).toBe('Network error');
      expect(useAuthStore.getState().isLoading).toBe(false);
    });

    it('sets loading state before request', async () => {
      let resolvePromise: (v: unknown) => void;
      vi.mocked(authApi.login).mockReturnValueOnce(
        new Promise((resolve) => { resolvePromise = resolve; }) as unknown as ReturnType<typeof authApi.login>
      );

      const promise = useAuthStore.getState().login('a@b.com', 'pass');
      expect(useAuthStore.getState().isLoading).toBe(true);

      resolvePromise!({ data: { token: 't', user: { id: '1', email: 'a', role: 'User' }, session: { id: 's', expiresAt: '' } } });
      await promise;
    });
  });

  // ─── register ───

  describe('register', () => {
    it('sets token, user, session on success', async () => {
      vi.mocked(authApi.register).mockResolvedValueOnce({
        data: {
          token: 'jwt-reg',
          refreshToken: 'rt-reg',
          user: { id: 'u2', email: 'new@b.com', role: 'User' },
          session: { id: 's2', expiresAt: '2026-08-01T00:00:00Z' },
        },
      });

      const result = await useAuthStore.getState().register('new@b.com', 'pass', 'New User');

      expect(result).toBe(true);
      const s = useAuthStore.getState();
      expect(s.token).toBe('jwt-reg');
      expect(s.user?.email).toBe('new@b.com');
      expect(s.isLoading).toBe(false);
    });

    it('returns false when data.error is present', async () => {
      vi.mocked(authApi.register).mockResolvedValueOnce({
        data: { error: 'Email already registered' },
      });

      const result = await useAuthStore.getState().register('existing@b.com', 'pass');

      expect(result).toBe(false);
      expect(useAuthStore.getState().error).toBe('Email already registered');
    });

    it('returns false on API exception', async () => {
      vi.mocked(authApi.register).mockRejectedValueOnce(new Error('Server error'));

      const result = await useAuthStore.getState().register('a@b.com', 'pass');

      expect(result).toBe(false);
      expect(useAuthStore.getState().error).toBe('Server error');
    });

    it('handles register without optional name', async () => {
      vi.mocked(authApi.register).mockResolvedValueOnce({
        data: {
          token: 't',
          user: { id: 'u', email: 'a@b.com', role: 'User' },
          session: { id: 's', expiresAt: '' },
        },
      });

      const result = await useAuthStore.getState().register('a@b.com', 'pass');
      expect(result).toBe(true);
      expect(authApi.register).toHaveBeenCalledWith('a@b.com', 'pass', undefined);
    });
  });

  // ─── logout ───

  describe('logout', () => {
    it('calls authApi.logout and clears user/token/session', async () => {
      useAuthStore.setState({
        token: 'old-token',
        user: { id: 'u1', email: 'a@b.com', role: 'User' },
        session: { id: 's1', expiresAt: '' },
        refreshToken: 'rt',
      });
      vi.mocked(authApi.createGuestSession).mockResolvedValueOnce({
        data: {
          token: 'guest-token',
          user: { id: 'guest1', email: '', role: 'Guest' },
          session: { id: 'sg', expiresAt: '' },
        },
      });

      await useAuthStore.getState().logout();

      expect(authApi.logout).toHaveBeenCalledOnce();
      const s = useAuthStore.getState();
      expect(s.token).toBe('guest-token');
      expect(s.user?.role).toBe('Guest');
      expect(s.session).toBeDefined();
    });

    it('creates guest session after logout even when authApi.logout fails', async () => {
      vi.mocked(authApi.logout).mockRejectedValueOnce(new Error('Logout fail'));
      vi.mocked(authApi.createGuestSession).mockResolvedValueOnce({
        data: {
          token: 'guest-token',
          user: { id: 'g1', email: '', role: 'Guest' },
          session: { id: 'sg', expiresAt: '' },
        },
      });

      await useAuthStore.getState().logout();

      const s = useAuthStore.getState();
      expect(s.token).toBe('guest-token');
      expect(s.user?.role).toBe('Guest');
    });
  });

  // ─── fetchMe ───

  describe('fetchMe', () => {
    it('updates user and session on success', async () => {
      vi.mocked(authApi.fetchMe).mockResolvedValueOnce({
        data: {
          user: { id: 'u1', email: 'a@b.com', role: 'User', name: 'Alice' },
          session: { id: 's1', expiresAt: '2026-09-01T00:00:00Z' },
        },
      });

      await useAuthStore.getState().fetchMe();

      const s = useAuthStore.getState();
      expect(s.user?.name).toBe('Alice');
      expect(s.session?.id).toBe('s1');
    });

    it('does not throw on API error', async () => {
      vi.mocked(authApi.fetchMe).mockRejectedValueOnce(new Error('Fetch failed'));

      await expect(useAuthStore.getState().fetchMe()).resolves.not.toThrow();
    });
  });

  // ─── setToken ───

  describe('setToken', () => {
    it('sets token', () => {
      useAuthStore.getState().setToken('new-token');
      expect(useAuthStore.getState().token).toBe('new-token');
    });

    it('sets refreshToken when provided', () => {
      useAuthStore.getState().setToken('t', 'rt');
      expect(useAuthStore.getState().token).toBe('t');
      expect(useAuthStore.getState().refreshToken).toBe('rt');
    });

    it('does not modify refreshToken when not provided', () => {
      useAuthStore.setState({ refreshToken: 'existing-rt' });
      useAuthStore.getState().setToken('t');
      expect(useAuthStore.getState().refreshToken).toBe('existing-rt');
    });
  });

  // ─── setError ───

  describe('setError', () => {
    it('sets error string', () => {
      useAuthStore.getState().setError('Something went wrong');
      expect(useAuthStore.getState().error).toBe('Something went wrong');
    });

    it('clears error when called with null', () => {
      useAuthStore.setState({ error: 'existing error' });
      useAuthStore.getState().setError(null);
      expect(useAuthStore.getState().error).toBeNull();
    });
  });

  // ─── getAuthHeader ───

  describe('getAuthHeader', () => {
    it('returns Bearer header when token exists', () => {
      useAuthStore.setState({ token: 'my-jwt' });
      expect(useAuthStore.getState().getAuthHeader()).toEqual({
        Authorization: 'Bearer my-jwt',
      });
    });

    it('returns empty object when no token', () => {
      expect(useAuthStore.getState().getAuthHeader()).toEqual({});
    });
  });

  // ─── init ───

  describe('init', () => {
    it('calls checkAuth when token exists', async () => {
      useAuthStore.setState({ token: 'existing-token' });
      vi.mocked(authApi.checkAuth).mockResolvedValueOnce({
        data: { user: { id: 'u1', email: 'a@b.com', role: 'User' } },
      });

      await useAuthStore.getState().init();

      expect(authApi.checkAuth).toHaveBeenCalledOnce();
    });

    it('calls createGuestSession when no token', async () => {
      vi.mocked(authApi.createGuestSession).mockResolvedValueOnce({
        data: {
          token: 'guest-token',
          user: { id: 'g1', email: '', role: 'Guest' },
          session: { id: 'sg', expiresAt: '' },
        },
      });

      await useAuthStore.getState().init();

      expect(authApi.createGuestSession).toHaveBeenCalledOnce();
    });
  });

  // ─── checkAuth ───

  describe('checkAuth', () => {
    it('does nothing when no token', async () => {
      await useAuthStore.getState().checkAuth();
      expect(authApi.checkAuth).not.toHaveBeenCalled();
    });

    it('updates user when API returns user', async () => {
      useAuthStore.setState({ token: 'valid-token' });
      vi.mocked(authApi.checkAuth).mockResolvedValueOnce({
        data: { user: { id: 'u1', email: 'a@b.com', role: 'User' } },
      });

      await useAuthStore.getState().checkAuth();

      expect(useAuthStore.getState().user?.email).toBe('a@b.com');
      expect(useAuthStore.getState().isLoading).toBe(false);
    });

    it('creates guest session when API returns no user', async () => {
      useAuthStore.setState({ token: 'token-no-user' });
      vi.mocked(authApi.checkAuth).mockResolvedValueOnce({ data: {} });
      vi.mocked(authApi.createGuestSession).mockResolvedValueOnce({
        data: {
          token: 'guest-token',
          user: { id: 'g1', email: '', role: 'Guest' },
          session: { id: 'sg', expiresAt: '' },
        },
      });

      await useAuthStore.getState().checkAuth();

      expect(authApi.createGuestSession).toHaveBeenCalledOnce();
    });

    it('creates guest session on API error', async () => {
      useAuthStore.setState({ token: 'bad-token' });
      vi.mocked(authApi.checkAuth).mockRejectedValueOnce(new Error('Auth failed'));
      vi.mocked(authApi.createGuestSession).mockResolvedValueOnce({
        data: {
          token: 'guest-token',
          user: { id: 'g1', email: '', role: 'Guest' },
          session: { id: 'sg', expiresAt: '' },
        },
      });

      await useAuthStore.getState().checkAuth();

      // createGuestSession clears error internally; verify fallback was triggered
      expect(authApi.createGuestSession).toHaveBeenCalledOnce();
      expect(useAuthStore.getState().token).toBe('guest-token');
    });
  });

  // ─── persist middleware ───

  describe('persist middleware', () => {
    it('persists token, user, session to localStorage on state change', () => {
      useAuthStore.setState({
        token: 'persisted-token',
        refreshToken: 'persisted-rt',
        user: { id: 'u1', email: 'a@b.com', role: 'User' },
        session: { id: 's1', expiresAt: '' },
        guestId: 'g1',
      });

      const raw = localStorage.getItem('auth-storage');
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.state.token).toBe('persisted-token');
      expect(parsed.state.user.email).toBe('a@b.com');
    });
  });
});
