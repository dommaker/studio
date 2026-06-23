import { Router } from 'express';
import crypto from 'crypto';
import * as oauthService from './oauth.service.js';
import { logger } from '@dommaker/studio-shared';

const router = Router();

const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';
const STATE_COOKIE = 'oauth_state';
const STATE_MAX_AGE = 10 * 60 * 1000; // 10 minutes

type OAuthProvider = 'google' | 'github';

/**
 * GET /auth/:provider
 * Redirect to OAuth consent screen (Google or GitHub)
 */
router.get('/:provider(google|github)', (req, res) => {
  const provider = req.params.provider as OAuthProvider;
  const state = crypto.randomBytes(32).toString('hex');

  // Store state in httpOnly cookie for CSRF verification
  res.cookie(STATE_COOKIE, state, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    maxAge: STATE_MAX_AGE,
  });

  try {
    const authUrl = oauthService.getAuthorizationUrl(provider, state);
    res.redirect(authUrl);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown';
    logger.error(`[OAuth] Failed to get ${provider} auth URL`, { error: message });
    res.status(500).json({ error: 'OAuth configuration error' });
  }
});

/**
 * GET /auth/callback/:provider
 * Handle OAuth callback — exchange code, create/find user, redirect to frontend
 */
router.get('/callback/:provider(google|github)', async (req, res) => {
  const provider = req.params.provider as OAuthProvider;
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  const expectedState = req.cookies?.[STATE_COOKIE];

  // Clear state cookie immediately
  res.clearCookie(STATE_COOKIE);

  if (!code) {
    return res.redirect(`${FRONTEND_URL}/auth/callback?error=missing_code`);
  }

  // Verify CSRF state
  if (!state || !expectedState || state !== expectedState) {
    logger.warn(`[OAuth] State mismatch for ${provider}`);
    return res.redirect(`${FRONTEND_URL}/auth/callback?error=invalid_state`);
  }

  try {
    // Exchange code for tokens + fetch profile
    const { profile, tokens } = await oauthService.exchangeCodeForTokens(provider, code);

    // Find or create user linked to this OAuth account
    const { user } = await oauthService.getOrCreateOAuthUser(provider, profile, tokens);

    // Create session
    const { token, refreshToken, session } = await oauthService.createOAuthSession(user.id, {
      ip: req.ip,
      headers: req.headers as Record<string, string | undefined>,
    });

    // Redirect to frontend with token in URL fragment (not query — prevents token leakage via Referer)
    const params = new URLSearchParams({
      token,
      refreshToken,
      sessionId: session.id,
    });
    res.redirect(`${FRONTEND_URL}/auth/callback#${params}`);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'unknown';
    logger.error(`[OAuth] ${provider} callback failed`, { error: message });
    const errorCode = message.includes('exchange') ? 'token_exchange_failed'
      : message.includes('profile') ? 'profile_fetch_failed'
      : message.includes('Unique constraint') ? 'account_conflict'
      : 'oauth_failed';
    res.redirect(`${FRONTEND_URL}/auth/callback?error=${errorCode}`);
  }
});

export default router;
