/**
 * FileStore 单元测试
 *
 * 覆盖：创建/读取/更新/列表/软删除/查询/count
 * JSONL append-only 写入正确性
 * index.json 重建逻辑正确性
 * flock claim 并发测试
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import {
  FileStore,
  LockTimeoutError,
  parseChannels,
  stringifyChannels,
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

    it('should delete state by agentId', async () => {
      await store.createState('agent1', makeState('agent1'));
      await store.deleteState('agent1');
      const loaded = await store.getState('agent1');
      expect(loaded).toBeNull();
    });

    it('should throw on deleting non-existent state', async () => {
      await expect(store.deleteState('nonexistent')).rejects.toThrow('RuntimeState not found');
    });

    it('deleteState should not affect profile.json in same agent dir', async () => {
      await store.createProfile(makeProfile('agent1'));
      await store.createState('agent1', makeState('agent1'));
      await store.deleteState('agent1');
      const profile = await store.getProfile('agent1');
      expect(profile).not.toBeNull();
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

  describe('FileStore Index', () => {
    let store: FileStore;
    let tmpDir: string;

    beforeEach(() => { tmpDir = createTempDir(); store = new FileStore(tmpDir); });
    afterEach(() => { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); });

    async function seedDocs(dir: string): Promise<void> {
      await store.writeDoc(dir, 'doc-a', { id: 'a1', type: 'guideline', title: 'Alpha', status: 'stable' }, 'A');
      await store.writeDoc(dir, 'doc-b', { id: 'b2', type: 'architecture', title: 'Beta', status: 'draft' }, 'B');
      await store.writeDoc(dir, 'doc-c', { id: 'c3', type: 'guideline', title: 'Gamma', status: 'stable' }, 'C');
    }

    it('should build _index.md with filename|field1|field2 format', async () => {
      const d = path.join(tmpDir, 'kb');
      await seedDocs(d);
      await store.buildIndex(d, ['id', 'type', 'title', 'status']);
      const idx = fs.readFileSync(path.join(d, '_index.md'), 'utf-8');
      expect(idx).toContain('doc-a');
      expect(idx).toContain('|a1|');
      expect(idx).toContain('|guideline|');
    });

    it('should generate header-only index for empty directory', async () => {
      const d = path.join(tmpDir, 'empty');
      fs.mkdirSync(d, { recursive: true });
      await store.buildIndex(d, ['id', 'type']);
      const idx = fs.readFileSync(path.join(d, '_index.md'), 'utf-8');
      expect(idx.split('\n').filter(l => l.trim() && !l.startsWith('#'))).toHaveLength(0);
    });

    it('should output empty string for missing fields', async () => {
      const d = path.join(tmpDir, 'p');
      await store.writeDoc(d, 'pdoc', { id: 'p1' }, 'c');
      await store.buildIndex(d, ['id', 'type']);
      expect(fs.readFileSync(path.join(d, '_index.md'), 'utf-8')).toContain('pdoc.md|p1|');
    });

    it('should return matching filenames for field=value query', async () => {
      const d = path.join(tmpDir, 'kb');
      await seedDocs(d);
      await store.buildIndex(d, ['id', 'type', 'title', 'status']);
      const r = await store.queryIndex(d, 'type', 'guideline');
      expect(r).toHaveLength(2);
      expect(r).toContain('doc-a');
      expect(r).toContain('doc-c');
    });

    it('should return empty array when no match', async () => {
      const d = path.join(tmpDir, 'kb');
      await seedDocs(d);
      await store.buildIndex(d, ['id', 'type']);
      expect(await store.queryIndex(d, 'type', 'nope')).toEqual([]);
    });

    it('should list docs from _index.md', async () => {
      const d = path.join(tmpDir, 'kb');
      await seedDocs(d);
      await store.buildIndex(d, ['id']);
      expect(await store.listDocs(d)).toHaveLength(3);
    });

    it('should fallback to directory scan when _index.md missing', async () => {
      const d = path.join(tmpDir, 'kb');
      await seedDocs(d);
      expect(await store.listDocs(d)).toHaveLength(3);
    });

    it('should return empty array for empty dir', async () => {
      const d = path.join(tmpDir, 'e');
      fs.mkdirSync(d, { recursive: true });
      expect(await store.listDocs(d)).toEqual([]);
    });

    it('should return filename when field matches', async () => {
      const d = path.join(tmpDir, 'kb');
      await seedDocs(d);
      await store.buildIndex(d, ['id', 'type']);
      expect(await store.findByField(d, 'id', 'b2')).toBe('doc-b');
    });

    it('should return null when field does not match', async () => {
      const d = path.join(tmpDir, 'kb');
      await seedDocs(d);
      await store.buildIndex(d, ['id']);
      expect(await store.findByField(d, 'id', 'nope')).toBeNull();
    });
  });

  describe('FileStore Version', () => {
    let store: FileStore;
    let tmpDir: string;

    beforeEach(() => { tmpDir = createTempDir(); store = new FileStore(tmpDir); });
    afterEach(() => { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); });

    it('should increment version and write changeType/changeDesc', async () => {
      const d = path.join(tmpDir, 'sdd');
      await store.writeDoc(d, 'v', { version: 3, title: 'T' }, 'body');
      await store.bumpVersion(d, 'v', 'L2', 'design updated');
      const doc = await store.readDoc(d, 'v');
      expect(doc!.meta.version).toBe(4);
      expect(doc!.meta.changeType).toBe('L2');
      expect(doc!.meta.changeDesc).toBe('design updated');
    });

    it('should init version to 1 when non-numeric', async () => {
      const d = path.join(tmpDir, 'sdd');
      await store.writeDoc(d, 'nv', { title: 'NV' }, 'body');
      await store.bumpVersion(d, 'nv', 'L1', 'first');
      expect((await store.readDoc(d, 'nv'))!.meta.version).toBe(1);
    });

    it('should throw when doc does not exist', async () => {
      await expect(store.bumpVersion(path.join(tmpDir, 'sdd'), 'x', 'L1', 'x')).rejects.toThrow();
    });

    it('should append changelog with ISO timestamp', async () => {
      const d = path.join(tmpDir, 'sdd');
      await store.writeDoc(d, 't', { version: 1 }, 'body');
      await store.appendChangelog(d, 't', 'Initial.');
      const c = fs.readFileSync(path.join(d, 't', 'CHANGELOG.md'), 'utf-8');
      expect(c).toContain('# CHANGELOG');
      expect(c).toContain('Initial.');
    });

    it('should auto-create CHANGELOG when not exists', async () => {
      const d = path.join(tmpDir, 'sdd');
      await store.appendChangelog(d, 'nd', 'First.');
      const c = fs.readFileSync(path.join(d, 'nd', 'CHANGELOG.md'), 'utf-8');
      expect(c).toContain('# CHANGELOG');
    });

    it('should not overwrite old entries on multiple appends', async () => {
      const d = path.join(tmpDir, 'sdd');
      await store.writeDoc(d, 'me', { version: 1 }, 'body');
      await store.appendChangelog(d, 'me', 'E1.');
      await store.appendChangelog(d, 'me', 'E2.');
      const c = fs.readFileSync(path.join(d, 'me', 'CHANGELOG.md'), 'utf-8');
      expect(c).toContain('E1.');
      expect(c).toContain('E2.');
    });
  });

  // ─── AC-A1: public json/jsonl methods ───

  describe('FileStore public JSON/JSONL methods', () => {
    it('should allow external call to appendJsonl', async () => {
      const fp = path.join(tmpDir, 'public-append.jsonl');
      await store.appendJsonl(fp, { id: '1', msg: 'hello' });
      const lines = fs.readFileSync(fp, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).msg).toBe('hello');
    });

    it('should allow external call to readJsonl<T>', async () => {
      const fp = path.join(tmpDir, 'public-read.jsonl');
      fs.writeFileSync(fp, JSON.stringify({ id: '1' }) + '\n' + JSON.stringify({ id: '2' }) + '\n');
      const rows = await store.readJsonl<{ id: string }>(fp);
      expect(rows).toHaveLength(2);
      expect(rows[0].id).toBe('1');
    });

    it('should skip corrupt lines in readJsonl', async () => {
      const fp = path.join(tmpDir, 'public-corrupt.jsonl');
      fs.writeFileSync(fp, JSON.stringify({ id: '1' }) + '\nNOT-JSON\n' + JSON.stringify({ id: '2' }) + '\n');
      const rows = await store.readJsonl<{ id: string }>(fp);
      expect(rows).toHaveLength(2);
    });

    it('should return empty array for non-existent jsonl file', async () => {
      const rows = await store.readJsonl<unknown>(path.join(tmpDir, 'nope.jsonl'));
      expect(rows).toEqual([]);
    });

    it('should allow external call to readJson<T>', async () => {
      const fp = path.join(tmpDir, 'public-read.json');
      fs.writeFileSync(fp, JSON.stringify({ key: 'val' }));
      const data = await store.readJson<{ key: string }>(fp);
      expect(data).not.toBeNull();
      expect(data!.key).toBe('val');
    });

    it('should return null for non-existent json file', async () => {
      const data = await store.readJson<unknown>(path.join(tmpDir, 'nope.json'));
      expect(data).toBeNull();
    });

    it('should return null for corrupt json file', async () => {
      const fp = path.join(tmpDir, 'corrupt.json');
      fs.writeFileSync(fp, '{bad json');
      const data = await store.readJson<unknown>(fp);
      expect(data).toBeNull();
    });

    it('should allow external call to writeJson', async () => {
      const fp = path.join(tmpDir, 'sub', 'public-write.json');
      await store.writeJson(fp, { created: true, count: 42 });
      const raw = fs.readFileSync(fp, 'utf-8');
      const parsed = JSON.parse(raw);
      expect(parsed.created).toBe(true);
      expect(parsed.count).toBe(42);
    });

    it('should overwrite existing json with writeJson', async () => {
      const fp = path.join(tmpDir, 'public-overwrite.json');
      await store.writeJson(fp, { v: 1 });
      await store.writeJson(fp, { v: 2 });
      const data = await store.readJson<{ v: number }>(fp);
      expect(data!.v).toBe(2);
    });
  });
});

// ─── F3: channels 字段解析/归一化/迁移 ───

describe('parseChannels (F3)', () => {
  it('parses single-encoded JSON array string', () => {
    expect(parseChannels('["ch-1","ch-2"]')).toEqual(['ch-1', 'ch-2']);
  });

  it('unwraps double-encoded value (legacy write bug)', () => {
    // 形如 "\"[\\\"ch-1\\\"]\""（live 数据中的实际形态）
    const doubleEncoded = JSON.stringify(JSON.stringify(['ch-1']));
    expect(parseChannels(doubleEncoded)).toEqual(['ch-1']);
  });

  it('accepts an already-parsed array', () => {
    expect(parseChannels(['ch-1'])).toEqual(['ch-1']);
  });

  it('returns [] for empty array / empty string', () => {
    expect(parseChannels('[]')).toEqual([]);
    expect(parseChannels('')).toEqual([]);
    expect(parseChannels('   ')).toEqual([]);
  });

  it('returns [] for garbage / non-string-array values', () => {
    expect(parseChannels('not json')).toEqual([]);
    expect(parseChannels('42')).toEqual([]);
    expect(parseChannels('{"a":1}')).toEqual([]);
    expect(parseChannels(null)).toEqual([]);
    expect(parseChannels(undefined)).toEqual([]);
    expect(parseChannels(42)).toEqual([]);
  });

  it('filters non-string entries from parsed arrays', () => {
    expect(parseChannels('["a",1,null,"b"]')).toEqual(['a', 'b']);
  });

  it('returns [] for triple-encoded garbage depth', () => {
    const triple = JSON.stringify(JSON.stringify(JSON.stringify(['x'])));
    expect(parseChannels(triple)).toEqual([]);
  });
});

describe('stringifyChannels (F3)', () => {
  it('stores arrays as single-encoded JSON', () => {
    expect(stringifyChannels(['ch-1', 'ch-2'])).toBe('["ch-1","ch-2"]');
  });

  it('normalizes single-encoded string input (legacy client)', () => {
    expect(stringifyChannels('["ch-1"]')).toBe('["ch-1"]');
  });

  it('normalizes double-encoded string input', () => {
    expect(stringifyChannels(JSON.stringify(JSON.stringify(['ch-1'])))).toBe('["ch-1"]');
  });

  it('normalizes garbage / undefined to []', () => {
    expect(stringifyChannels('garbage')).toBe('[]');
    expect(stringifyChannels(undefined)).toBe('[]');
  });
});

describe('FileStore.migrateChannelsEncoding (F3)', () => {
  let tmpDir: string;
  let store: FileStore;

  beforeEach(() => {
    tmpDir = createTempDir();
    store = new FileStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('rewrites double-encoded channels to single encoding', async () => {
    const good = makeProfile('p-good');
    good.channels = '["ch-1"]';
    const bad = makeProfile('p-bad');
    bad.channels = JSON.stringify(JSON.stringify(['ch-2']));
    await store.createProfile(good);
    await store.createProfile(bad);

    const result = await store.migrateChannelsEncoding();
    expect(result).toEqual({ scanned: 2, rewritten: 1 });

    expect((await store.getProfile('p-good'))!.channels).toBe('["ch-1"]');
    expect((await store.getProfile('p-bad'))!.channels).toBe('["ch-2"]');
  });

  it('dryRun counts but does not write', async () => {
    const bad = makeProfile('p-bad');
    bad.channels = JSON.stringify(JSON.stringify(['ch-2']));
    await store.createProfile(bad);

    const result = await store.migrateChannelsEncoding({ dryRun: true });
    expect(result).toEqual({ scanned: 1, rewritten: 1 });
    expect((await store.getProfile('p-bad'))!.channels).toBe(bad.channels);
  });

  it('skips malformed profile.json and missing channels field', async () => {
    const dir = path.join(tmpDir, 'agents', 'p-corrupt');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'profile.json'), '{bad json');
    const noChannels = makeProfile('p-no-channels');
    delete (noChannels as Partial<AgentProfileData>).channels;
    await store.createProfile(noChannels);

    const result = await store.migrateChannelsEncoding();
    expect(result).toEqual({ scanned: 0, rewritten: 0 });
  });

  it('returns zeros when agents dir does not exist', async () => {
    const result = await store.migrateChannelsEncoding();
    expect(result).toEqual({ scanned: 0, rewritten: 0 });
  });
});

// ─── T6: writeJson 原子写 + WorkUnit index 并发写加锁 + getIndex 损坏语义 ───

describe('FileStore T6: 原子写与并发', () => {
  let tmpDir: string;
  let store: FileStore;

  beforeEach(() => {
    tmpDir = createTempDir();
    store = new FileStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeSnapshot(id: string): WorkUnitSnapshot {
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
    };
  }

  const indexJsonPath = () => path.join(tmpDir, 'workunits', 'index.json');

  function writeTornIndex(content = '[{"id":"wu1",'): string {
    fs.mkdirSync(path.dirname(indexJsonPath()), { recursive: true });
    fs.writeFileSync(indexJsonPath(), content);
    return content;
  }

  describe('writeJson 原子写', () => {
    it('写入后不残留 tmp 文件', async () => {
      await store.writeJson(path.join(tmpDir, 'a.json'), { v: 1 });
      expect(fs.readdirSync(tmpDir).filter(f => f.includes('.tmp-'))).toEqual([]);
    });

    it('并发写不同文件互不干扰', async () => {
      await Promise.all(Array.from({ length: 20 }, (_, i) =>
        store.writeJson(path.join(tmpDir, `f-${i}.json`), { v: i })));
      for (let i = 0; i < 20; i++) {
        expect(JSON.parse(fs.readFileSync(path.join(tmpDir, `f-${i}.json`), 'utf-8'))).toEqual({ v: i });
      }
      expect(fs.readdirSync(tmpDir).filter(f => f.includes('.tmp-'))).toEqual([]);
    });

    it('并发写同一文件不产生撕裂 JSON（结果必是某个完整 payload）', async () => {
      const fp = path.join(tmpDir, 'race.json');
      const payloads = Array.from({ length: 20 }, (_, i) => ({ v: i, pad: 'x'.repeat(4096) }));
      await Promise.all(payloads.map(p => store.writeJson(fp, p)));
      const parsed = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      expect(payloads).toContainEqual(parsed);
      expect(fs.readdirSync(tmpDir).filter(f => f.includes('.tmp-'))).toEqual([]);
    });
  });

  describe('getIndex 损坏文件语义', () => {
    it('index.json 缺失 → 返回空数组', async () => {
      expect(await store.getIndex()).toEqual([]);
    });

    it('index.json 撕裂 → 抛出带路径的错误（不再静默当空）', async () => {
      writeTornIndex();
      await expect(store.getIndex()).rejects.toThrow(indexJsonPath());
    });

    it('index.json 内容不是数组 → 同样抛错', async () => {
      writeTornIndex('{"not":"an array"}');
      await expect(store.getIndex()).rejects.toThrow(indexJsonPath());
    });

    it('upsertSnapshot 遇到撕裂 index → 抛错且不覆盖原文件', async () => {
      const torn = writeTornIndex();
      await expect(store.upsertSnapshot(makeSnapshot('wu-x'))).rejects.toThrow('index.json');
      // 不允许基于空数组回写把撕裂文件"洗白"（数据全丢路径）
      expect(fs.readFileSync(indexJsonPath(), 'utf-8')).toBe(torn);
    });

    it('removeSnapshot 遇到撕裂 index → 抛错', async () => {
      writeTornIndex();
      await expect(store.removeSnapshot('wu1')).rejects.toThrow('index.json');
    });

    it('claimWorkUnit 遇到撕裂 index → 抛错而非幻影 false', async () => {
      writeTornIndex();
      await expect(store.claimWorkUnit('wu1', 'agent1')).rejects.toThrow('index.json');
    });
  });

  describe('upsertSnapshot/removeSnapshot 锁（同进程）', () => {
    it('并发 upsert 50 个不同 id 全部保留', async () => {
      await Promise.all(Array.from({ length: 50 }, (_, i) => store.upsertSnapshot(makeSnapshot(`c-${i}`))));
      const ids = (await store.getIndex()).map(s => s.id);
      expect(ids).toHaveLength(50);
      expect(new Set(ids).size).toBe(50);
    });

    it('并发 remove 与 upsert 混合不丢数据', async () => {
      for (let i = 0; i < 20; i++) await store.upsertSnapshot(makeSnapshot(`keep-${i}`));
      await Promise.all([
        ...Array.from({ length: 20 }, (_, i) => store.upsertSnapshot(makeSnapshot(`new-${i}`))),
        ...Array.from({ length: 10 }, (_, i) => store.removeSnapshot(`keep-${i}`)),
      ]);
      const ids = (await store.getIndex()).map(s => s.id);
      expect(ids).toHaveLength(30);
      for (let i = 10; i < 20; i++) expect(ids).toContain(`keep-${i}`);
      for (let i = 0; i < 20; i++) expect(ids).toContain(`new-${i}`);
    });
  });

  // 多进程压测：tsx 起子进程跑真实 FileStore，验证跨进程锁 + 原子写
  describe('多进程并发压测', () => {
    const REPO_ROOT = path.resolve(__dirname, '../../../..');
    const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
    const FILE_STORE_TS = pathToFileURL(path.resolve(__dirname, '..', 'file-store.ts')).href;

    function writeWorker(): string {
      const workerPath = path.join(tmpDir, 't6-worker.ts');
      fs.writeFileSync(workerPath, `
import { FileStore } from ${JSON.stringify(FILE_STORE_TS)};
import type { WorkUnitSnapshot } from ${JSON.stringify(FILE_STORE_TS)};

const [baseDir, mode, workerId, countStr] = process.argv.slice(2);
const count = parseInt(countStr, 10);
const store = new FileStore(baseDir);

function makeSnapshot(id: string): WorkUnitSnapshot {
  const now = new Date().toISOString();
  return {
    id, parentId: null, type: 'task', scope: 'scope-' + id, assigneeId: null,
    status: 'unassigned', failureType: null, retryCount: 0, timeoutAt: null,
    channelId: null, projectPath: null, metadata: null,
    createdAt: now, updatedAt: now, claimedAt: null, completedAt: null,
  };
}

async function main() {
  for (let j = 0; j < count; j++) {
    const id = workerId + '-' + j;
    if (mode === 'upsert') {
      await store.upsertSnapshot(makeSnapshot(id));
    } else {
      await store.removeSnapshot(id);
    }
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
`);
      return workerPath;
    }

    function runWorker(workerPath: string, args: string[]): Promise<void> {
      return new Promise((resolve, reject) => {
        const child = spawn(TSX_BIN, [workerPath, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
        let stderr = '';
        child.stderr!.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('error', reject);
        child.on('exit', code => {
          if (code === 0) resolve();
          else reject(new Error(`worker exited ${code}: ${stderr}`));
        });
      });
    }

    it('8 进程 × 25 upsert：无丢无重、无 tmp 残留', async () => {
      expect(fs.existsSync(TSX_BIN)).toBe(true);
      const PROCS = 8, PER = 25;
      const workerPath = writeWorker();
      await Promise.all(Array.from({ length: PROCS }, (_, i) =>
        runWorker(workerPath, [tmpDir, 'upsert', `w${i}`, String(PER)])));

      const index = await store.getIndex();
      const ids = index.map(s => s.id);
      expect(ids).toHaveLength(PROCS * PER);
      expect(new Set(ids).size).toBe(PROCS * PER);
      for (let i = 0; i < PROCS; i++) {
        for (let j = 0; j < PER; j++) expect(ids).toContain(`w${i}-${j}`);
      }
      const leftovers = fs.readdirSync(path.join(tmpDir, 'workunits')).filter(f => f.includes('.tmp-'));
      expect(leftovers).toEqual([]);
    }, 30000);

    it('8 进程 × 25 remove：全部删除', async () => {
      expect(fs.existsSync(TSX_BIN)).toBe(true);
      const PROCS = 8, PER = 25;
      // 预置 PROCS*PER 条（直接原子写 index，避免 200 次串行 upsert 拖慢测试）
      const seed: WorkUnitSnapshot[] = [];
      for (let i = 0; i < PROCS; i++) for (let j = 0; j < PER; j++) seed.push(makeSnapshot(`w${i}-${j}`));
      await store.writeJson(indexJsonPath(), seed);

      const workerPath = writeWorker();
      await Promise.all(Array.from({ length: PROCS }, (_, i) =>
        runWorker(workerPath, [tmpDir, 'remove', `w${i}`, String(PER)])));

      expect(await store.getIndex()).toEqual([]);
    }, 30000);
  });
});

// CWD 陷阱修复：FileStore baseDir 解耦 HOME，改读 STUDIO_DATA_DIR env。
// 根因：buildSessionEnv 把 claude CLI 子进程 HOME 设成 agentHome（GAP-2 隔离），
// 子进程里 new FileStore() 无参构造时 os.homedir() 返回 agentHome，baseDir 漂移到
// ~/.studio/data/agents/<profile-id>/.studio/data 产生嵌套。解耦后 env 优先于 homedir。
describe('FileStore baseDir resolution (STUDIO_DATA_DIR decouples from HOME)', () => {
  const prevEnv = process.env.STUDIO_DATA_DIR;

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.STUDIO_DATA_DIR;
    else process.env.STUDIO_DATA_DIR = prevEnv;
    vi.restoreAllMocks();
  });

  it('uses STUDIO_DATA_DIR env when baseDir arg omitted (not os.homedir)', async () => {
    const envDir = createTempDir();
    const homedirFallback = createTempDir();
    process.env.STUDIO_DATA_DIR = envDir;
    vi.spyOn(os, 'homedir').mockReturnValue(homedirFallback);

    const store = new FileStore();
    await store.createProfile(makeProfile('p-env', 'env-agent'));

    expect(fs.existsSync(path.join(envDir, 'agents', 'p-env', 'profile.json'))).toBe(true);
    expect(fs.existsSync(path.join(homedirFallback, 'agents', 'p-env', 'profile.json'))).toBe(false);
  });

  it('explicit baseDir arg overrides STUDIO_DATA_DIR env', async () => {
    const envDir = createTempDir();
    const argDir = createTempDir();
    process.env.STUDIO_DATA_DIR = envDir;

    const store = new FileStore(argDir);
    await store.createProfile(makeProfile('p-arg', 'arg-agent'));

    expect(fs.existsSync(path.join(argDir, 'agents', 'p-arg', 'profile.json'))).toBe(true);
    expect(fs.existsSync(path.join(envDir, 'agents', 'p-arg', 'profile.json'))).toBe(false);
  });

  it('falls back to os.homedir()/.studio/data when neither arg nor env set', async () => {
    const homedirFallback = createTempDir();
    delete process.env.STUDIO_DATA_DIR;
    vi.spyOn(os, 'homedir').mockReturnValue(homedirFallback);

    const store = new FileStore();
    await store.createProfile(makeProfile('p-home', 'home-agent'));

    expect(fs.existsSync(path.join(homedirFallback, '.studio', 'data', 'agents', 'p-home', 'profile.json'))).toBe(true);
  });
});
