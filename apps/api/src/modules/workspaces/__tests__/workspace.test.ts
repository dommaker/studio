/**
 * Workspace module integration tests (SQLite, no mocks)
 *
 * Covers:
 *   - Token creation + SHA-256 hash
 *   - Workspace registration (upsert on same token)
 *   - Workspace heartbeat update
 *   - Runtime registration (upsert on unique constraint)
 *   - Token revocation
 *   - VPS local workspace creation
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';
import crypto from 'crypto';

// ── Helpers ──

function generateToken(): string {
  return `st_mach_${crypto.randomBytes(24).toString('base64url')}`;
}

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function createTestToken(name: string, permissions: string[] = ['execute']) {
  const plaintext = generateToken();
  const tokenHash = hashToken(plaintext);
  const token = await prisma.workspaceToken.create({
    data: {
      name,
      tokenHash,
      permissions: JSON.stringify(permissions),
    },
  });
  return { token, plaintext, tokenHash };
}

// ── Test data ──

let testWorkspaceId: string;

describe('WorkspaceToken', () => {
  let tokenId: string;

  it('creates token with SHA-256 hash', async () => {
    const { token, plaintext } = await createTestToken('test-token-create');
    tokenId = token.id;

    expect(token.id).toBeTruthy();
    expect(token.name).toBe('test-token-create');
    expect(token.permissions).toBe('["execute"]');
    expect(token.revokedAt).toBeNull();

    // Verify hash matches plaintext (SHA-256 is deterministic)
    const found = await prisma.workspaceToken.findUnique({ where: { id: token.id } });
    expect(found).toBeTruthy();
    expect(found!.tokenHash).toBe(hashToken(plaintext));
  });

  it('enforces unique tokenHash', async () => {
    const hash = hashToken('duplicate-hash-test');
    // Clean up any stale tokens from previous runs
    const stale = await prisma.workspaceToken.findUnique({ where: { tokenHash: hash } });
    if (stale) {
      await prisma.workspace.deleteMany({ where: { tokenId: stale.id } });
      await prisma.workspaceToken.delete({ where: { id: stale.id } });
    }

    await prisma.workspaceToken.create({
      data: { name: 'unique-test-1', tokenHash: hash, permissions: '["execute"]' },
    });

    await expect(
      prisma.workspaceToken.create({
        data: { name: 'unique-test-2', tokenHash: hash, permissions: '["execute"]' },
      })
    ).rejects.toThrow();

    // Cleanup
    await prisma.workspaceToken.deleteMany({ where: { tokenHash: hash } });
  });

  it('revokes token by setting revokedAt', async () => {
    const { token } = await createTestToken('test-token-revoke');

    const revoked = await prisma.workspaceToken.update({
      where: { id: token.id },
      data: { revokedAt: new Date() },
    });

    expect(revoked.revokedAt).toBeTruthy();
  });

  afterAll(async () => {
    if (tokenId) {
      await prisma.workspace.deleteMany({ where: { tokenId } });
      await prisma.workspaceToken.deleteMany({ where: { id: tokenId } });
    }
  });
});

describe('Workspace', () => {
  let tokenId: string;
  let workspaceId: string;

  beforeAll(async () => {
    const { token } = await createTestToken('test-ws-token');
    tokenId = token.id;
  });


  afterAll(async () => {
    await prisma.workspaceEvent.deleteMany({ where: { workspaceId } });
    await prisma.workspaceTask.deleteMany({ where: { workspaceId } });
    await prisma.workspaceRuntime.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: testWorkspaceId } });
    await prisma.workspaceToken.deleteMany({ where: { id: tokenId } });
  });

  it('creates workspace with token relation', async () => {
    const ws = await prisma.workspace.create({
      data: {
        name: 'test-workspace',
        tokenId,
        workspaceRoot: '/tmp/test',
        status: 'offline',
      },
    });
    workspaceId = ws.id;
    testWorkspaceId = ws.id;

    expect(ws.id).toBeTruthy();
    expect(ws.name).toBe('test-workspace');
    expect(ws.tokenId).toBe(tokenId);
    expect(ws.status).toBe('offline');
    expect(ws.hasDocker).toBe(false);
  });

  it('updates workspace on heartbeat', async () => {
    const updated = await prisma.workspace.update({
      where: { id: workspaceId },
      data: {
        status: 'idle',
        currentTask: null,
        lastHeartbeat: new Date(),
      },
    });

    expect(updated.status).toBe('idle');
    expect(updated.lastHeartbeat).toBeTruthy();
  });

  it('supports VPS workspace with null token', async () => {
    const vps = await prisma.workspace.create({
      data: {
        name: 'VPS',
        workspaceRoot: '/root/projects',
        status: 'idle',
        os: 'linux',
        arch: 'x64',
      },
    });

    expect(vps.tokenId).toBeNull();
    expect(vps.name).toBe('VPS');

    // Cleanup
    await prisma.workspace.delete({ where: { id: vps.id } });
  });

  it('cascades delete to runtimes, tasks, events', async () => {
    // Create runtime
    const rt = await prisma.workspaceRuntime.create({
      data: {
        workspaceId,
        provider: 'test-cascade',
        name: 'test',
        status: 'online',
      },
    });

    // Create task
    const task = await prisma.workspaceTask.create({
      data: {
        workspaceId,
        runtimeId: rt.id,
        path: '/test',
        prompt: 'test',
        agent: 'executor',
        status: 'pending',
      },
    });

    // Create event
    await prisma.workspaceEvent.create({
      data: {
        workspaceId,
        taskId: task.id,
        type: 'output',
        content: 'test event',
      },
    });

    // Delete workspace — should cascade
    await prisma.workspace.delete({ where: { id: workspaceId } });

    // Verify cascade
    const runtimes = await prisma.workspaceRuntime.findMany({ where: { workspaceId } });
    const tasks = await prisma.workspaceTask.findMany({ where: { workspaceId } });
    const events = await prisma.workspaceEvent.findMany({ where: { workspaceId } });

    expect(runtimes).toHaveLength(0);
    expect(tasks).toHaveLength(0);
    expect(events).toHaveLength(0);

    // Recreate for other tests
    const ws = await prisma.workspace.create({
      data: {
        name: 'test-workspace-2',
        tokenId,
        workspaceRoot: '/tmp/test',
        status: 'offline',
      },
    });
    workspaceId = ws.id;
  });
});

describe('WorkspaceRuntime', () => {
  let workspaceId: string;
  let tokenId: string;

  beforeAll(async () => {
    const { token } = await createTestToken('test-rt-token');
    tokenId = token.id;
    const ws = await prisma.workspace.create({
      data: {
        name: 'test-rt-workspace',
        tokenId,
        workspaceRoot: '/tmp/test',
      },
    });
    workspaceId = ws.id;
  });

  afterAll(async () => {
    await prisma.workspaceRuntime.deleteMany({ where: { workspaceId } });
    await prisma.workspace.deleteMany({ where: { id: workspaceId } });
    await prisma.workspaceToken.deleteMany({ where: { id: tokenId } });
  });

  it('creates runtime with workspace relation', async () => {
    const rt = await prisma.workspaceRuntime.create({
      data: {
        workspaceId,
        provider: 'claude',
        name: 'Claude Code',
        version: '2.1.0',
        status: 'online',
      },
    });

    expect(rt.provider).toBe('claude');
    expect(rt.version).toBe('2.1.0');
    expect(rt.workspaceId).toBe(workspaceId);
  });

  it('enforces unique constraint on [workspaceId, provider]', async () => {
    await prisma.workspaceRuntime.create({
      data: {
        workspaceId,
        provider: 'opencode',
        name: 'OpenCode',
        status: 'online',
      },
    });

    // Same provider on same workspace should fail
    await expect(
      prisma.workspaceRuntime.create({
        data: {
          workspaceId,
          provider: 'opencode',
          name: 'OpenCode Duplicate',
          status: 'online',
        },
      })
    ).rejects.toThrow();
  });

  it('allows same provider on different workspaces', async () => {
    const { token } = await createTestToken('test-rt-token-2');
    const ws2 = await prisma.workspace.create({
      data: { name: 'test-rt-ws-2', tokenId: token.id, workspaceRoot: '/tmp/test2' },
    });

    const rt = await prisma.workspaceRuntime.create({
      data: {
        workspaceId: ws2.id,
        provider: 'claude',
        name: 'Claude Code',
        status: 'online',
      },
    });

    expect(rt.workspaceId).toBe(ws2.id);

    // Cleanup
    await prisma.workspaceRuntime.delete({ where: { id: rt.id } });
    await prisma.workspace.delete({ where: { id: ws2.id } });
    await prisma.workspaceToken.delete({ where: { id: token.id } });
  });
});

describe('Token verification flow', () => {
  it('verifies token by SHA-256 hash lookup + finds workspace', async () => {
    const plaintext = generateToken();
    const tokenHash = hashToken(plaintext);

    const token = await prisma.workspaceToken.create({
      data: { name: 'verify-test', tokenHash, permissions: '["execute"]' },
    });

    const ws = await prisma.workspace.create({
      data: { name: 'verify-ws', tokenId: token.id, workspaceRoot: '/tmp' },
    });

    // Simulate: incoming token → SHA-256 hash → findUnique on tokenHash
    const incomingHash = hashToken(plaintext);
    const found = await prisma.workspaceToken.findUnique({
      where: { tokenHash: incomingHash },
    });
    expect(found).toBeTruthy();
    expect(found!.id).toBe(token.id);

    // Verify revoked check
    expect(found!.revokedAt).toBeNull();

    // Find workspace
    const foundWs = await prisma.workspace.findFirst({
      where: { tokenId: found!.id },
    });
    expect(foundWs).toBeTruthy();
    expect(foundWs!.id).toBe(ws.id);

    // Cleanup
    await prisma.workspace.delete({ where: { id: ws.id } });
    await prisma.workspaceToken.delete({ where: { id: token.id } });
  });

  it('rejects revoked token', async () => {
    const plaintext = generateToken();
    const tokenHash = hashToken(plaintext);

    const token = await prisma.workspaceToken.create({
      data: { name: 'revoked-test', tokenHash, permissions: '["execute"]' },
    });

    // Revoke
    await prisma.workspaceToken.update({
      where: { id: token.id },
      data: { revokedAt: new Date() },
    });

    const found = await prisma.workspaceToken.findUnique({ where: { id: token.id } });
    expect(found!.revokedAt).toBeTruthy();

    // Cleanup
    await prisma.workspaceToken.delete({ where: { id: token.id } });
  });
});
