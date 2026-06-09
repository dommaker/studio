import { useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuthStore } from '../stores/authStore';

/**
 * OAuth callback handler.
 * Backend redirects here with #token=...&refreshToken=...&sessionId=...
 * or ?error=... on failure.
 * Tokens use URL fragment (#) to prevent leakage via Referer header.
 * Errors stay in query params (not sensitive, fragment may be lost on redirect).
 */
export function OAuthCallback() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const setToken = useAuthStore((s) => s.setToken);
  const checkAuth = useAuthStore((s) => s.checkAuth);

  useEffect(() => {
    // Error is in query params (not sensitive)
    const error = searchParams.get('error');
    if (error) {
      console.error('[OAuth] Callback error:', error);
      navigate('/', { replace: true });
      return;
    }

    // Tokens are in URL fragment to prevent Referer leakage
    const hashParams = new URLSearchParams(window.location.hash.substring(1));
    const token = hashParams.get('token');
    const refreshToken = hashParams.get('refreshToken');
    if (!token) {
      console.error('[OAuth] No token in callback');
      navigate('/', { replace: true });
      return;
    }

    // Store token and refresh token, then verify session
    setToken(token, refreshToken || undefined);
    checkAuth().then(() => {
      navigate('/channels', { replace: true });
    });
  }, [searchParams, navigate, setToken, checkAuth]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 text-white">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white"></div>
    </div>
  );
}
