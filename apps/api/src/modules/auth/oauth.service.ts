/**
 * OAuth 2.0 service for Google and GitHub providers.
 * Uses native fetch (no passport.js dependency).
 */
import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { generateRefreshToken, JWT_SECRET } from './service.js';

type OAuthProvider = 'google' | 'github';

interface OAuthProfile {
  provider: OAuthProvider;
  providerAccountId: string;
  email: string;
  name: string | null;
  avatar: string | null;
}

interface OAuthTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: Date | null;
}

export class OAuthError extends Error {
  constructor(
    public statusCode: number,
    message: string
  ) {
    super(message);
    this.name = 'OAuthError';
  }
}

/**
 * Get OAuth authorization URL for a provider.
 */
export function getAuthorizationUrl(provider: OAuthProvider, state: string): string {
  const redirectBase = process.env.OAUTH_REDIRECT_BASE || 'http://localhost:3001/api/v1/auth';

  switch (provider) {
    case 'google': {
      const clientId = process.env.GOOGLE_CLIENT_ID;
      if (!clientId) throw new Error('GOOGLE_CLIENT_ID not configured');
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: `${redirectBase}/callback/google`,
        response_type: 'code',
        scope: 'openid email profile',
        state,
        access_type: 'offline',
        prompt: 'consent',
      });
      return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
    }
    case 'github': {
      const clientId = process.env.GITHUB_CLIENT_ID;
      if (!clientId) throw new Error('GITHUB_CLIENT_ID not configured');
      const params = new URLSearchParams({
        client_id: clientId,
        redirect_uri: `${redirectBase}/callback/github`,
        scope: 'user:email',
        state,
      });
      return `https://github.com/login/oauth/authorize?${params}`;
    }
    default:
      throw new Error(`OAuth provider "${provider}" not supported`);
  }
}

/**
 * Exchange authorization code for tokens and fetch user profile.
 */
export async function exchangeCodeForTokens(
  provider: OAuthProvider,
  code: string
): Promise<{ profile: OAuthProfile; tokens: OAuthTokens }> {
  switch (provider) {
    case 'google':
      return exchangeGoogleCode(code);
    case 'github':
      return exchangeGitHubCode(code);
    default:
      throw new Error(`OAuth provider "${provider}" not supported`);
  }
}

async function exchangeGoogleCode(code: string): Promise<{ profile: OAuthProfile; tokens: OAuthTokens }> {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectBase = process.env.OAUTH_REDIRECT_BASE || 'http://localhost:3001/api/v1/auth';
  if (!clientId || !clientSecret) throw new Error('Google OAuth not configured');

  // Exchange code for tokens
  let tokenRes: Response;
  try {
    tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: `${redirectBase}/callback/google`,
        grant_type: 'authorization_code',
      }),
    });
  } catch {
    throw new OAuthError(503, 'Network error during Google token exchange');
  }

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    logger.error('[OAuth] Google token exchange failed', { error: err });
    throw new OAuthError(400, 'Google token exchange failed');
  }

  const tokenData = await tokenRes.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  // Fetch user profile
  let profileRes: Response;
  try {
    profileRes = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });
  } catch {
    throw new OAuthError(503, 'Network error during Google profile fetch');
  }

  if (!profileRes.ok) throw new OAuthError(502, 'Failed to fetch Google user profile');

  const profileData = await profileRes.json() as {
    id: string;
    email: string;
    name: string;
    picture: string;
  };

  return {
    profile: {
      provider: 'google',
      providerAccountId: profileData.id,
      email: profileData.email,
      name: profileData.name,
      avatar: profileData.picture,
    },
    tokens: {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      expiresAt: new Date(Date.now() + tokenData.expires_in * 1000),
    },
  };
}

async function exchangeGitHubCode(code: string): Promise<{ profile: OAuthProfile; tokens: OAuthTokens }> {
  const clientId = process.env.GITHUB_CLIENT_ID;
  const clientSecret = process.env.GITHUB_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('GitHub OAuth not configured');

  // Exchange code for tokens
  let tokenRes: Response;
  try {
    tokenRes = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        code,
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
  } catch {
    throw new OAuthError(503, 'Network error during GitHub token exchange');
  }

  if (!tokenRes.ok) {
    const err = await tokenRes.text();
    logger.error('[OAuth] GitHub token exchange failed', { error: err });
    throw new OAuthError(400, 'GitHub token exchange failed');
  }

  const tokenData = await tokenRes.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
  };

  if (tokenData.error) throw new OAuthError(400, `GitHub OAuth error: ${tokenData.error}`);

  // Fetch user profile
  let profileRes: Response;
  try {
    profileRes = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${tokenData.access_token}`,
        'User-Agent': 'Studio-App',
      },
    });
  } catch {
    throw new OAuthError(503, 'Network error during GitHub profile fetch');
  }

  if (!profileRes.ok) throw new OAuthError(502, 'Failed to fetch GitHub user profile');

  const profileData = await profileRes.json() as {
    id: number;
    email: string | null;
    name: string | null;
    avatar_url: string;
    login: string;
  };

  // GitHub may not expose email — fetch from /user/emails
  let email = profileData.email;
  if (!email) {
    let emailsRes: Response;
    try {
      emailsRes = await fetch('https://api.github.com/user/emails', {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          'User-Agent': 'Studio-App',
        },
      });
    } catch {
      throw new OAuthError(503, 'Network error during GitHub emails fetch');
    }
    if (emailsRes.ok) {
      const emails = await emailsRes.json() as Array<{ email: string; primary: boolean; verified: boolean }>;
      const primary = emails.find(e => e.primary && e.verified);
      email = primary?.email || emails[0]?.email || null;
    }
  }

  if (!email) throw new OAuthError(502, 'Could not retrieve email from GitHub');

  return {
    profile: {
      provider: 'github',
      providerAccountId: String(profileData.id),
      email,
      name: profileData.name || profileData.login,
      avatar: profileData.avatar_url,
    },
    tokens: {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      expiresAt: tokenData.expires_in ? new Date(Date.now() + tokenData.expires_in * 1000) : null,
    },
  };
}

/**
 * Find existing user by OAuth account, or create new user + OAuth account.
 */
export async function getOrCreateOAuthUser(
  provider: OAuthProvider,
  profile: OAuthProfile,
  tokens: OAuthTokens
): Promise<{ user: { id: string; email: string; role: string } }> {
  // Check if OAuth account already exists
  const existingAccount = await prisma.oAuthAccount.findUnique({
    where: { provider_providerAccountId: { provider, providerAccountId: profile.providerAccountId } },
    include: { User: true },
  });

  if (existingAccount) {
    // Update tokens
    await prisma.oAuthAccount.upsert({
      where: { provider_providerAccountId: { provider, providerAccountId: profile.providerAccountId } },
      update: {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      },
      create: {
        userId: existingAccount.userId,
        provider,
        providerAccountId: profile.providerAccountId,
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: tokens.expiresAt,
      },
    });
    return { user: existingAccount.User as { id: string; email: string; role: string } };
  }

  // Check if user exists by email
  const existingUser = await prisma.user.findUnique({ where: { email: profile.email } });

  let userId: string;
  if (existingUser) {
    // Link OAuth account to existing user
    userId = existingUser.id;
    await prisma.user.update({
      where: { id: userId },
      data: {
        name: existingUser.name || profile.name,
        avatar: existingUser.avatar || profile.avatar,
      },
    });
  } else {
    // Create new user
    const newUser = await prisma.user.create({
      data: {
        email: profile.email,
        name: profile.name,
        avatar: profile.avatar,
        role: 'User',
      },
    });
    userId = newUser.id;
  }

  // Create OAuth account
  await prisma.oAuthAccount.upsert({
    where: { provider_providerAccountId: { provider, providerAccountId: profile.providerAccountId } },
    update: {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    },
    create: {
      userId,
      provider,
      providerAccountId: profile.providerAccountId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
    },
  });

  const user = await prisma.user.findUnique({ where: { id: userId } });
  return { user: user as { id: string; email: string; role: string } };
}

/**
 * Create a session for an OAuth-authenticated user.
 */
export async function createOAuthSession(
  userId: string,
  req: { ip?: string; headers: Record<string, string | undefined> }
): Promise<{ token: string; refreshToken: string; session: { id: string; expiresAt: Date } }> {
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const session = await prisma.session.create({
    data: {
      userId,
      token: '', // placeholder
      ipAddress: req.ip || 'unknown',
      userAgent: req.headers['user-agent'] || 'unknown',
      expiresAt,
    },
  });

  // Generate JWT with session ID
  const token = jwt.sign(
    { sid: session.id, uid: userId },
    JWT_SECRET,
    { expiresIn: '7d' }
  );

  // Update session with actual token
  await prisma.session.update({
    where: { id: session.id },
    data: { token },
  });

  // Generate refresh token
  const refreshTokenValue = await generateRefreshToken(userId);

  return {
    token,
    refreshToken: refreshTokenValue,
    session: { id: session.id, expiresAt },
  };
}
