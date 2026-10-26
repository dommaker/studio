import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionData } from "../auth-session-store.js";

const mockReadJson = vi.hoisted(() => vi.fn());
const mockReadJsonUncached = vi.hoisted(() => vi.fn());
const mockWriteJson = vi.hoisted(() => vi.fn());
const mockWithLock = vi.hoisted(() => vi.fn());

vi.mock("@dommaker/studio-shared", () => ({
  FileStore: vi.fn().mockImplementation(function () {
    return {
      readJson: mockReadJson,
      readJsonUncached: mockReadJsonUncached,
      writeJson: mockWriteJson,
      withLock: mockWithLock,
    };
  }),
}));

import {
  AuthSessionStore,
  RefreshTokenRetryError,
} from "../auth-session-store.js";

const INITIAL_NOW = new Date("2026-01-15T12:00:00.000Z");
let now: Date;
let sessions: SessionData[];
let users: unknown[];

function session(id: string, refreshToken: string | null, patch: Partial<SessionData> = {}): SessionData {
  return {
    id,
    userId: "u1",
    token: `access-${id}`,
    guestId: null,
    ipAddress: null,
    userAgent: null,
    expiresAt: new Date(now.getTime() + 86400000).toISOString(),
    createdAt: new Date(now.getTime() - 86400000).toISOString(),
    refreshToken,
    familyId: `family-${id}`,
    ...patch,
  };
}

function accessToken(sessionId: string, userId: string): string {
  return `access:${sessionId}:${userId}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  now = new Date(INITIAL_NOW);
  sessions = [];
  users = [];
  const read = async (filePath: string) => {
    if (filePath.includes("users.json")) return structuredClone(users);
    if (filePath.includes("sessions.json")) return structuredClone(sessions);
    return null;
  };
  mockReadJson.mockImplementation(read);
  mockReadJsonUncached.mockImplementation(read);
  mockWriteJson.mockImplementation(async (filePath: string, data: unknown) => {
    if (filePath.includes("users.json")) users = structuredClone(data as unknown[]);
    if (filePath.includes("sessions.json")) sessions = structuredClone(data as SessionData[]);
  });
  let lockTail = Promise.resolve();
  mockWithLock.mockImplementation(async (_path: string, fn: () => Promise<unknown>) => {
    const previous = lockTail;
    let release!: () => void;
    lockTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await fn(); } finally { release(); }
  });
});

describe("AuthSessionStore refresh rotation", () => {
  it("keeps lock-free lookups on the cached read path", async () => {
    sessions = [session("s-cached-read", null)];
    const store = new AuthSessionStore({ now: () => now });

    await expect(store.findSessionById("s-cached-read")).resolves.toMatchObject({ id: "s-cached-read" });
    expect(mockReadJson).toHaveBeenCalled();
    expect(mockReadJsonUncached).not.toHaveBeenCalled();
  });

  it("uses the injected clock and keeps legacy absolute expiry anchored to creation", async () => {
    sessions = [session("s-legacy", "rt-legacy")];
    const store = new AuthSessionStore({ now: () => now });

    const result = await store.rotateRefreshToken("rt-legacy", accessToken);

    expect(result).not.toBeNull();
    expect(result!.session.createdAt).toBe(INITIAL_NOW.toISOString());
    expect(result!.session.expiresAt).toBe("2026-01-22T12:00:00.000Z");
    expect(result!.session.refreshAbsoluteExpiresAt).toBe("2026-02-13T12:00:00.000Z");
    expect(result!.session.familyId).toBe("family-s-legacy");
    expect(sessions.some((item) => item.refreshToken === "rt-legacy" || item.refreshToken === result!.refreshToken)).toBe(false);
  });

  it("caps idle extension at the existing absolute expiry", async () => {
    sessions = [session("s-cap", "rt-cap", {
      refreshAbsoluteExpiresAt: "2026-01-17T12:00:00.000Z",
    })];
    const store = new AuthSessionStore({ now: () => now });

    const result = await store.rotateRefreshToken("rt-cap", accessToken);

    expect(result!.session.expiresAt).toBe("2026-01-17T12:00:00.000Z");
  });

  it("rejects idle and absolute expiry without any state write", async () => {
    const store = new AuthSessionStore({ now: () => now });
    for (const expired of [
      session("s-idle", "rt-idle", { expiresAt: new Date(now.getTime() - 1).toISOString() }),
      session("s-absolute", "rt-absolute", {
        refreshAbsoluteExpiresAt: new Date(now.getTime() - 1).toISOString(),
      }),
    ]) {
      sessions = [expired];
      const before = structuredClone(sessions);
      await expect(store.rotateRefreshToken(expired.refreshToken!, accessToken)).resolves.toBeNull();
      expect(sessions).toEqual(before);
      expect(mockWriteJson).not.toHaveBeenCalled();
    }
  });

  it("shares one in-flight rotation and revokes the old access session", async () => {
    sessions = [session("s-race", "rt-race")];
    const store = new AuthSessionStore({ now: () => now });

    const [first, second] = await Promise.all([
      store.rotateRefreshToken("rt-race", accessToken),
      store.rotateRefreshToken("rt-race", accessToken),
    ]);

    expect(second).toBe(first);
    expect(sessions.filter((item) => !item.revokedAt)).toHaveLength(1);
    const old = sessions.find((item) => item.id === "s-race");
    expect(old?.revokedAt).toBe(INITIAL_NOW.toISOString());
    expect(old?.consumedRefreshTokenHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns an explicit retry for a recently consumed token but ignores random invalid tokens", async () => {
    sessions = [session("s-consumed", "rt-consumed")];
    const store = new AuthSessionStore({ now: () => now });
    const rotated = await store.rotateRefreshToken("rt-consumed", accessToken);
    const before = structuredClone(sessions);

    await expect(store.rotateRefreshToken("rt-consumed", accessToken)).rejects.toBeInstanceOf(RefreshTokenRetryError);
    expect(sessions).toEqual(before);
    await expect(store.rotateRefreshToken("rt-random", accessToken)).resolves.toBeNull();
    expect(sessions).toEqual(before);
    await expect(store.rotateRefreshToken(rotated!.refreshToken, accessToken)).resolves.not.toBeNull();
  });

  it("expires the retry marker instead of treating an old token as valid forever", async () => {
    sessions = [session("s-retry", "rt-retry")];
    const store = new AuthSessionStore({ now: () => now });
    await store.rotateRefreshToken("rt-retry", accessToken);
    now = new Date(now.getTime() + 31000);

    await expect(store.rotateRefreshToken("rt-retry", accessToken)).resolves.toBeNull();
  });
});

describe("AuthSessionStore family revocation", () => {
  it("revokes only the selected family", async () => {
    sessions = [session("s-one", "rt-one"), session("s-two", "rt-two")];
    const store = new AuthSessionStore({ now: () => now });

    await store.revokeSession("s-one");

    expect(sessions.some((item) => item.id === "s-one")).toBe(false);
    expect(sessions.find((item) => item.id === "s-two")?.revokedAt).toBeUndefined();
    await expect(store.rotateRefreshToken("rt-two", accessToken)).resolves.not.toBeNull();
    await expect(store.rotateRefreshToken("rt-one", accessToken)).resolves.toBeNull();
  });
});
