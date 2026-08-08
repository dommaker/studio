import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../api', () => ({
  authApi: {
    checkAuth: vi.fn(),
    createGuestSession: vi.fn(),
  },
}));

import { useAuthStore } from '../../stores/authStore';
import { OAuthCallback } from '../OAuthCallback';
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

function resetUrl() {
  window.location.hash = '';
}

function renderCb(entry = '/callback') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <OAuthCallback />
    </MemoryRouter>
  );
}

describe('OAuthCallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetStore();
    resetUrl();
  });

  it('renders spinner', () => {
    window.location.hash = '#token=x';
    const { container } = renderCb();
    expect(container.querySelector('.animate-spin')).not.toBeNull();
  });

  describe('error query param', () => {
    it('logs callback error', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      renderCb('/callback?error=access_denied');
      await waitFor(() => {
        expect(spy).toHaveBeenCalledWith('[OAuth] Callback error:', 'access_denied');
      });
      spy.mockRestore();
    });
  });

  describe('missing token', () => {
    it('logs warning on missing hash token', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      window.location.hash = '#nope=x';
      renderCb();
      await waitFor(() => {
        expect(spy).toHaveBeenCalledWith('[OAuth] No token in callback');
      });
      spy.mockRestore();
    });

    it('logs warning on empty hash', async () => {
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      renderCb();
      await waitFor(() => {
        expect(spy).toHaveBeenCalledWith('[OAuth] No token in callback');
      });
      spy.mockRestore();
    });
  });

  describe('token from fragment', () => {
    it('stores token in authStore from hash', async () => {
      window.location.hash = '#token=access_jwt';
      renderCb();
      await waitFor(() => {
        expect(useAuthStore.getState().token).toBe('access_jwt');
      });
    });

    it('stores refreshToken in authStore from hash', async () => {
      window.location.hash = '#token=t&refreshToken=rt';
      renderCb();
      await waitFor(() => {
        expect(useAuthStore.getState().token).toBe('t');
      });
      expect(useAuthStore.getState().refreshToken).toBe('rt');
    });

    it('calls authApi.checkAuth after storing token', async () => {
      vi.mocked(authApi.checkAuth).mockResolvedValue({
        data: { user: { id: 'u1', email: 'a@b.com', role: 'User' } },
      });
      window.location.hash = '#token=abc';
      renderCb();

      await waitFor(() => {
        expect(authApi.checkAuth).toHaveBeenCalledOnce();
      });
      // checkAuth resolved — user stored
      await waitFor(() => {
        expect(useAuthStore.getState().user?.email).toBe('a@b.com');
      });
    });
  });
});
