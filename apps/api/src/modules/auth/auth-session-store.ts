import * as crypto from "node:crypto";
import * as path from "node:path";
import { studioDir } from "@dommaker/studio-shared/studio-dir";
import { getStore } from "../../core/store.js";

export interface UserData {
  id: string;
  email: string;
  passwordHash: string | null;
  name: string | null;
  avatar: string | null;
  role: string;
  emailVerified: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionData {
  id: string;
  userId: string | null;
  token: string;
  guestId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
  /** Idle expiry for both access and refresh; rotation extends it within the absolute cap. */
  expiresAt: string;
  createdAt: string;
  /** Legacy plaintext input only; every write migrates it to refreshTokenHash. */
  refreshToken: string | null;
  refreshTokenHash?: string | null;
  familyId?: string;
  refreshAbsoluteExpiresAt?: string;
  revokedAt?: string | null;
  consumedRefreshTokenHash?: string | null;
  consumedAt?: string | null;
  refreshRetryUntil?: string | null;
}

export interface RefreshRotation {
  accessToken: string;
  refreshToken: string;
  userId: string;
  session: SessionData;
}

export class RefreshTokenRetryError extends Error {
  readonly code = "REFRESH_ALREADY_ROTATED";
  readonly retryAfterSeconds = 1;

  constructor() {
    super("Refresh token already rotated; retry with the latest credentials");
    this.name = "RefreshTokenRetryError";
  }
}

interface AuthSessionStoreOptions {
  now?: () => Date;
}

const STUDIO_DIR = studioDir();
const USERS_FILE = path.join(STUDIO_DIR, "users.json");
const SESSIONS_FILE = path.join(STUDIO_DIR, "sessions.json");
const AUTH_LOCK = path.join(STUDIO_DIR, "auth.lock");

export const REFRESH_TOKEN_ABSOLUTE_EXPIRY_DAYS = 30;
export const REFRESH_TOKEN_IDLE_EXPIRY_DAYS = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const ABSOLUTE_EXPIRY_MS = REFRESH_TOKEN_ABSOLUTE_EXPIRY_DAYS * DAY_MS;
export const REFRESH_TOKEN_IDLE_EXPIRY_MS = REFRESH_TOKEN_IDLE_EXPIRY_DAYS * DAY_MS;
const ROTATED_RETRY_WINDOW_MS = 30 * 1000;

function hashRefreshToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function timestamp(value: string | null | undefined): number {
  if (!value) return Number.NaN;
  return new Date(value).getTime();
}

function isActive(session: SessionData, nowMs: number): boolean {
  return !session.revokedAt && timestamp(session.expiresAt) > nowMs;
}

function absoluteExpiry(session: SessionData): string {
  if (session.refreshAbsoluteExpiresAt) return session.refreshAbsoluteExpiresAt;
  // Legacy rows keep their original 30-day absolute window instead of gaining 30 days on first use.
  return new Date(timestamp(session.createdAt) + ABSOLUTE_EXPIRY_MS).toISOString();
}

function publicRotation(session: SessionData, accessToken: string, refreshToken: string): RefreshRotation {
  return { accessToken, refreshToken, userId: session.userId!, session };
}

/** Sole writer for users.json and sessions.json. All read-modify-write sequences share one lock. */
export class AuthSessionStore {
  private readonly clock: () => Date;
  private readonly rotations = new Map<string, Promise<RefreshRotation | null>>();

  constructor(options: AuthSessionStoreOptions = {}) {
    this.clock = options.now ?? (() => new Date());
  }

  private now(): Date {
    return new Date(this.clock().getTime());
  }

  private async readUsersCached(): Promise<UserData[]> {
    return (await getStore().readJson<UserData[]>(USERS_FILE)) ?? [];
  }

  private async readSessionsCached(): Promise<SessionData[]> {
    return (await getStore().readJson<SessionData[]>(SESSIONS_FILE)) ?? [];
  }

  /** Call only while holding AUTH_LOCK: mtime-cached snapshots are not rotation/write truth. */
  private async readUsersBare(): Promise<UserData[]> {
    return (await getStore().readJsonUncached<UserData[]>(USERS_FILE)) ?? [];
  }

  /** Call only while holding AUTH_LOCK: mtime-cached snapshots are not rotation/write truth. */
  private async readSessionsBare(): Promise<SessionData[]> {
    return (await getStore().readJsonUncached<SessionData[]>(SESSIONS_FILE)) ?? [];
  }

  async findUserByEmail(email: string): Promise<UserData | null> {
    return (await this.readUsersCached()).find((user) => user.email === email) ?? null;
  }

  async findUserById(id: string): Promise<UserData | null> {
    return (await this.readUsersCached()).find((user) => user.id === id) ?? null;
  }

  async findSessionById(id: string): Promise<SessionData | null> {
    return (await this.readSessionsCached()).find((session) => session.id === id) ?? null;
  }

  async findSessionByGuestId(guestId: string): Promise<SessionData | null> {
    return (await this.readSessionsCached()).find((session) => session.guestId === guestId) ?? null;
  }

  private prepareSession(session: SessionData, refreshToken: string, now: Date): SessionData {
    const absolute = absoluteExpiry(session);
    if (!session.refreshAbsoluteExpiresAt) {
      // New login/register rows have createdAt=now; legacy rows use their original creation time.
      session.refreshAbsoluteExpiresAt = absolute;
    }
    session.familyId ??= session.id;
    session.refreshTokenHash = hashRefreshToken(refreshToken);
    session.refreshToken = null;
    session.revokedAt = null;
    return session;
  }

  private async writeSessionsLocked(sessions: SessionData[]): Promise<void> {
    const nowMs = this.now().getTime();
    const migrated = sessions.map((session) => {
      if (!session.refreshToken) return session;
      return {
        ...session,
        refreshToken: null,
        refreshTokenHash: hashRefreshToken(session.refreshToken),
      };
    });
    const kept = migrated.filter((session) => {
      const retryUntil = timestamp(session.refreshRetryUntil);
      return isActive(session, nowMs) || (session.consumedRefreshTokenHash != null && retryUntil > nowMs);
    });
    await getStore().writeJson(SESSIONS_FILE, kept);
  }

  async createGuestSession(session: SessionData): Promise<void> {
    await getStore().withLock(AUTH_LOCK, async () => {
      const sessions = await this.readSessionsBare();
      sessions.push(session);
      await this.writeSessionsLocked(sessions);
    });
  }

  async createLoginSession(
    userId: string,
    session: SessionData,
    refreshToken: string,
    upgradedPasswordHash?: string,
  ): Promise<void> {
    await getStore().withLock(AUTH_LOCK, async () => {
      if (upgradedPasswordHash) {
        const users = await this.readUsersBare();
        const index = users.findIndex((user) => user.id === userId);
        if (index >= 0) {
          users[index] = { ...users[index], passwordHash: upgradedPasswordHash };
          await getStore().writeJson(USERS_FILE, users);
        }
      }
      const now = this.now();
      const nowMs = now.getTime();
      const sessions = (await this.readSessionsBare()).filter((candidate) =>
        !(candidate.userId === userId && candidate.guestId && isActive(candidate, nowMs))
      );
      sessions.push(this.prepareSession(session, refreshToken, now));
      await this.writeSessionsLocked(sessions);
    });
  }

  async register(user: UserData, session: SessionData, refreshToken: string): Promise<void> {
    await getStore().withLock(AUTH_LOCK, async () => {
      const users = await this.readUsersBare();
      if (users.some((candidate) => candidate.email === user.email)) {
        throw new Error("邮箱已被注册");
      }
      const sessions = await this.readSessionsBare();
      users.push(user);
      sessions.push(this.prepareSession(session, refreshToken, this.now()));
      await getStore().writeJson(USERS_FILE, users);
      await this.writeSessionsLocked(sessions);
    });
  }

  async setRefreshToken(sessionId: string, refreshToken: string): Promise<boolean> {
    return getStore().withLock(AUTH_LOCK, async () => {
      const sessions = await this.readSessionsBare();
      const session = sessions.find((candidate) => candidate.id === sessionId);
      if (!session || !isActive(session, this.now().getTime())) return false;
      this.prepareSession(session, refreshToken, this.now());
      await this.writeSessionsLocked(sessions);
      return true;
    });
  }

  rotateRefreshToken(
    oldToken: string,
    createAccessToken: (sessionId: string, userId: string) => string,
    authorizeUser?: (userId: string, users: UserData[]) => Promise<boolean>,
  ): Promise<RefreshRotation | null> {
    const tokenHash = hashRefreshToken(oldToken);
    const pending = this.rotations.get(tokenHash);
    if (pending) return pending;

    const rotation = this.rotateOnce(oldToken, tokenHash, createAccessToken, authorizeUser);
    this.rotations.set(tokenHash, rotation);
    void rotation.finally(() => {
      if (this.rotations.get(tokenHash) === rotation) this.rotations.delete(tokenHash);
    }).catch(() => {});
    return rotation;
  }

  private async rotateOnce(
    oldToken: string,
    tokenHash: string,
    createAccessToken: (sessionId: string, userId: string) => string,
    authorizeUser?: (userId: string, users: UserData[]) => Promise<boolean>,
  ): Promise<RefreshRotation | null> {
    return getStore().withLock(AUTH_LOCK, async () => {
      const sessions = await this.readSessionsBare();
      const oldSession = sessions.find((session) =>
        session.refreshTokenHash === tokenHash || session.refreshToken === oldToken
      );
      if (!oldSession) {
        const consumed = sessions.find((session) =>
          session.consumedRefreshTokenHash === tokenHash
          && timestamp(session.refreshRetryUntil) > this.now().getTime()
        );
        if (consumed) throw new RefreshTokenRetryError();
        return null;
      }

      const now = this.now();
      const nowMs = now.getTime();
      const absolute = absoluteExpiry(oldSession);
      if (
        !oldSession.userId
        || !isActive(oldSession, nowMs)
        || timestamp(absolute) <= nowMs
      ) return null;
      if (authorizeUser) {
        const users = await this.readUsersBare();
        if (!(await authorizeUser(oldSession.userId, users))) return null;
      }

      const newRefreshToken = crypto.randomBytes(64).toString("hex");
      const newSessionId = crypto.randomUUID();
      const accessToken = createAccessToken(newSessionId, oldSession.userId);
      const newExpiresAt = Math.min(nowMs + REFRESH_TOKEN_IDLE_EXPIRY_MS, timestamp(absolute));
      const familyId = oldSession.familyId ?? oldSession.id;
      const newSession: SessionData = {
        id: newSessionId,
        userId: oldSession.userId,
        token: accessToken,
        guestId: null,
        ipAddress: oldSession.ipAddress,
        userAgent: oldSession.userAgent,
        expiresAt: new Date(newExpiresAt).toISOString(),
        createdAt: now.toISOString(),
        refreshToken: null,
        refreshTokenHash: hashRefreshToken(newRefreshToken),
        familyId,
        refreshAbsoluteExpiresAt: absolute,
        revokedAt: null,
      };

      oldSession.refreshToken = null;
      oldSession.refreshTokenHash = null;
      oldSession.familyId = familyId;
      oldSession.refreshAbsoluteExpiresAt = absolute;
      oldSession.revokedAt = now.toISOString();
      oldSession.expiresAt = now.toISOString();
      oldSession.consumedRefreshTokenHash = tokenHash;
      oldSession.consumedAt = now.toISOString();
      oldSession.refreshRetryUntil = new Date(nowMs + ROTATED_RETRY_WINDOW_MS).toISOString();
      sessions.push(newSession);
      await this.writeSessionsLocked(sessions);
      return publicRotation(newSession, accessToken, newRefreshToken);
    });
  }

  async revokeSession(sessionId: string): Promise<void> {
    await getStore().withLock(AUTH_LOCK, async () => {
      const sessions = await this.readSessionsBare();
      const current = sessions.find((session) => session.id === sessionId);
      if (!current) return;
      const familyId = current.familyId ?? current.id;
      const now = this.now().toISOString();
      for (const session of sessions) {
        if ((session.familyId ?? session.id) !== familyId) continue;
        session.refreshToken = null;
        session.refreshTokenHash = null;
        session.revokedAt = now;
        session.expiresAt = now;
      }
      await this.writeSessionsLocked(sessions);
    });
  }

  async revokeRefreshToken(refreshToken: string): Promise<boolean> {
    return getStore().withLock(AUTH_LOCK, async () => {
      const tokenHash = hashRefreshToken(refreshToken);
      const sessions = await this.readSessionsBare();
      const current = sessions.find((session) =>
        session.refreshTokenHash === tokenHash || session.refreshToken === refreshToken
      );
      if (!current) return false;
      const familyId = current.familyId ?? current.id;
      const now = this.now().toISOString();
      for (const session of sessions) {
        if ((session.familyId ?? session.id) !== familyId) continue;
        session.refreshToken = null;
        session.refreshTokenHash = null;
        session.revokedAt = now;
        session.expiresAt = now;
      }
      await this.writeSessionsLocked(sessions);
      return true;
    });
  }

  async cleanupExpiredSessions(): Promise<number> {
    return getStore().withLock(AUTH_LOCK, async () => {
      const sessions = await this.readSessionsBare();
      const nowMs = this.now().getTime();
      const kept = sessions.filter((session) => {
        const retryUntil = timestamp(session.refreshRetryUntil);
        return isActive(session, nowMs) || (session.consumedRefreshTokenHash != null && retryUntil > nowMs);
      });
      const count = sessions.length - kept.length;
      if (count > 0) await getStore().writeJson(SESSIONS_FILE, kept);
      return count;
    });
  }
}
