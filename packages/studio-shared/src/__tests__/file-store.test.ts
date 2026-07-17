/**
 * FileStore 单元测试
 *
 * 覆盖：创建/读取/更新/列表/软删除/查询/count
 * JSONL append-only 写入正确性
 * index.json 重建逻辑正确性
 * flock claim 并发测试
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  FileStore,
  LockTimeoutError,
  parseFrontmatter,
  serializeFrontmatter,
  type AgentProfileData,
  type RuntimeStateData,
  type ChannelData,
  type ChannelMessageData,
  type WorkUnitEvent,
  type WorkUnitSnapshot,
} from '../file-store';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'filestore-test-'));
}

function makeProfile(id: string, name?: string): AgentProfileData {
  const now = new Date().toISOString();
  return {
    id,
    name: name ?? `agent-${id}`,
    description: null,
    channels: '[]',
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
}

function makeState(agentId: string): RuntimeStateData {
  const now = new Date().toISOString();
  return {
    id: `instance-${agentId}`,
    roleId: agentId,
    sessionId: null,
    status: 'idle',
    currentWorkUnitId: null,
    startedAt: now,
    terminatedAt: null,
    lastHeartbeat: null,
    metadata: null,
  };
}

function makeChannel(id: string, name?: string): ChannelData {
  const now = new Date().toISOString();
  return {
    id,
    name: name ?? `channel-${id}`,
    type: 'rnd',
    defaultWorkspaceId: null,
    defaultPath: null,
    discordChannelId: null,
    discordWebhookUrl: null,
    members: '[]',
    createdAt: now,
    updatedAt: now,
  };
}

function makeMessage(id: string, channelId: string, opts?: { workUnitId?: string; authorType?: string }): ChannelMessageData {
  const now = new Date().toISOString();
  return {
    id,
    channelId,
    workUnitId: opts?.workUnitId ?? null,
    authorType: opts?.authorType ?? 'human',
    agentName: null,
    content: `message ${id} content`,
    replyToId: null,
    meta: '{}',
    createdAt: now,
  };
}

describe('FileStore', () => {
  let tmpDir: string;
  let store: FileStore;

  beforeEach(() => {
    tmpDir = createTempDir();
    store = new FileStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ═══ AgentProfile ═══

  describe('AgentProfile', () => {
    it('should create and read a profile', async () => {
      const profile = makeProfile('p1');
      await store.createProfile(profile);
      const loaded = await store.getProfile('p1');
      expect(loaded).toEqual(profile);
    });

    it('should return null for non-existent profile', async () => {
      const loaded = await store.getProfile('nonexistent');
      expect(loaded).toBeNull();
    });

    it('should update a profile', async () => {
      const profile = makeProfile('p1');
      await store.createProfile(profile);
      // Ensure updatedAt timestamp advances (CI SSD can complete both ops within same ms)
      await new Promise(resolve => setTimeout(resolve, 10));
      await store.updateProfile('p1', { description: 'updated desc' });
      const loaded = await store.getProfile('p1');
      expect(loaded?.description).toBe('updated desc');
      expect(loaded?.updatedAt).not.toBe(profile.updatedAt);
    });

    it('should throw on updating non-existent profile', async () => {
      await expect(store.updateProfile('nonexistent', { name: 'new' })).rejects.toThrow('AgentProfile not found');
    });

    it('should list all profiles', async () => {
      await store.createProfile(makeProfile('p1', 'agent-a'));
      await store.createProfile(makeProfile('p2', 'agent-b'));
      const list = await store.listProfiles();
      expect(list).toHaveLength(2);
    });

    it('should list profiles with status filter', async () => {
      await store.createProfile(makeProfile('p1', 'active-a'));
      await store.createProfile({ ...makeProfile('p2', 'inactive-b'), status: 'inactive' });
      const active = await store.listProfiles({ status: 'active' });
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe('p1');
    });
  });

  // ═══ RuntimeState ═══

  describe('RuntimeState', () => {
    it('should create and read state', async () => {
      const state = makeState('agent1');
      await store.createState('agent1', state);
      const loaded = await store.getState('agent1');
      expect(loaded).toEqual(state);
    });

    it('should return null for non-existent state', async () => {
      const loaded = await store.getState('nonexistent');
      expect(loaded).toBeNull();
    });

    it('should update state', async () => {
      await store.createState('agent1', makeState('agent1'));
      await store.updateState('agent1', { status: 'active', sessionId: 'session-123' });
      const loaded = await store.getState('agent1');
      expect(loaded?.status).toBe('active');
      expect(loaded?.sessionId).toBe('session-123');
    });

    it('should throw on updating non-existent state', async () => {
      await expect(store.updateState('nonexistent', { status: 'active' })).rejects.toThrow('RuntimeState not found');
    });

    it('should throw on creating duplicate state', async () => {
      await store.createState('agent1', makeState('agent1'));
      await expect(store.createState('agent1', makeState('agent1'))).rejects.toThrow('RuntimeState already exists');
    });

    it('should list all states', async () => {
      await store.createState('agent1', makeState('agent1'));
      await store.createState('agent2', makeState('agent2'));
      const states = await store.listStates();
      expect(states).toHaveLength(2);
    });

    it('should return empty array when no states', async () => {
      const states = await store.listStates();
      expect(states).toHaveLength(0);
    });
  });

  // ═══ Channel ═══

  describe('Channel', () => {
    it('should create and read a channel', async () => {
      const channel = makeChannel('ch1');
      await store.createChannel(channel);
      const loaded = await store.getChannel('ch1');
      expect(loaded).toEqual(channel);
    });

    it('should return null for non-existent channel', async () => {
      const loaded = await store.getChannel('nonexistent');
      expect(loaded).toBeNull();
    });

    it('should update a channel', async () => {
      await store.createChannel(makeChannel('ch1'));
      await store.updateChannel('ch1', { name: '#updated' });
      const loaded = await store.getChannel('ch1');
      expect(loaded?.name).toBe('#updated');
    });

    it('should list channels', async () => {
      await store.createChannel(makeChannel('ch1'));
      await store.createChannel(makeChannel('ch2'));
      const list = await store.listChannels();
      expect(list).toHaveLength(2);
    });

    it('should exclude archived channels when excludeArchived=true', async () => {
      await store.createChannel(makeChannel('ch1', '#team-a'));
      await store.createChannel(makeChannel('ch2', '#team-a-archived-1712345678000'));
      const list = await store.listChannels({ excludeArchived: true });
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('#team-a');
    });

    it('should include archived channels when excludeArchived is false', async () => {
      await store.createChannel(makeChannel('ch1', '#team-a'));
      await store.createChannel(makeChannel('ch2', '#team-a-archived-1712345678000'));
      const list = await store.listChannels({ excludeArchived: false });
      expect(list).toHaveLength(2);
    });
  });

  // ═══ ChannelMessage ═══

  describe('ChannelMessage', () => {
    const channelId = 'ch-messages';

    beforeEach(async () => {
      await store.createChannel(makeChannel(channelId));
    });

    it('should append and query messages', async () => {
      await store.appendMessage(channelId, makeMessage('m1', channelId));
      await store.appendMessage(channelId, makeMessage('m2', channelId));
      const msgs = await store.queryMessages(channelId);
      expect(msgs).toHaveLength(2);
    });

    it('should filter messages by workUnitId', async () => {
      await store.appendMessage(channelId, makeMessage('m1', channelId, { workUnitId: 'wu1' }));
      await store.appendMessage(channelId, makeMessage('m2', channelId, { workUnitId: 'wu2' }));
      const filtered = await store.queryMessages(channelId, { workUnitId: 'wu1' });
      expect(filtered).toHaveLength(1);
      expect(filtered[0].id).toBe('m1');
    });

    it('should filter messages by authorType', async () => {
      await store.appendMessage(channelId, makeMessage('m1', channelId, { authorType: 'human' }));
      await store.appendMessage(channelId, makeMessage('m2', channelId, { authorType: 'agent' }));
      const humanMsgs = await store.queryMessages(channelId, { authorType: 'human' });
      expect(humanMsgs).toHaveLength(1);
    });

    it('should limit query results', async () => {
      await store.appendMessage(channelId, makeMessage('m1', channelId));
      await store.appendMessage(channelId, makeMessage('m2', channelId));
      await store.appendMessage(channelId, makeMessage('m3', channelId));
      const limited = await store.queryMessages(channelId, { limit: 2 });
      expect(limited).toHaveLength(2);
    });

    it('should soft delete a message', async () => {
      await store.appendMessage(channelId, makeMessage('m1', channelId));
      await store.appendMessage(channelId, makeMessage('m2', channelId));
      await store.softDeleteMessage(channelId, 'm1');
      const remaining = await store.queryMessages(channelId);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe('m2');
    });

    it('should throw when soft deleting non-existent message', async () => {
      await expect(store.softDeleteMessage(channelId, 'nonexistent')).rejects.toThrow('Message not found');
    });

    it('should count messages', async () => {
      await store.appendMessage(channelId, makeMessage('m1', channelId, { workUnitId: 'wu1', authorType: 'human' }));
      await store.appendMessage(channelId, makeMessage('m2', channelId, { workUnitId: 'wu1', authorType: 'agent' }));
      await store.appendMessage(channelId, makeMessage('m3', channelId, { workUnitId: 'wu2', authorType: 'human' }));
      const total = await store.countMessages(channelId);
      expect(total).toBe(3);
      const wu1Count = await store.countMessages(channelId, { workUnitId: 'wu1' });
      expect(wu1Count).toBe(2);
      const humanCount = await store.countMessages(channelId, { authorType: 'human' });
      expect(humanCount).toBe(2);
    });

    it('should not count soft-deleted messages', async () => {
      await store.appendMessage(channelId, makeMessage('m1', channelId));
      await store.appendMessage(channelId, makeMessage('m2', channelId));
      await store.softDeleteMessage(channelId, 'm1');
      const count = await store.countMessages(channelId);
      expect(count).toBe(1);
    });

    it('should handle empty messages', async () => {
      const msgs = await store.queryMessages(channelId);
      expect(msgs).toHaveLength(0);
      const count = await store.countMessages(channelId);
      expect(count).toBe(0);
    });
  });

  // ═══ WorkUnit Event Sourcing ═══

  describe('WorkUnit', () => {
    function makeWuSnapshot(id: string, overrides?: Partial<WorkUnitSnapshot>): WorkUnitSnapshot {
      const now = new Date().toISOString();
      return {
        id,
        parentId: null,
        type: 'task',
        scope: `scope-${id}`,
        assigneeId: null,
        status: 'unassigned',
        failureType: null,
        retryCount: 0,
        timeoutAt: null,
        channelId: null,
        projectPath: null,
        metadata: null,
        createdAt: now,
        updatedAt: now,
        claimedAt: null,
        completedAt: null,
        ...overrides,
      };
    }

    describe('appendEvent / getIndex / rebuildIndex', () => {
      it('should append and rebuild index from events', async () => {
        const wu1 = makeWuSnapshot('wu1');
        await store.appendEvent({ type: 'created', wuId: 'wu1', timestamp: new Date().toISOString(), data: wu1 as unknown as Record<string, unknown> });

        const wu2 = makeWuSnapshot('wu2');
        await store.appendEvent({ type: 'created', wuId: 'wu2', timestamp: new Date().toISOString(), data: wu2 as unknown as Record<string, unknown> });

        const index = await store.rebuildIndex();
        expect(index).toHaveLength(2);
      });

      it('should apply events in order and update snapshot', async () => {
        const wu1 = makeWuSnapshot('wu1');
        await store.appendEvent({ type: 'created', wuId: 'wu1', timestamp: new Date().toISOString(), data: wu1 as unknown as Record<string, unknown> });
        await store.appendEvent({
          type: 'claimed',
          wuId: 'wu1',
          timestamp: new Date().toISOString(),
          data: { assigneeId: 'agent1', status: 'active' } as unknown as Record<string, unknown>,
        });

        const index = await store.rebuildIndex();
        const claimed = index.find(i => i.id === 'wu1');
        expect(claimed?.status).toBe('active');
        expect(claimed?.assigneeId).toBe('agent1');
      });

      it('should filter index by status', async () => {
        const wu1 = makeWuSnapshot('wu1', { status: 'active' });
        const wu2 = makeWuSnapshot('wu2', { status: 'unassigned' });
        await store.appendEvent({ type: 'created', wuId: 'wu1', timestamp: new Date().toISOString(), data: wu1 as unknown as Record<string, unknown> });
        await store.appendEvent({ type: 'created', wuId: 'wu2', timestamp: new Date().toISOString(), data: wu2 as unknown as Record<string, unknown> });
        await store.rebuildIndex();

        const active = await store.getIndex({ status: 'active' });
        expect(active).toHaveLength(1);
        expect(active[0].id).toBe('wu1');
      });

      it('should return snapshots from getIndex when index.json exists', async () => {
        const wu1 = makeWuSnapshot('wu1');
        await store.appendEvent({ type: 'created', wuId: 'wu1', timestamp: new Date().toISOString(), data: wu1 as unknown as Record<string, unknown> });
        await store.rebuildIndex();

        // Now getIndex should read from index.json (already built by rebuildIndex)
        const index = await store.getIndex();
        expect(index).toHaveLength(1);
        expect(index[0].id).toBe('wu1');
      });

      it('should return empty array when no events', async () => {
        const index = await store.getIndex();
        expect(index).toHaveLength(0);
      });
    });

    describe('claimWorkUnit', () => {
      it('should successfully claim an unassigned work unit', async () => {
        const wu1 = makeWuSnapshot('wu1');
        await store.appendEvent({ type: 'created', wuId: 'wu1', timestamp: new Date().toISOString(), data: wu1 as unknown as Record<string, unknown> });
        await store.rebuildIndex();

        const claimed = await store.claimWorkUnit('wu1', 'agent1');
        expect(claimed).toBe(true);

        const index = await store.getIndex();
        const wu = index.find(i => i.id === 'wu1');
        expect(wu?.status).toBe('active');
        expect(wu?.assigneeId).toBe('agent1');
      });

      it('should not claim an already claimed work unit', async () => {
        const wu1 = makeWuSnapshot('wu1');
        await store.appendEvent({ type: 'created', wuId: 'wu1', timestamp: new Date().toISOString(), data: wu1 as unknown as Record<string, unknown> });
        await store.rebuildIndex();

        const claim1 = await store.claimWorkUnit('wu1', 'agent1');
        expect(claim1).toBe(true);

        const claim2 = await store.claimWorkUnit('wu1', 'agent2');
        expect(claim2).toBe(false);
      });

      it('should return false for non-existent work unit', async () => {
        const claimed = await store.claimWorkUnit('nonexistent', 'agent1');
        expect(claimed).toBe(false);
      });

      it('should handle concurrent claims using flock', async () => {
        const wu1 = makeWuSnapshot('wu1');
        await store.appendEvent({ type: 'created', wuId: 'wu1', timestamp: new Date().toISOString(), data: wu1 as unknown as Record<string, unknown> });
        await store.rebuildIndex();

        // 模拟并发 claim：2 个同时 claim，仅 1 个成功
        const results = await Promise.all([
          store.claimWorkUnit('wu1', 'agent1'),
          store.claimWorkUnit('wu1', 'agent2'),
        ]);

        const successCount = results.filter(r => r).length;
        expect(successCount).toBe(1);
      });
    });
  });

  describe('FileStore Markdown', () => {
    let store: FileStore;
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = createTempDir();
      store = new FileStore(tmpDir);
    });

    afterEach(() => {
      if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      }
    });

    // ── readDoc ──

    it('should read a markdown file and return parsed meta and body', async () => {
      const mdDir = path.join(tmpDir, 'docs');
      await store.writeDoc(mdDir, 'test', { title: 'Hello', version: 1 }, 'This is the body content.');

      const result = await store.readDoc(mdDir, 'test');
      expect(result).not.toBeNull();
      expect(result!.meta).toEqual({ title: 'Hello', version: 1 });
      expect(result!.body).toBe('This is the body content.');
    });

    it('should return null when file does not exist', async () => {
      const result = await store.readDoc(path.join(tmpDir, 'docs'), 'nonexistent');
      expect(result).toBeNull();
    });

    it('should return empty meta when file has no frontmatter', async () => {
      const mdDir = path.join(tmpDir, 'docs');
      fs.mkdirSync(mdDir, { recursive: true });
      fs.writeFileSync(path.join(mdDir, 'nofm.md'), 'Just body content without frontmatter.');

      const result = await store.readDoc(mdDir, 'nofm');
      expect(result).not.toBeNull();
      expect(result!.meta).toEqual({});
      expect(result!.body).toBe('Just body content without frontmatter.');
    });

    it('should handle special characters in frontmatter', async () => {
      const mdDir = path.join(tmpDir, 'docs');
      await store.writeDoc(mdDir, 'special', {
        title: 'Title with "quotes" and : colons',
        tags: ['a', 'b', 'c'],
      }, 'body');

      const result = await store.readDoc(mdDir, 'special');
      expect(result!.meta.title).toBe('Title with "quotes" and : colons');
      expect(result!.meta.tags).toEqual(['a', 'b', 'c']);
    });

    it('should handle multi-line array values in frontmatter', async () => {
      const mdDir = path.join(tmpDir, 'docs');
      await store.writeDoc(mdDir, 'multi', { linkedDocIds: ['a', 'b', 'c'], tags: [] }, 'body');
      const result = await store.readDoc(mdDir, 'multi');
      expect(result!.meta.linkedDocIds).toEqual(['a', 'b', 'c']);
    });

    // ── writeDoc ──

    it('should write a markdown file with frontmatter that roundtrips with readDoc', async () => {
      const mdDir = path.join(tmpDir, 'docs');
      const meta = { slug: 'my-doc', status: 'draft', version: 3 };
      const body = '## Section\n\nContent here.';

      await store.writeDoc(mdDir, 'roundtrip', meta, body);
      const result = await store.readDoc(mdDir, 'roundtrip');
      expect(result!.meta).toEqual(meta);
      expect(result!.body).toBe(body);
    });

    it('should auto-create directory when writing', async () => {
      const mdDir = path.join(tmpDir, 'nested', 'deep', 'docs');
      await store.writeDoc(mdDir, 'autocreate', { author: 'test' }, 'auto-created dir');
      expect(fs.existsSync(path.join(mdDir, 'autocreate.md'))).toBe(true);
    });

    // ── parseFrontmatter (pure function) ──

    it('should parse valid frontmatter from content string', () => {
      const content = '---\ntitle: "Test"\nversion: 1\n---\n\nBody text.';
      const result = parseFrontmatter(content);
      expect(result).not.toBeNull();
      expect(result!.meta.title).toBe('Test');
      expect(result!.meta.version).toBe(1);
      expect(result!.body).toBe('Body text.');
    });

    it('should return null for content without --- fence', () => {
      const result = parseFrontmatter('Just plain markdown, no frontmatter.');
      expect(result).toBeNull();
    });

    // ── serializeFrontmatter (pure function) ──

    it('should serialize meta and body back to parseable markdown', () => {
      const meta = { title: 'Roundtrip Test', version: 5, tags: ['a', 'b'] };
      const body = 'Body content.';
      const serialized = serializeFrontmatter(meta, body);
      const parsed = parseFrontmatter(serialized);
      expect(parsed).not.toBeNull();
      expect(parsed!.meta.title).toBe('Roundtrip Test');
      expect(parsed!.meta.version).toBe(5);
      expect(parsed!.meta.tags).toEqual(['a', 'b']);
      expect(parsed!.body).toBe('Body content.');
    });
  });
});
