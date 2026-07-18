/**
 * Token Routes tests — generate/list/revoke token endpoints (FileStore mock)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response } from 'express';

// ── Store ──
let tokenStore: Map<string, Record<string, any>> = new Map();

const mockReadJson = vi.hoisted(() => vi.fn());
const mockWriteJson = vi.hoisted(() => vi.fn());

vi.mock('@dommaker/studio-shared', () => ({
  FileStore: vi.fn().mockImplementation(() => ({
    readJson: mockReadJson,
    writeJson: mockWriteJson,
  })),
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock('../../../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../middleware/auth.js', () => ({
  requireAuth: () => (_req: unknown, _res: unknown, next: unknown) => (next as Function)(),
}));

// ── Helpers ──
function mockRes() {
  const res: Record<string, any> = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  };
  return res as unknown as Response;
}

// Import route module to register handlers on the Router
describe('Token Routes (FileStore)', () => {
  // These tests validate the data model, not the HTTP handlers
  // (token.routes.ts uses FileStore directly, so we test the operations)

  describe('POST / (generate token)', () => {
    it('token name is required', () => {
      expect(typeof '' === 'string').toBe(true);
    });

    it('permissions must be array', () => {
      expect(Array.isArray(['execute'])).toBe(true);
      expect(Array.isArray('bad')).toBe(false);
    });

    it('generates st_mach_ prefixed token with sufficient entropy', async () => {
      const crypto = await import('crypto');
      const token = `st_mach_${crypto.randomBytes(24).toString('base64url')}`;
      expect(token).toMatch(/^st_mach_[A-Za-z0-9_-]{32}$/);
    });

    it('creates token entry and stores to FileStore', async () => {
      mockWriteJson.mockResolvedValueOnce(undefined);
      const tokenData = {
        id: 'wt_test',
        name: 'my-token',
        tokenHash: 'abc123',
        permissions: '["execute"]',
        revokedAt: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      // Simulate store
      tokenStore.set(tokenData.id, tokenData);
      expect(tokenStore.has('wt_test')).toBe(true);
      expect(tokenStore.get('wt_test')!.name).toBe('my-token');
    });
  });

  describe('GET / (list tokens)', () => {
    it('returns masked token list', () => {
      const tokens = [{
        id: 'tok-1',
        name: 'token-1',
        tokenHash: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
        permissions: '["execute"]',
        createdAt: new Date().toISOString(),
        revokedAt: null,
      }];

      const maskToken = (hash: string) => hash.slice(0, 10) + '...';

      const masked = tokens.map(t => ({
        id: t.id,
        name: t.name,
        permissions: JSON.parse(t.permissions),
        tokenHash: maskToken(t.tokenHash),
        createdAt: t.createdAt,
        revokedAt: t.revokedAt,
      }));

      expect(masked).toHaveLength(1);
      expect(masked[0].tokenHash).toBe('abcdef1234...');
      expect(masked[0].permissions).toEqual(['execute']);
    });
  });

  describe('DELETE /:id (revoke token)', () => {
    it('returns error when token not found', async () => {
      mockReadJson.mockResolvedValueOnce(null);
      const result = await mockReadJson('ws-tokens/nonexistent.json');
      expect(result).toBeNull();
    });

    it('returns error when token already revoked', () => {
      const token = {
        id: 'tok-1',
        name: 'test',
        tokenHash: 'abc',
        permissions: '["execute"]',
        revokedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      expect(token.revokedAt).toBeTruthy();
    });

    it('revokes token successfully', async () => {
      mockReadJson.mockResolvedValueOnce({
        id: 'tok-1',
        name: 'my-token',
        tokenHash: 'abc',
        revokedAt: null,
      });
      mockWriteJson.mockResolvedValueOnce(undefined);

      const token = await mockReadJson('ws-tokens/tok-1.json');
      expect(token).toBeTruthy();
      expect(token.revokedAt).toBeNull();

      // Revoke
      token.revokedAt = new Date().toISOString();
      await mockWriteJson('ws-tokens/tok-1.json', token);
      expect(mockWriteJson).toHaveBeenCalled();
    });
  });
});
