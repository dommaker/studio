import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { studioDir } from "@dommaker/studio-shared/studio-dir";
import { getStore } from "../../../core/store.js";
import {
  AuthSessionStore,
  type SessionData,
  type UserData,
} from "../auth-session-store.js";

const NOW = new Date("2026-02-01T12:00:00.000Z");
const SESSIONS_FILE = path.join(studioDir(), "sessions.json");
const USERS_FILE = path.join(studioDir(), "users.json");
const AUTH_LOCK = path.join(studioDir(), "auth.lock");

function session(id: string, refreshToken: string | null = null): SessionData {
  return {
    id,
    userId: "u1",
    token: `access-${id}`,
    guestId: null,
    ipAddress: null,
    userAgent: null,
    expiresAt: new Date(NOW.getTime() + 86400000).toISOString(),
    createdAt: new Date(NOW.getTime() - 86400000).toISOString(),
    refreshToken,
    familyId: `family-${id}`,
  };
}

function user(id: string, email: string): UserData {
  return {
    id,
    email,
    passwordHash: null,
    name: null,
    avatar: null,
    role: "User",
    emailVerified: null,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
  };
}

function pinMtimeToWholeSecond(filePath: string): void {
  const seconds = Math.floor(fs.statSync(filePath).mtimeMs / 1000);
  fs.utimesSync(filePath, seconds, seconds);
  expect(fs.statSync(filePath).mtimeMs).toBe(seconds * 1000);
}

/** Simulate another process replacing the file while preserving the cached mtime. */
function replaceFilePreservingMtime(filePath: string, value: unknown): void {
  const stat = fs.statSync(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  fs.utimesSync(filePath, stat.atimeMs / 1000, stat.mtimeMs / 1000);
  expect(fs.statSync(filePath).mtimeMs).toBe(stat.mtimeMs);
}

function readDisk<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

beforeEach(() => {
  fs.rmSync(SESSIONS_FILE, { force: true });
  fs.rmSync(USERS_FILE, { force: true });
  fs.rmSync(AUTH_LOCK, { recursive: true, force: true });
});

afterEach(() => {
  fs.rmSync(AUTH_LOCK, { recursive: true, force: true });
});

describe("AuthSessionStore with real FileStore", () => {
  it("re-reads sessions from disk inside the lock instead of using a stale cached snapshot", async () => {
    const oldSession = session("s-old", "rt-old");
    await getStore().writeJson(SESSIONS_FILE, [oldSession]);
    pinMtimeToWholeSecond(SESSIONS_FILE);
    const store = new AuthSessionStore({ now: () => NOW });
    await expect(store.findSessionById(oldSession.id)).resolves.toMatchObject({ id: oldSession.id });
    const latest = [{ ...oldSession, refreshToken: null, revokedAt: NOW.toISOString() }];
    replaceFilePreservingMtime(SESSIONS_FILE, latest);

    const result = await store.rotateRefreshToken("rt-old", () => "unexpected-new-access");

    expect(result).toBeNull();
    expect(readDisk<SessionData[]>(SESSIONS_FILE)).toEqual(latest);
  });

  it("re-reads users from disk inside registration lock instead of losing an external registration", async () => {
    const existing = user("u-existing", "same@example.test");
    await getStore().writeJson(USERS_FILE, []);
    await getStore().writeJson(SESSIONS_FILE, []);
    pinMtimeToWholeSecond(USERS_FILE);
    const store = new AuthSessionStore({ now: () => NOW });
    await expect(store.findUserByEmail(existing.email)).resolves.toBeNull();
    replaceFilePreservingMtime(USERS_FILE, [existing]);

    await expect(store.register(
      user("u-duplicate", existing.email),
      session("s-duplicate"),
      "rt-duplicate",
    )).rejects.toThrow("邮箱已被注册");
    expect(readDisk<UserData[]>(USERS_FILE)).toEqual([existing]);
    expect(readDisk<SessionData[]>(SESSIONS_FILE)).toEqual([]);
  });

  it("does not lose records when real FileStore locks serialize concurrent writers", async () => {
    await getStore().writeJson(SESSIONS_FILE, []);
    const writers = Array.from({ length: 8 }, () => new AuthSessionStore({ now: () => NOW }));

    await Promise.all(writers.map((store, index) => store.createGuestSession({
      ...session(`s-concurrent-${index}`),
      userId: null,
      guestId: `guest-${index}`,
    })));

    const persisted = readDisk<SessionData[]>(SESSIONS_FILE);
    expect(persisted.map((item) => item.id).sort()).toEqual(
      writers.map((_, index) => `s-concurrent-${index}`).sort(),
    );
  });

  it("keeps same-user families intact across concurrent login, refresh and logout", async () => {
    const oldRefresh = session("s-refresh-old", "rt-refresh-old");
    const revokeTarget = session("s-revoke-target", "rt-revoke-target");
    const stable = session("s-stable", "rt-stable");
    await getStore().writeJson(USERS_FILE, [user("u1", "operator@example.test")]);
    await getStore().writeJson(SESSIONS_FILE, [oldRefresh, revokeTarget, stable]);
    const store = new AuthSessionStore({ now: () => NOW });
    const otherWriter = new AuthSessionStore({ now: () => NOW });

    const results = await Promise.all([
      store.createLoginSession("u1", session("s-login-one"), "rt-login-one"),
      otherWriter.createLoginSession("u1", session("s-login-two"), "rt-login-two"),
      store.rotateRefreshToken("rt-refresh-old", accessTokenForTest),
      store.rotateRefreshToken("rt-refresh-old", accessTokenForTest),
      otherWriter.revokeSession(revokeTarget.id),
    ]);
    const firstRotation = results[2];
    const secondRotation = results[3];
    expect(firstRotation).not.toBeNull();
    expect(secondRotation).toBe(firstRotation);

    const persisted = readDisk<SessionData[]>(SESSIONS_FILE);
    const active = persisted.filter((item) => !item.revokedAt);
    expect(persisted).toHaveLength(5);
    expect(active.map((item) => item.id).sort()).toEqual([
      firstRotation!.session.id,
      "s-login-one",
      "s-login-two",
      "s-stable",
    ].sort());
    expect(active.filter((item) => item.familyId === oldRefresh.familyId)).toHaveLength(1);
    expect(persisted.find((item) => item.id === firstRotation!.session.id)).toMatchObject({
      userId: "u1",
      familyId: oldRefresh.familyId,
      refreshAbsoluteExpiresAt: firstRotation!.session.refreshAbsoluteExpiresAt,
    });
    expect(persisted.find((item) => item.id === oldRefresh.id)).toMatchObject({
      revokedAt: NOW.toISOString(),
      refreshToken: null,
      refreshTokenHash: null,
      consumedAt: NOW.toISOString(),
    });
    expect(persisted.some((item) => item.id === revokeTarget.id)).toBe(false);
    const persistedStable = persisted.find((item) => item.id === stable.id);
    expect(persistedStable).toMatchObject({
      familyId: stable.familyId,
      refreshToken: null,
    });
    expect(persistedStable?.revokedAt).toBeUndefined();
    expect(persistedStable?.refreshTokenHash).toMatch(/^[a-f0-9]{64}$/);
    for (const loginId of ["s-login-one", "s-login-two"]) {
      expect(persisted.find((item) => item.id === loginId)).toMatchObject({
        userId: "u1",
        familyId: `family-${loginId}`,
        revokedAt: null,
      });
    }

    const beforeRetry = structuredClone(persisted);
    await expect(store.rotateRefreshToken("rt-refresh-old", accessTokenForTest)).rejects.toMatchObject({
      code: "REFRESH_ALREADY_ROTATED",
    });
    expect(readDisk<SessionData[]>(SESSIONS_FILE)).toEqual(beforeRetry);
  });
});

function accessTokenForTest(sessionId: string, userId: string): string {
  return `access:${sessionId}:${userId}`;
}
