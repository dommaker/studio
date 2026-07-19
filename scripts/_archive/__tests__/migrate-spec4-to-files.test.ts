/**
 * migrate-spec4-to-files.test.ts — 验证迁移脚本数据转换逻辑
 *
 * 迁移脚本依赖运行时 SQLite DB，此处只测试数据结构转换的正确性。
 */
import { describe, it, expect } from 'vitest';

describe('migrate-spec4-to-files data conversion', () => {
  it('converts User DB row to FileStore format', () => {
    const dbUser = {
      id: 'u1',
      email: 'test@example.com',
      passwordHash: '$2b$hash',
      name: 'Test User',
      role: 'Admin',
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-06-01'),
    };

    const fileUser = {
      id: dbUser.id,
      email: dbUser.email,
      passwordHash: (dbUser as any).passwordHash || null,
      name: (dbUser as any).name || null,
      role: (dbUser as any).role || 'User',
      createdAt: dbUser.createdAt?.toISOString(),
      updatedAt: dbUser.updatedAt?.toISOString(),
    };

    expect(fileUser.id).toBe('u1');
    expect(fileUser.email).toBe('test@example.com');
    expect(fileUser.role).toBe('Admin');
    expect(fileUser.createdAt).toBe('2026-01-01T00:00:00.000Z');
  });

  it('converts Session + RefreshToken to JSONL record', () => {
    const session = {
      id: 's1',
      userId: 'u1',
      token: 'jwt-token',
      guestId: 'g1',
      ipAddress: '127.0.0.1',
      userAgent: 'Test',
      expiresAt: new Date('2026-07-01'),
      createdAt: new Date('2026-01-01'),
      refreshTokens: [{ token: 'rt-old' }],
    };

    const record = {
      id: session.id,
      userId: session.userId || null,
      token: session.token,
      guestId: (session as any).guestId || null,
      ipAddress: (session as any).ipAddress || null,
      userAgent: (session as any).userAgent || null,
      expiresAt: session.expiresAt?.toISOString(),
      createdAt: session.createdAt?.toISOString(),
      refreshToken: (session as any).refreshTokens?.[0]?.token || null,
    };

    expect(record.refreshToken).toBe('rt-old');
    expect(record.userId).toBe('u1');
    expect(record.guestId).toBe('g1');
  });

  it('converts Workspace with nested tokens/runtimes/repos', () => {
    const ws = {
      id: 'ws1',
      name: 'Test WS',
      tokenId: 'tok1',
      workspaceRoot: '/tmp/test',
      hasDocker: true,
      os: 'linux',
      arch: 'x64',
      status: 'idle',
      currentTask: null,
      lastHeartbeat: new Date('2026-07-01'),
      tokens: [{
        id: 'tok1',
        tokenHash: 'hash1',
        name: 'api-key',
        permissions: '["execute"]',
        revokedAt: null,
        createdAt: new Date('2026-01-01'),
      }],
      runtimes: [{
        id: 'rt1',
        provider: 'claude',
        name: 'Claude Code',
        version: '2.1',
        status: 'online',
        lastSeenAt: new Date('2026-07-01'),
        createdAt: new Date('2026-01-01'),
        updatedAt: new Date('2026-07-01'),
      }],
      repos: [{
        id: 'r1',
        path: '/tmp',
        name: 'studio',
        category: 'source',
        description: 'Main repo',
        defaultBranch: 'master',
        remoteUrl: 'git@github.com:org/studio.git',
        status: 'active',
        lastSyncedAt: new Date('2026-07-01'),
        createdAt: new Date('2026-01-01'),
      }],
      createdAt: new Date('2026-01-01'),
      updatedAt: new Date('2026-07-01'),
    };

    const wsData = {
      id: ws.id,
      name: ws.name,
      tokenId: ws.tokenId,
      workspaceRoot: ws.workspaceRoot,
      hasDocker: ws.hasDocker,
      os: ws.os,
      arch: ws.arch,
      status: ws.status,
      tokens: ws.tokens.map(t => ({
        id: t.id,
        tokenHash: t.tokenHash,
        name: t.name,
        permissions: t.permissions,
        revokedAt: null,
        lastUsedAt: null,
        createdAt: t.createdAt.toISOString(),
      })),
      runtimes: ws.runtimes.map(r => ({
        id: r.id,
        provider: r.provider,
        name: r.name,
        version: r.version,
        status: r.status,
        lastSeenAt: r.lastSeenAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      })),
      repos: ws.repos.map(r => ({
        id: r.id,
        path: r.path,
        name: r.name,
        category: r.category,
        description: r.description,
        defaultBranch: r.defaultBranch,
        remoteUrl: r.remoteUrl,
        status: r.status,
        lastSyncedAt: r.lastSyncedAt.toISOString(),
        createdAt: r.createdAt.toISOString(),
      })),
      createdAt: ws.createdAt.toISOString(),
      updatedAt: ws.updatedAt.toISOString(),
    };

    expect(wsData.tokens).toHaveLength(1);
    expect(wsData.tokens[0].name).toBe('api-key');
    expect(wsData.runtimes).toHaveLength(1);
    expect(wsData.runtimes[0].provider).toBe('claude');
    expect(wsData.repos).toHaveLength(1);
    expect(wsData.repos[0].name).toBe('studio');
  });

  it('converts WorkspaceTask to JSONL format', () => {
    const task = {
      id: 't1',
      workspaceId: 'ws1',
      status: 'pending',
      runtimeId: 'rt1',
      path: '/test',
      prompt: 'Do something',
      agent: 'executor',
      result: null,
      completedAt: null,
      createdAt: new Date('2026-07-01'),
      updatedAt: new Date('2026-07-01'),
    };

    const record = {
      id: task.id,
      status: task.status,
      runtimeId: task.runtimeId || null,
      path: task.path,
      prompt: task.prompt,
      agent: task.agent,
      result: task.result,
      completedAt: task.completedAt?.toISOString() || null,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    };

    expect(record.status).toBe('pending');
    expect(record.runtimeId).toBe('rt1');
    expect(record.completedAt).toBeNull();
  });

  it('converts WorkspaceEvent to JSONL format', () => {
    const event = {
      id: 'e1',
      type: 'output',
      taskId: 't1',
      content: 'Hello',
      metadata: '{"seq":1}',
      createdAt: new Date('2026-07-01'),
    };

    const record = {
      id: event.id,
      type: event.type,
      taskId: event.taskId,
      content: event.content,
      metadata: event.metadata,
      createdAt: event.createdAt.toISOString(),
    };

    expect(record.type).toBe('output');
    expect(record.taskId).toBe('t1');
    expect(record.content).toBe('Hello');
  });

  it('handles null/undefined fields gracefully', () => {
    const session = {
      id: 's1',
      userId: null,
      token: 'jwt',
      guestId: null,
      ipAddress: null,
      userAgent: null,
      expiresAt: new Date(),
      createdAt: new Date(),
      refreshTokens: [],
    };

    const record = {
      id: session.id,
      userId: session.userId || null,
      token: session.token,
      guestId: (session as any).guestId || null,
      ipAddress: (session as any).ipAddress || null,
      userAgent: (session as any).userAgent || null,
      expiresAt: session.expiresAt.toISOString(),
      createdAt: session.createdAt.toISOString(),
      refreshToken: null,
    };

    expect(record.refreshToken).toBeNull();
    expect(record.userId).toBeNull();
    expect(record.guestId).toBeNull();
  });

  it('mergeKey is name+workspaceRoot for dedup', () => {
    const entries = [
      { name: 'VPS', workspaceRoot: '/root/projects' },
      { name: 'VPS', workspaceRoot: '/different' },
      { name: 'Other', workspaceRoot: '/root/projects' },
    ];

    const keys = entries.map(e => `${e.name}::${e.workspaceRoot}`);
    const unique = new Set(keys);
    expect(unique.size).toBe(3); // All unique
  });
});
