/**
 * Auth middleware unit tests
 *
 * AC1: workspaceAuth() — Bearer token → sha256 → WorkspaceToken (FileStore) → req.workspace
 * AC2: checkOwnership(model, paramKey) — owner match / non-owner 403 / Admin bypass / invalid model
 * AC3: requireNotGuest() — Guest 403 / non-Guest pass
 * AC4: generateAnonymousId() — IP+UA+date hash consistency (SEC-009)
 *
 * 存储迁移后（Prisma → FileStore）：token/workspace/document 均通过
 * FileStore.readJson 读取 JSON 文件，测试 mock FileStore 而非 prisma。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';

// Mock FileStore — auth.ts 在模块级 `new FileStore()`，实例方法统一走 hoisted mock
const mockReadJson = vi.hoisted(() => vi.fn());

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    FileStore: vi.fn().mockImplementation(function () { return {
      readJson: mockReadJson,
    }; }),
  };
});

vi.mock('../../../utils/logger.js', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { workspaceAuth, checkOwnership, requireNotGuest, generateAnonymousId, optionalAuth, requireAuth, requireRole, requireAdmin } from '../auth.js';

// ---------------------------------------------------------------------------
// AC1: workspaceAuth()
// ---------------------------------------------------------------------------
describe('workspaceAuth', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    req = { headers: {}, socket: {} as any };
    res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    next = vi.fn();
  });

  it('returns a middleware function', () => {
    const middleware = workspaceAuth();
    expect(typeof middleware).toBe('function');
  });

  it('returns 401 when no Bearer token', async () => {
    const middleware = workspaceAuth();
    await middleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'MISSING_WORKSPACE_TOKEN' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('queries WorkspaceToken with sha256 hash of Bearer token', async () => {
    const token = 'st_mach_test_token';
    const expectedHash = crypto.createHash('sha256').update(token).digest('hex');
    // FileStore: 先读 workspace-tokens/<hash>.json，再读 workspaces/<workspaceId>.json
    mockReadJson.mockResolvedValueOnce({
      id: 'wt1',
      tokenHash: expectedHash,
      workspaceId: 'ws1',
      revokedAt: null,
    });
    mockReadJson.mockResolvedValueOnce({ id: 'ws1', name: 'test-workspace' });
    req.headers = { authorization: `Bearer ${token}` };

    const middleware = workspaceAuth();
    await middleware(req as Request, res as Response, next);

    expect(mockReadJson).toHaveBeenCalledWith(
      expect.stringContaining(`${expectedHash}.json`),
    );
    expect(next).toHaveBeenCalled();
  });

  it('returns 401 when token not found in FileStore', async () => {
    mockReadJson.mockResolvedValueOnce(null);
    req.headers = { authorization: 'Bearer st_mach_unknown_token' };

    const middleware = workspaceAuth();
    await middleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'INVALID_WORKSPACE_TOKEN' }),
    );
  });

  it('returns 401 when token is revoked', async () => {
    mockReadJson.mockResolvedValueOnce({
      id: 'wt1',
      tokenHash: 'hash',
      workspaceId: 'ws1',
      revokedAt: new Date().toISOString(),
    });
    req.headers = { authorization: 'Bearer st_mach_revoked_token' };

    const middleware = workspaceAuth();
    await middleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'WORKSPACE_TOKEN_REVOKED' }),
    );
  });

  it('returns 401 when token has no registered workspace', async () => {
    mockReadJson.mockResolvedValueOnce({
      id: 'wt1',
      tokenHash: 'hash',
      workspaceId: 'ws-missing',
      revokedAt: null,
    });
    // workspaces/<id>.json 不存在 → readJson 返回 null
    mockReadJson.mockResolvedValueOnce(null);
    req.headers = { authorization: 'Bearer st_mach_no_ws_token' };

    const middleware = workspaceAuth();
    await middleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'WORKSPACE_NOT_FOUND' }),
    );
  });

  it('injects workspace and workspaceToken into req on success', async () => {
    const mockWorkspace = { id: 'ws1', name: 'test-workspace' };
    const mockToken = { id: 'wt1', tokenHash: 'hash', workspaceId: 'ws1', revokedAt: null };
    mockReadJson.mockResolvedValueOnce(mockToken);
    mockReadJson.mockResolvedValueOnce(mockWorkspace);
    req.headers = { authorization: 'Bearer st_mach_valid_token' };

    const middleware = workspaceAuth();
    await middleware(req as Request, res as Response, next);

    const authReq = req as any;
    expect(authReq.workspace).toEqual(mockWorkspace);
    expect(authReq.workspaceToken).toEqual(mockToken);
    expect(next).toHaveBeenCalled();
  });

  it('returns 500 on unexpected FileStore error', async () => {
    mockReadJson.mockRejectedValueOnce(new Error('FS read failed'));
    req.headers = { authorization: 'Bearer st_mach_err_token' };

    const middleware = workspaceAuth();
    await middleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'WORKSPACE_AUTH_ERROR' }),
    );
  });
});

// ---------------------------------------------------------------------------
// AC2: checkOwnership(model, paramKey)
// ---------------------------------------------------------------------------
describe('checkOwnership', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    req = { headers: {}, params: {}, socket: {} as any };
    res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    next = vi.fn();
  });

  it('returns 401 when user not logged in', async () => {
    const middleware = checkOwnership('document');
    req.params = { id: 'doc1' };

    await middleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'UNAUTHORIZED' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when user is Admin (bypass ownership check)', async () => {
    (req as any).user = { id: 'u1', role: 'Admin' };
    const middleware = checkOwnership('document');

    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('returns 400 when resource ID is missing from params', async () => {
    (req as any).user = { id: 'u1', role: 'User' };
    const middleware = checkOwnership('document');

    await middleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'MISSING_RESOURCE_ID' }),
    );
  });

  it('returns 404 when resource not found in FileStore', async () => {
    (req as any).user = { id: 'u1', role: 'User' };
    req.params = { id: 'nonexistent' };
    // documents/<id>.json 不存在 → readJson 返回 null → creatorId undefined
    mockReadJson.mockResolvedValueOnce(null);

    const middleware = checkOwnership('document');
    await middleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'RESOURCE_NOT_FOUND' }),
    );
  });

  it('returns 403 when resource uses createdBy field and mismatches', async () => {
    (req as any).user = { id: 'u1', role: 'User' };
    req.params = { id: 'doc1' };
    mockReadJson.mockResolvedValueOnce({
      createdBy: 'other-user',
    });

    const middleware = checkOwnership('document');
    await middleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
  });

  it('calls next() when user owns the resource via createdBy', async () => {
    (req as any).user = { id: 'u1', role: 'User' };
    req.params = { id: 'doc1' };
    mockReadJson.mockResolvedValueOnce({
      createdBy: 'u1',
    });

    const middleware = checkOwnership('document');
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('uses custom paramKey to extract resource ID', async () => {
    (req as any).user = { id: 'u1', role: 'User' };
    req.params = { docId: 'd1' };
    mockReadJson.mockResolvedValueOnce({
      createdBy: 'u1',
    });

    const middleware = checkOwnership('document', 'docId');
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('returns 500 for invalid model name (runtime error)', async () => {
    (req as any).user = { id: 'u1', role: 'User' };
    req.params = { id: 'ws1' };

    const middleware = checkOwnership('nonexistentModel');
    await middleware(req as Request, res as Response, next);

    // findResourceCreator 不支持的 model → throw → catch → 500
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'AUTH_CHECK_ERROR' }),
    );
  });
});

// ---------------------------------------------------------------------------
// requireRole none 模式修复 + requireAdmin（2026-07）
// ---------------------------------------------------------------------------
describe('requireRole / requireAdmin', () => {
  const OLD_AUTH = process.env.STUDIO_AUTH;
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    req = { headers: {} };
    res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    next = vi.fn();
  });

  afterEach(() => {
    process.env.STUDIO_AUTH = OLD_AUTH;
  });

  it('requireRole: STUDIO_AUTH=none 本地模式直接放行（无 session 也不 401）', async () => {
    process.env.STUDIO_AUTH = 'none';
    const middleware = requireRole('Admin');
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    // 注入本地 Admin 用户供下游使用
    expect((req as any).user?.role).toBe('Admin');
  });

  it('requireRole: unset STUDIO_AUTH 默认为 none，同样放行', async () => {
    delete process.env.STUDIO_AUTH;
    const middleware = requireRole('Admin');
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('requireAdmin: none 模式直接放行', async () => {
    process.env.STUDIO_AUTH = 'none';
    const middleware = requireAdmin();
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('requireAdmin: 认证开启时无 session 返回 401', async () => {
    process.env.STUDIO_AUTH = 'on';
    const middleware = requireAdmin();
    await middleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('requireAdmin: 认证开启时 Guest 角色返回 403', async () => {
    process.env.STUDIO_AUTH = 'on';
    (req as any).session = { id: 's1', userId: 'u1' };
    (req as any).user = { id: 'u1', role: 'Guest' };
    const middleware = requireAdmin();
    await middleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'FORBIDDEN' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('requireAdmin: 认证开启时 Admin 角色放行', async () => {
    process.env.STUDIO_AUTH = 'on';
    (req as any).session = { id: 's1', userId: 'u1' };
    (req as any).user = { id: 'u1', role: 'Admin' };
    const middleware = requireAdmin();
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });
});


describe('requireNotGuest', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let next: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    req = { headers: {} };
    res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
    next = vi.fn();
  });

  it('returns 403 when user is not logged in', async () => {
    const middleware = requireNotGuest();
    await middleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'GUEST_FORBIDDEN' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 403 when user has Guest role', async () => {
    (req as any).user = { id: 'u1', role: 'Guest' };
    const middleware = requireNotGuest();
    await middleware(req as Request, res as Response, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'GUEST_FORBIDDEN' }),
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next() when user has User role', async () => {
    (req as any).user = { id: 'u1', role: 'User' };
    const middleware = requireNotGuest();
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });

  it('calls next() when user has Admin role', async () => {
    (req as any).user = { id: 'u1', role: 'Admin' };
    const middleware = requireNotGuest();
    await middleware(req as Request, res as Response, next);

    expect(next).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// AC-A1: STUDIO_AUTH env var switch (Spec 4 Phase 1)
// ---------------------------------------------------------------------------
describe('STUDIO_AUTH env var', () => {
  const originalEnv = process.env.STUDIO_AUTH;

  afterEach(() => {
    process.env.STUDIO_AUTH = originalEnv;
  });

  describe('optionalAuth', () => {
    let req: Partial<Request>;
    let res: Partial<Response>;
    let next: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.clearAllMocks();
      req = { headers: {}, socket: {} as any };
      res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      next = vi.fn();
    });

    it('STUDIO_AUTH=none: injects local user and calls next()', async () => {
      process.env.STUDIO_AUTH = 'none';
      const mw = optionalAuth();
      await mw(req as Request, res as Response, next);

      const authReq = req as any;
      expect(authReq.user).toEqual({ id: 'local', role: 'Admin', name: 'Local User' });
      expect(next).toHaveBeenCalled();
    });

    it('STUDIO_AUTH=none: does NOT call session lookup or verifyToken', async () => {
      process.env.STUDIO_AUTH = 'none';
      req.headers = { authorization: 'Bearer some-token' };
      const mw = optionalAuth();
      await mw(req as Request, res as Response, next);

      // Even with a Bearer token, none mode skips all auth checks
      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    it('STUDIO_AUTH=on: falls through to session validation', async () => {
      process.env.STUDIO_AUTH = 'on';
      const mw = optionalAuth();
      await mw(req as Request, res as Response, next);

      // No token → optionalAuth should still call next() (optional means optional)
      expect(next).toHaveBeenCalled();
      // anonymousId should be generated
      expect((req as any).anonymousId).toBeDefined();
    });

    it('unset STUDIO_AUTH defaults to none', async () => {
      delete process.env.STUDIO_AUTH;
      const mw = optionalAuth();
      await mw(req as Request, res as Response, next);

      expect((req as any).user).toEqual({ id: 'local', role: 'Admin', name: 'Local User' });
      expect(next).toHaveBeenCalled();
    });
  });

  describe('requireAuth', () => {
    let req: Partial<Request>;
    let res: Partial<Response>;
    let next: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      vi.clearAllMocks();
      req = { headers: {}, socket: {} as any };
      res = { status: vi.fn().mockReturnThis(), json: vi.fn() };
      next = vi.fn();
    });

    it('STUDIO_AUTH=none: injects local user and calls next()', async () => {
      process.env.STUDIO_AUTH = 'none';
      const mw = requireAuth();
      await mw(req as Request, res as Response, next);

      expect((req as any).user).toEqual({ id: 'local', role: 'Admin', name: 'Local User' });
      expect(next).toHaveBeenCalled();
    });

    it('STUDIO_AUTH=none: does NOT return 401 even without token', async () => {
      process.env.STUDIO_AUTH = 'none';
      const mw = requireAuth();
      await mw(req as Request, res as Response, next);

      expect(res.status).not.toHaveBeenCalled();
      expect(next).toHaveBeenCalled();
    });

    it('STUDIO_AUTH=on: returns 401 when no token present', async () => {
      process.env.STUDIO_AUTH = 'on';
      const mw = requireAuth();
      await mw(req as Request, res as Response, next);

      expect(res.status).toHaveBeenCalledWith(401);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ code: 'UNAUTHORIZED' }),
      );
      expect(next).not.toHaveBeenCalled();
    });
  });
});
describe('generateAnonymousId', () => {
  it('returns a string starting with anon_ followed by 16 hex chars', () => {
    const id = generateAnonymousId('127.0.0.1', 'test-agent');
    expect(id).toMatch(/^anon_[a-f0-9]{16}$/);
  });

  it('returns consistent hash for same IP + UA on same date', () => {
    const id1 = generateAnonymousId('127.0.0.1', 'test-agent');
    const id2 = generateAnonymousId('127.0.0.1', 'test-agent');
    expect(id1).toBe(id2);
  });

  it('returns different hash for different IP', () => {
    const id1 = generateAnonymousId('127.0.0.1', 'test-agent');
    const id2 = generateAnonymousId('192.168.1.1', 'test-agent');
    expect(id1).not.toBe(id2);
  });

  it('returns different hash for different User-Agent', () => {
    const id1 = generateAnonymousId('127.0.0.1', 'Mozilla/5.0 Chrome');
    const id2 = generateAnonymousId('127.0.0.1', 'Mozilla/5.0 Firefox');
    expect(id1).not.toBe(id2);
  });
});
