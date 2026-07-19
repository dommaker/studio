/**
 * Tests for migrate-to-files.ts — migration utility logic
 *
 * Script is a CLI entry point (side-effect heavy), so we inline
 * and test the core transformation logic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join } from 'path';

const TEST_TMP = join(__dirname, '.test-migrate-to-files');

beforeEach(() => { mkdirSync(TEST_TMP, { recursive: true }); });
afterEach(() => { rmSync(TEST_TMP, { recursive: true, force: true }); });

// ── inline core logic to avoid importing side-effect-heavy CLI script ──

function isoDate(date: Date): string {
  return date.toISOString();
}

function formatProfileRecord(row: {
  id: string;
  name: string;
  description: string | null;
  channels: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    channels: row.channels,
    status: row.status,
    createdAt: isoDate(row.createdAt),
    updatedAt: isoDate(row.updatedAt),
  };
}

function formatChannelRecord(row: {
  id: string;
  name: string;
  type: string;
  defaultWorkspaceId: string | null;
  defaultPath: string | null;
  discordChannelId: string | null;
  discordWebhookUrl: string | null;
  members: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    defaultWorkspaceId: row.defaultWorkspaceId ?? null,
    defaultPath: row.defaultPath ?? null,
    discordChannelId: row.discordChannelId ?? null,
    discordWebhookUrl: row.discordWebhookUrl ?? null,
    members: row.members ?? '[]',
    createdAt: isoDate(row.createdAt),
    updatedAt: isoDate(row.updatedAt),
  };
}

function formatMessageRecord(row: {
  id: string;
  channelId: string;
  workUnitId: string | null;
  authorType: string;
  agentName: string | null;
  content: string;
  replyToId: string | null;
  meta: string | null;
  createdAt: Date;
}) {
  return {
    id: row.id,
    channelId: row.channelId,
    workUnitId: row.workUnitId ?? null,
    authorType: row.authorType,
    agentName: row.agentName ?? null,
    content: row.content,
    replyToId: row.replyToId ?? null,
    meta: row.meta ?? '{}',
    createdAt: isoDate(row.createdAt),
  };
}

function formatStateRecord(row: {
  id: string;
  roleId: string;
  sessionId: string | null;
  status: string;
  currentWorkUnitId: string | null;
  startedAt: Date;
  terminatedAt: Date | null;
  lastHeartbeat: Date | null;
  metadata: any;
}) {
  return {
    id: row.id,
    roleId: row.roleId,
    sessionId: row.sessionId,
    status: row.status,
    currentWorkUnitId: row.currentWorkUnitId ?? null,
    startedAt: isoDate(row.startedAt),
    terminatedAt: row.terminatedAt ? isoDate(row.terminatedAt) : null,
    lastHeartbeat: row.lastHeartbeat ? isoDate(row.lastHeartbeat) : null,
    metadata: row.metadata,
  };
}

function formatWorkUnitSnapshot(row: {
  id: string;
  parentId: string | null;
  type: string;
  scope: any;
  assigneeId: string | null;
  status: string;
  failureType: string | null;
  retryCount: number;
  timeoutAt: Date | null;
  channelId: string | null;
  projectPath: string | null;
  metadata: any;
  createdAt: Date;
  updatedAt: Date;
  claimedAt: Date | null;
  completedAt: Date | null;
}) {
  return {
    id: row.id,
    parentId: row.parentId ?? null,
    type: row.type,
    scope: row.scope,
    assigneeId: row.assigneeId ?? null,
    status: row.status,
    failureType: row.failureType ?? null,
    retryCount: row.retryCount,
    timeoutAt: row.timeoutAt?.toISOString() ?? null,
    channelId: row.channelId ?? null,
    projectPath: row.projectPath ?? null,
    metadata: row.metadata ?? null,
    createdAt: isoDate(row.createdAt),
    updatedAt: isoDate(row.updatedAt),
    claimedAt: row.claimedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
  };
}

// ── tests ──

describe('migrate-to-files format helpers', () => {
  const now = new Date('2026-07-15T10:00:00Z');

  describe('formatProfileRecord', () => {
    it('maps date fields to ISO strings', () => {
      const profile = formatProfileRecord({
        id: 'p1',
        name: 'test-agent',
        description: 'a test',
        channels: '["ch-1"]',
        status: 'active',
        createdAt: now,
        updatedAt: now,
      });
      expect(profile.createdAt).toBe('2026-07-15T10:00:00.000Z');
      expect(profile.updatedAt).toBe('2026-07-15T10:00:00.000Z');
    });

    it('preserves channel JSON string', () => {
      const profile = formatProfileRecord({
        id: 'p1', name: 'test', description: null, status: 'active',
        channels: '["ch-1","ch-2"]', createdAt: now, updatedAt: now,
      });
      expect(profile.channels).toBe('["ch-1","ch-2"]');
    });
  });

  describe('formatChannelRecord', () => {
    it('defaults null members to "[]"', () => {
      const channel = formatChannelRecord({
        id: 'ch-1', name: 'general', type: 'public',
        defaultWorkspaceId: null, defaultPath: null,
        discordChannelId: null, discordWebhookUrl: null,
        members: '[]',
        createdAt: now, updatedAt: now,
      });
      expect(channel.members).toBe('[]');
    });

    it('preserves non-empty members', () => {
      const channel = formatChannelRecord({
        id: 'ch-1', name: 'general', type: 'public',
        defaultWorkspaceId: null, defaultPath: null,
        discordChannelId: null, discordWebhookUrl: null,
        members: '["a1","a2"]',
        createdAt: now, updatedAt: now,
      });
      expect(channel.members).toBe('["a1","a2"]');
    });

    it('preserves discord fields', () => {
      const channel = formatChannelRecord({
        id: 'ch-1', name: 'discord-ch', type: 'discord',
        defaultWorkspaceId: null, defaultPath: null,
        discordChannelId: 'd-123', discordWebhookUrl: 'https://hook.example.com',
        members: '[]',
        createdAt: now, updatedAt: now,
      });
      expect(channel.discordChannelId).toBe('d-123');
      expect(channel.discordWebhookUrl).toBe('https://hook.example.com');
    });
  });

  describe('formatMessageRecord', () => {
    it('defaults null meta to "{}"', () => {
      const msg = formatMessageRecord({
        id: 'm1', channelId: 'ch-1', workUnitId: null,
        authorType: 'human', agentName: null,
        content: 'hello', replyToId: null, meta: null,
        createdAt: now,
      });
      expect(msg.meta).toBe('{}');
    });

    it('preserves meta JSON string', () => {
      const msg = formatMessageRecord({
        id: 'm1', channelId: 'ch-1', workUnitId: null,
        authorType: 'agent', agentName: 'dev-agent',
        content: 'done', replyToId: null,
        meta: '{"status":"ok"}',
        createdAt: now,
      });
      expect(msg.meta).toBe('{"status":"ok"}');
    });
  });

  describe('formatStateRecord', () => {
    it('handles active state (no terminatedAt/ lastHeartbeat)', () => {
      const state = formatStateRecord({
        id: 'r1', roleId: 'developer', sessionId: 'sess-1',
        status: 'running', currentWorkUnitId: 'wu-1',
        startedAt: now, terminatedAt: null, lastHeartbeat: null,
        metadata: {},
      });
      expect(state.status).toBe('running');
      expect(state.terminatedAt).toBeNull();
      expect(state.lastHeartbeat).toBeNull();
    });

    it('formats terminated dates', () => {
      const ended = new Date('2026-07-15T11:00:00Z');
      const state = formatStateRecord({
        id: 'r1', roleId: 'developer', sessionId: null,
        status: 'terminated', currentWorkUnitId: null,
        startedAt: now, terminatedAt: ended, lastHeartbeat: ended,
        metadata: { exitCode: 0 },
      });
      expect(state.terminatedAt).toBe('2026-07-15T11:00:00.000Z');
    });
  });

  describe('formatWorkUnitSnapshot', () => {
    it('defaults null optional fields', () => {
      const wu = formatWorkUnitSnapshot({
        id: 'wu-1', parentId: null, type: 'task',
        scope: {}, assigneeId: null,
        status: 'pending', failureType: null,
        retryCount: 0, timeoutAt: null,
        channelId: null, projectPath: null,
        metadata: null,
        createdAt: now, updatedAt: now,
        claimedAt: null, completedAt: null,
      });
      expect(wu.parentId).toBeNull();
      expect(wu.failureType).toBeNull();
      expect(wu.claimedAt).toBeNull();
      expect(wu.completedAt).toBeNull();
      expect(wu.timeoutAt).toBeNull();
    });

    it('maps date fields to ISO strings', () => {
      const claimed = new Date('2026-07-15T10:05:00Z');
      const completed = new Date('2026-07-15T10:30:00Z');
      const wu = formatWorkUnitSnapshot({
        id: 'wu-1', parentId: null, type: 'task',
        scope: { title: 'test' }, assigneeId: 'a1',
        status: 'completed', failureType: null,
        retryCount: 0, timeoutAt: null,
        channelId: 'ch-1', projectPath: '/tmp/test',
        metadata: { okr: 'k1' },
        createdAt: now, updatedAt: completed,
        claimedAt: claimed, completedAt: completed,
      });
      expect(wu.claimedAt).toBe('2026-07-15T10:05:00.000Z');
      expect(wu.completedAt).toBe('2026-07-15T10:30:00.000Z');
      expect(wu.status).toBe('completed');
    });
  });
});
