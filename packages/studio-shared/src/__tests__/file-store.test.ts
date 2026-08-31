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

    it('should throw on duplicate-create profile (#362 统一口径①)', async () => {
      await store.createProfile(makeProfile('p1'));
      await expect(store.createProfile(makeProfile('p1'))).rejects.toThrow('AgentProfile already exists');
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

    it('updateState 自动补 updatedAt（#362 统一口径②）', async () => {
      // makeState 不含 updatedAt：创建后原样落盘，更新后必须出现
      await store.createState('agent1', makeState('agent1'));
      expect((await store.getState('agent1'))?.updatedAt).toBeUndefined();
      await new Promise(resolve => setTimeout(resolve, 10));
      await store.updateState('agent1', { status: 'active' });
      const loaded = await store.getState('agent1');
      expect(loaded?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
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

    // #363: agent 实例目录生命周期闭环 —— deleteState 判空删目录 + 存量清扫

    it('#363 deleteState 后实例目录为空 → 目录一并删除', async () => {
      await store.createState('agent1', makeState('agent1'));
      const dir = path.join(tmpDir, 'agents', 'agent1');
      expect(fs.existsSync(dir)).toBe(true);

      await store.deleteState('agent1');

      expect(fs.existsSync(dir)).toBe(false);
      expect(fs.existsSync(path.join(tmpDir, 'agents'))).toBe(true); // agents/ 本体不动
    });

    it('#363 deleteState 目录内有 profile.json → 只删 state.json，目录保留', async () => {
      await store.createProfile(makeProfile('agent1'));
      await store.createState('agent1', makeState('agent1'));

      await store.deleteState('agent1');

      const dir = path.join(tmpDir, 'agents', 'agent1');
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.existsSync(path.join(dir, 'state.json'))).toBe(false);
      expect(fs.existsSync(path.join(dir, 'profile.json'))).toBe(true);
    });

    it('#363 deleteState 目录内有其他文件 → 目录保留（共享 namespace 绝不碰他物）', async () => {
      await store.createState('agent1', makeState('agent1'));
      const dir = path.join(tmpDir, 'agents', 'agent1');
      fs.writeFileSync(path.join(dir, 'stray.txt'), 'x');

      await store.deleteState('agent1');

      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.existsSync(path.join(dir, 'stray.txt'))).toBe(true);
    });

    it('#363 sweepEmptyAgentDirs 删空目录、保留有内容目录', async () => {
      await store.createState('has-state', makeState('has-state'));
      await store.createProfile(makeProfile('has-profile'));
      const agentsDir = path.join(tmpDir, 'agents');
      fs.mkdirSync(path.join(agentsDir, 'empty-1'), { recursive: true });
      fs.mkdirSync(path.join(agentsDir, 'empty-2'), { recursive: true });

      const result = await store.sweepEmptyAgentDirs();

      expect(result.removed).toBe(2);
      expect(fs.existsSync(path.join(agentsDir, 'empty-1'))).toBe(false);
      expect(fs.existsSync(path.join(agentsDir, 'empty-2'))).toBe(false);
      expect(fs.existsSync(path.join(agentsDir, 'has-state'))).toBe(true);
      expect(fs.existsSync(path.join(agentsDir, 'has-profile'))).toBe(true);
    });

    it('#363 sweepEmptyAgentDirs 幂等：二次清扫 removed=0', async () => {
      const agentsDir = path.join(tmpDir, 'agents');
      fs.mkdirSync(path.join(agentsDir, 'empty-1'), { recursive: true });

      const first = await store.sweepEmptyAgentDirs();
      const second = await store.sweepEmptyAgentDirs();

      expect(first.removed).toBe(1);
      expect(second.removed).toBe(0);
    });

    it('#363 sweepEmptyAgentDirs agents 目录不存在 → removed=0 不抛错', async () => {
      fs.rmSync(path.join(tmpDir, 'agents'), { recursive: true, force: true });
      const result = await store.sweepEmptyAgentDirs();
      expect(result.removed).toBe(0);
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

    it('should throw on duplicate-create channel (#362 统一口径①)', async () => {
      await store.createChannel(makeChannel('ch1'));
      await expect(store.createChannel(makeChannel('ch1'))).rejects.toThrow('Channel already exists');
    });
  });

  // ═══ 扁平目录 JSON 清单原语（#362）═══

  describe('listJsonInDir', () => {
    it('目录不存在返回 []，不建目录', async () => {
      const dir = path.join(tmpDir, 'no-such-flat-dir');
      expect(await store.listJsonInDir(dir)).toEqual([]);
      expect(fs.existsSync(dir)).toBe(false);
    });

    it('只收 *.json，损坏文件跳过、保序返回', async () => {
      const dir = path.join(tmpDir, 'flat');
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'b.json'), JSON.stringify({ id: 'b' }));
      fs.writeFileSync(path.join(dir, 'a.json'), '{corrupt');
      fs.writeFileSync(path.join(dir, 'note.txt'), 'x');
      fs.writeFileSync(path.join(dir, 'c.json'), JSON.stringify({ id: 'c' }));
      expect(await store.listJsonInDir<{ id: string }>(dir)).toEqual([{ id: 'b' }, { id: 'c' }]);
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

  // ═══ queryAllMessages channelIds 预过滤（#330）═══

  describe('queryAllMessages channelIds 预过滤（#330）', () => {
    beforeEach(async () => {
      await store.createChannel(makeChannel('ch-a'));
      await store.createChannel(makeChannel('ch-b'));
      await store.createChannel(makeChannel('ch-c'));
      await store.appendMessage('ch-a', makeMessage('ma1', 'ch-a', { workUnitId: 'wu-1', authorType: 'human' }));
      await store.appendMessage('ch-b', makeMessage('mb1', 'ch-b', { workUnitId: 'wu-1', authorType: 'human' }));
      await store.appendMessage('ch-b', makeMessage('mb2', 'ch-b', { workUnitId: 'wu-2', authorType: 'agent' }));
      await store.appendMessage('ch-c', makeMessage('mc1', 'ch-c', { workUnitId: 'wu-3', authorType: 'human' }));
    });

    it('channelIds 预过滤：只返回集合内频道的消息', async () => {
      const msgs = await store.queryAllMessages({ channelIds: ['ch-a', 'ch-c'] });
      expect(msgs.map(m => m.id).sort()).toEqual(['ma1', 'mc1']);
    });

    it('不传 channelIds：跨频道全扫（既有行为不变）', async () => {
      const msgs = await store.queryAllMessages({ workUnitId: 'wu-1' });
      expect(msgs.map(m => m.id).sort()).toEqual(['ma1', 'mb1']);
    });

    it('channelIds 与 workUnitIds/authorType 叠加过滤', async () => {
      const msgs = await store.queryAllMessages({
        channelIds: ['ch-b'],
        workUnitIds: ['wu-1', 'wu-2'],
        authorType: 'agent',
      });
      expect(msgs.map(m => m.id)).toEqual(['mb2']);
    });

    it('channelIds 为空数组 → 空结果（不扫任何频道）', async () => {
      const msgs = await store.queryAllMessages({ channelIds: [] });
      expect(msgs).toEqual([]);
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

    describe('appendEvent / getIndex', () => {
      it('should filter index by status', async () => {
        const wu1 = makeWuSnapshot('wu1', { status: 'active' });
        const wu2 = makeWuSnapshot('wu2', { status: 'unassigned' });
        await store.appendEvent({ type: 'created', wuId: 'wu1', timestamp: new Date().toISOString(), data: wu1 as unknown as Record<string, unknown> });
        await store.appendEvent({ type: 'created', wuId: 'wu2', timestamp: new Date().toISOString(), data: wu2 as unknown as Record<string, unknown> });
        await store.upsertSnapshot(wu1);
        await store.upsertSnapshot(wu2);

        const active = await store.getIndex({ status: 'active' });
        expect(active).toHaveLength(1);
        expect(active[0].id).toBe('wu1');
      });

      it('should return snapshots from getIndex when index.json exists', async () => {
        const wu1 = makeWuSnapshot('wu1');
        await store.appendEvent({ type: 'created', wuId: 'wu1', timestamp: new Date().toISOString(), data: wu1 as unknown as Record<string, unknown> });
        await store.upsertSnapshot(wu1);

        // Now getIndex should read from index.json (already written by upsertSnapshot)
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
        await store.upsertSnapshot(wu1);

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
        await store.upsertSnapshot(wu1);

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
        await store.upsertSnapshot(wu1);

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
  });

  describe('FileStore Version', () => {
    let store: FileStore;
    let tmpDir: string;

    beforeEach(() => { tmpDir = createTempDir(); store = new FileStore(tmpDir); });
    afterEach(() => { if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true }); });

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
  const prevHomeEnv = process.env.STUDIO_HOME;

  afterEach(() => {
    if (prevEnv === undefined) delete process.env.STUDIO_DATA_DIR;
    else process.env.STUDIO_DATA_DIR = prevEnv;
    if (prevHomeEnv === undefined) delete process.env.STUDIO_HOME;
    else process.env.STUDIO_HOME = prevHomeEnv;
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
    delete process.env.STUDIO_HOME; // #219 setup 双轨钉死后 STUDIO_HOME 也算 env 输入
    vi.spyOn(os, 'homedir').mockReturnValue(homedirFallback);

    const store = new FileStore();
    await store.createProfile(makeProfile('p-home', 'home-agent'));

    expect(fs.existsSync(path.join(homedirFallback, '.studio', 'data', 'agents', 'p-home', 'profile.json'))).toBe(true);
  });
});

// ─── A1（工单 26）：读穿缓存行为 ───

describe('FileStore 读穿缓存 (A1)', () => {
  let tmpDir: string;
  let store: FileStore;

  beforeEach(() => {
    tmpDir = createTempDir();
    store = new FileStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('写后读立即可见（缓存命中后 update → 再读为新值）', async () => {
    await store.createProfile(makeProfile('p1', 'before'));
    const cached = await store.getProfile('p1'); // 填充缓存
    expect(cached?.name).toBe('before');

    await store.updateProfile('p1', { name: 'after' });
    const loaded = await store.getProfile('p1');
    expect(loaded?.name).toBe('after');
  });

  it('删后失效（get 缓存命中 → delete → get 为 null，list 也不再包含）', async () => {
    await store.createProfile(makeProfile('p1'));
    expect(await store.getProfile('p1')).not.toBeNull();
    expect(await store.listProfiles()).toHaveLength(1); // 填充目录级缓存

    await store.deleteProfile('p1');
    expect(await store.getProfile('p1')).toBeNull();
    expect(await store.listProfiles()).toHaveLength(0);
  });

  it('缓存返回值被调用方原地 mutate 不污染后续读取', async () => {
    await store.createProfile(makeProfile('p1', 'pristine'));
    const first = await store.getProfile('p1');
    first!.name = 'mutated-by-caller';
    first!.channels = '["hacked"]';

    const second = await store.getProfile('p1');
    expect(second?.name).toBe('pristine');
    expect(second?.channels).toBe('[]');
  });

  it('list 并发读与重复读结果等价（30 个 profile）', async () => {
    const ids = Array.from({ length: 30 }, (_, i) => `p-${i}`);
    for (const id of ids) await store.createProfile(makeProfile(id));

    const [a, b, c] = await Promise.all([
      store.listProfiles(),
      store.listProfiles(),
      store.listProfiles({ status: 'active' }),
    ]);
    const expected = [...ids].sort();
    expect(a.map(p => p.id).sort()).toEqual(expected);
    expect(b.map(p => p.id).sort()).toEqual(expected);
    expect(c.map(p => p.id).sort()).toEqual(expected);
  });

  it('rename（updateChannel 改名）后 getChannel 与 listChannels 均反映新名', async () => {
    await store.createChannel(makeChannel('ch1', '#old'));
    expect((await store.listChannels())[0].name).toBe('#old'); // 填充缓存

    await store.updateChannel('ch1', { name: '#new' });
    expect((await store.getChannel('ch1'))?.name).toBe('#new');
    expect((await store.listChannels())[0].name).toBe('#new');
  });

  it('upsertSnapshot/removeSnapshot 后 getIndex 立即反映', async () => {
    const now = new Date().toISOString();
    const snap: WorkUnitSnapshot = {
      id: 'wu1', parentId: null, type: 'task', scope: 's', assigneeId: null,
      status: 'unassigned', failureType: null, retryCount: 0, timeoutAt: null,
      channelId: null, projectPath: null, metadata: null,
      createdAt: now, updatedAt: now, claimedAt: null, completedAt: null,
    };
    await store.upsertSnapshot(snap);
    expect((await store.getIndex()).map(s => s.id)).toEqual(['wu1']);

    await store.upsertSnapshot({ ...snap, status: 'active' });
    expect((await store.getIndex())[0].status).toBe('active');

    await store.removeSnapshot('wu1');
    expect(await store.getIndex()).toEqual([]);
  });

  it('appendMessage 后 queryMessages 立即可见（JSONL 缓存失效）', async () => {
    await store.createChannel(makeChannel('ch-m'));
    await store.appendMessage('ch-m', makeMessage('m1', 'ch-m'));
    expect(await store.queryMessages('ch-m')).toHaveLength(1);

    await store.appendMessage('ch-m', makeMessage('m2', 'ch-m'));
    expect(await store.queryMessages('ch-m')).toHaveLength(2);
  });

  it('外部写入（绕过 FileStore，mtime 变化）后读取不返回陈旧缓存', async () => {
    await store.createProfile(makeProfile('p1', 'internal'));
    expect((await store.getProfile('p1'))?.name).toBe('internal'); // 填充缓存

    // 模拟另一进程直接改文件，并显式推进 mtime 避免同毫秒粒度
    const fp = path.join(tmpDir, 'agents', 'p1', 'profile.json');
    fs.writeFileSync(fp, JSON.stringify({ ...makeProfile('p1', 'external') }));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(fp, future, future);

    expect((await store.getProfile('p1'))?.name).toBe('external');
  });

  it('软删除消息后 countMessages 立即反映（tombstone append 失效）', async () => {
    await store.createChannel(makeChannel('ch-d'));
    await store.appendMessage('ch-d', makeMessage('m1', 'ch-d'));
    await store.appendMessage('ch-d', makeMessage('m2', 'ch-d'));
    expect(await store.countMessages('ch-d')).toBe(2);

    await store.softDeleteMessage('ch-d', 'm1');
    expect(await store.countMessages('ch-d')).toBe(1);
  });
});

// ─── #314（D1）：getIndex 走读穿缓存 ───

describe('FileStore getIndex 读穿缓存 (#314)', () => {
  let tmpDir: string;
  let store: FileStore;

  beforeEach(() => {
    tmpDir = createTempDir();
    store = new FileStore(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const indexPath = () => path.join(tmpDir, 'workunits', 'index.json');

  function makeSnap(id: string, overrides?: Partial<WorkUnitSnapshot>): WorkUnitSnapshot {
    const now = new Date().toISOString();
    return {
      id, parentId: null, type: 'task', scope: `scope-${id}`, assigneeId: null,
      status: 'unassigned', failureType: null, retryCount: 0, timeoutAt: null,
      channelId: null, projectPath: null, metadata: null,
      createdAt: now, updatedAt: now, claimedAt: null, completedAt: null,
      ...overrides,
    };
  }

  it('index.json 未变化时重复 getIndex 不重读文件（stat 校验命中缓存）', async () => {
    await store.upsertSnapshot(makeSnap('wu1'));
    const readSpy = vi.spyOn(fs.promises, 'readFile');
    const indexReads = () => readSpy.mock.calls.filter(c => String(c[0]) === indexPath()).length;

    const first = await store.getIndex();
    expect(first.map(s => s.id)).toEqual(['wu1']);
    const readsAfterFirst = indexReads();
    expect(readsAfterFirst).toBe(1);

    await store.getIndex();
    await store.getIndex({ status: 'unassigned' });
    expect(indexReads()).toBe(readsAfterFirst); // 命中缓存，零新增 readFile
  });

  it('外部写入（绕过 FileStore，mtime 变化）后 getIndex 不返回陈旧缓存', async () => {
    await store.upsertSnapshot(makeSnap('wu1'));
    expect((await store.getIndex()).map(s => s.id)).toEqual(['wu1']); // 填充缓存

    // 模拟另一进程直接改 index.json，并显式推进 mtime 避免同毫秒粒度
    fs.writeFileSync(indexPath(), JSON.stringify([makeSnap('wu1'), makeSnap('wu2-ext')]));
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(indexPath(), future, future);

    expect((await store.getIndex()).map(s => s.id)).toEqual(['wu1', 'wu2-ext']);
  });

  it('getIndex 缓存命中返回结构克隆，调用方原地 mutate 不污染缓存', async () => {
    await store.upsertSnapshot(makeSnap('wu1', { scope: 'pristine' }));
    const first = await store.getIndex();
    first[0].scope = 'mutated-by-caller';

    const second = await store.getIndex();
    expect(second[0].scope).toBe('pristine');
  });

  it('index.json 撕裂 → getIndex 仍抛带路径的错误（缓存不吞严格语义）', async () => {
    await store.upsertSnapshot(makeSnap('wu1'));
    expect(await store.getIndex()).toHaveLength(1); // 填充缓存

    fs.mkdirSync(path.dirname(indexPath()), { recursive: true });
    fs.writeFileSync(indexPath(), '[{"id":"wu1",');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(indexPath(), future, future);

    await expect(store.getIndex()).rejects.toThrow(indexPath());
  });
});

// ─── #321：readDoc 走读穿缓存 ───

describe('FileStore readDoc 读穿缓存 (#321)', () => {
  let tmpDir: string;
  let store: FileStore;

  beforeEach(() => {
    tmpDir = createTempDir();
    store = new FileStore(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const docsDir = () => path.join(tmpDir, 'docs');
  const docPath = () => path.join(docsDir(), 'hello.md');

  it('文档未变化时重复 readDoc 不重读文件（stat 校验命中缓存）', async () => {
    await store.writeDoc(docsDir(), 'hello', { title: 'T' }, '正文 body');
    const readSpy = vi.spyOn(fs.promises, 'readFile');
    const docReads = () => readSpy.mock.calls.filter(c => String(c[0]) === docPath()).length;

    const first = await store.readDoc(docsDir(), 'hello');
    expect(first?.meta.title).toBe('T');
    const readsAfterFirst = docReads();
    expect(readsAfterFirst).toBe(1);

    await store.readDoc(docsDir(), 'hello');
    await store.readDoc(docsDir(), 'hello');
    expect(docReads()).toBe(readsAfterFirst); // 命中缓存，零新增 readFile
  });

  it('外部写入（绕过 FileStore，mtime 变化）后 readDoc 不返回陈旧缓存', async () => {
    await store.writeDoc(docsDir(), 'hello', { title: 'old' }, '旧正文');
    expect((await store.readDoc(docsDir(), 'hello'))?.meta.title).toBe('old'); // 填充缓存

    // 模拟另一进程直接改文件，并显式推进 mtime 避免同毫秒粒度
    fs.writeFileSync(docPath(), '---\ntitle: "new"\n---\n\n新正文');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(docPath(), future, future);

    const doc = await store.readDoc(docsDir(), 'hello');
    expect(doc?.meta.title).toBe('new');
    expect(doc?.body).toContain('新正文');
  });

  it('writeDoc 后 readDoc 立即可见（写路径失效缓存）', async () => {
    await store.writeDoc(docsDir(), 'hello', { title: 'before' }, 'a');
    expect((await store.readDoc(docsDir(), 'hello'))?.meta.title).toBe('before'); // 填充缓存

    await store.writeDoc(docsDir(), 'hello', { title: 'after' }, 'b');
    expect((await store.readDoc(docsDir(), 'hello'))?.meta.title).toBe('after');
  });

  it('readDoc 缓存命中返回结构克隆，调用方原地 mutate 不污染缓存', async () => {
    await store.writeDoc(docsDir(), 'hello', { title: 'pristine' }, 'body');
    const first = await store.readDoc(docsDir(), 'hello');
    first!.meta.title = 'mutated-by-caller';
    first!.body = 'mutated';

    const second = await store.readDoc(docsDir(), 'hello');
    expect(second?.meta.title).toBe('pristine');
    expect(second?.body).not.toContain('mutated');
  });

  it('readDocWithMtime 返回校验用 mtimeMs，缓存命中与首次读取同源', async () => {
    await store.writeDoc(docsDir(), 'hello', { title: 'T' }, 'b');
    const first = await store.readDocWithMtime(docsDir(), 'hello');
    expect(first?.mtimeMs).toBeGreaterThan(0);

    const second = await store.readDocWithMtime(docsDir(), 'hello');
    expect(second?.mtimeMs).toBe(first?.mtimeMs); // 命中缓存，mtimeMs 与缓存校验戳一致

    // 外部推进 mtime 后重读，mtimeMs 跟随新戳
    fs.writeFileSync(docPath(), '---\ntitle: "T2"\n---\n\nb2');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(docPath(), future, future);
    const third = await store.readDocWithMtime(docsDir(), 'hello');
    expect(third?.meta.title).toBe('T2');
    expect(third?.mtimeMs).toBe(fs.statSync(docPath()).mtimeMs); // 与文件当前 stat 同源（utimes 浮点换算不直接等值比较）
  });

  it('readdir 读穿缓存：目录未变化重复读不重扫，外部新增文件后可见', async () => {
    const dir = docsDir();
    await store.writeDoc(dir, 'a', {}, 'a');
    const readdirSpy = vi.spyOn(fs.promises, 'readdir');
    const dirReads = () => readdirSpy.mock.calls.filter(c => String(c[0]) === dir).length;

    const first = await store.readdir(dir);
    expect(first.map(e => e.name)).toEqual(['a.md']);
    const readsAfterFirst = dirReads();
    expect(readsAfterFirst).toBe(1);

    await store.readdir(dir);
    expect(dirReads()).toBe(readsAfterFirst); // 命中缓存，零新增 readdir

    // 外部新增文件 → 目录 mtime 变化 → 重扫可见（显式推进 mtime 避免同毫秒粒度）
    fs.writeFileSync(path.join(dir, 'b.md'), 'b');
    const future = new Date(Date.now() + 5000);
    fs.utimesSync(dir, future, future);
    const second = await store.readdir(dir);
    expect(second.map(e => e.name).sort()).toEqual(['a.md', 'b.md']);
  });

  it('readdir 目录不存在抛 ENOENT（与 fs.readdir 语义一致）', async () => {
    await expect(store.readdir(path.join(tmpDir, 'no-such-dir'))).rejects.toThrow(/ENOENT/);
  });
});

// ─── #319：频道消息压实 + message-id 契约 + 分页下沉 ───

describe('频道消息压实（#319）', () => {
  let tmpDir: string;
  let store: FileStore;
  const CH = 'ch-compact';

  /** 小阈值注入：每次 append 都评估，4 行起、死行占比 ≥1/3 即压实 */
  function makeStore(opts?: { checkInterval?: number; minLines?: number; deadRatio?: number }) {
    return new FileStore(tmpDir, {
      messageCompaction: { checkInterval: 1, minLines: 4, deadRatio: 1 / 3, ...opts },
    });
  }

  function rawLines(): Array<Record<string, unknown>> {
    const fp = path.join(tmpDir, 'channels', CH, 'messages.jsonl');
    return fs.readFileSync(fp, 'utf-8').split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  }

  beforeEach(async () => {
    tmpDir = createTempDir();
    store = makeStore();
    await store.createChannel(makeChannel(CH));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('死行占比超阈值时压实：被覆盖行与 tombstone 消失，活消息与压实前逐条一致', async () => {
    await store.appendMessage(CH, makeMessage('m1', CH));
    await store.appendMessage(CH, makeMessage('m2', CH));
    await store.appendMessage(CH, makeMessage('m3', CH));
    await store.appendMessage(CH, makeMessage('m4', CH));
    // 编辑 m2（同 id 追加新版）+ 删除 m3（tombstone）→ 6 行，死行 3（m2 旧版、m3 原行、m3 tombstone）
    await store.appendMessage(CH, { ...makeMessage('m2', CH), content: 'm2 edited' });
    await store.softDeleteMessage(CH, 'm3');

    const before = await store.queryMessages(CH);
    // checkInterval=1：tombstone 落盘即评估——6 行死 3（m2 旧版、m3 原行、m3 tombstone）= 50% ≥ 1/3 → 当场压实
    expect(rawLines().map(r => r.id)).toEqual(['m1', 'm2', 'm4']);

    // 压实后续写不受影响
    await store.appendMessage(CH, makeMessage('m5', CH));

    const rows = rawLines();
    // 活行按首现位置归并：m1、m2（新内容）、m4、m5
    expect(rows.map(r => r.id)).toEqual(['m1', 'm2', 'm4', 'm5']);
    expect(rows.every(r => r.deleted === undefined)).toBe(true);
    expect(rows.find(r => r.id === 'm2')?.content).toBe('m2 edited');

    const after = await store.queryMessages(CH);
    // 压实前后可见消息逐条一致（压实只清死行），外加触发检查的那条 m5
    expect(after.map(m => m.id)).toEqual([...before.map(m => m.id), 'm5']);
    expect(after.find(m => m.id === 'm2')?.content).toBe('m2 edited');
  });

  it('死行占比不足阈值时不压实（文件原样）', async () => {
    await store.appendMessage(CH, makeMessage('m1', CH));
    await store.appendMessage(CH, makeMessage('m2', CH));
    await store.appendMessage(CH, makeMessage('m3', CH));
    await store.appendMessage(CH, makeMessage('m4', CH));
    await store.appendMessage(CH, makeMessage('m5', CH));
    await store.appendMessage(CH, { ...makeMessage('m1', CH), content: 'm1 edited' });
    // 6 行，死行 1/6 < 1/3 → 不压
    expect(rawLines()).toHaveLength(6);
  });

  it('压实后 getChannelVersion().lastMessageId 指向最后一条活消息', async () => {
    await store.appendMessage(CH, makeMessage('m1', CH));
    await store.appendMessage(CH, makeMessage('m2', CH));
    await store.appendMessage(CH, makeMessage('m3', CH));
    await store.softDeleteMessage(CH, 'm1');
    await store.softDeleteMessage(CH, 'm2'); // 6 行死 4 → 压实，活行 [m3]
    await store.appendMessage(CH, makeMessage('m4', CH));

    const version = await store.getChannelVersion(CH);
    expect(version.lastMessageId).toBe('m4');
  });

  it('压实与并发 append 互斥：不丢消息、结果完整', async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `c-${String(i).padStart(2, '0')}`);
    // checkInterval=1 + deadRatio=0 → 达 minLines 后每次 append 都压实，最大化压实/并发交错
    const stressed = makeStore({ deadRatio: 0 });
    await Promise.all(ids.map(id => stressed.appendMessage(CH, makeMessage(id, CH))));

    const msgs = await stressed.queryMessages(CH);
    expect(new Set(msgs.map(m => m.id))).toEqual(new Set(ids));
  });
});

describe('getMessagesSince / getChannelVersion message-id 契约（#319）', () => {
  let tmpDir: string;
  let store: FileStore;
  const CH = 'ch-since';

  beforeEach(async () => {
    tmpDir = createTempDir();
    store = new FileStore(tmpDir);
    await store.createChannel(makeChannel(CH));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('空频道 → lastMessageId 为 null；追加后指向最后一行（含 tombstone 行）', async () => {
    expect((await store.getChannelVersion(CH)).lastMessageId).toBeNull();

    await store.appendMessage(CH, makeMessage('m1', CH));
    expect((await store.getChannelVersion(CH)).lastMessageId).toBe('m1');

    await store.softDeleteMessage(CH, 'm1');
    // tombstone 是最后一行，版本必须反映它（否则删除不会被 §4.2 感知为「房间已变」）
    expect((await store.getChannelVersion(CH)).lastMessageId).toBe('m1');
  });

  it('锚点之后的活消息（过滤 tombstone，不含锚点本身）', async () => {
    await store.appendMessage(CH, makeMessage('m1', CH));
    await store.appendMessage(CH, makeMessage('m2', CH));
    await store.appendMessage(CH, makeMessage('m3', CH));
    await store.softDeleteMessage(CH, 'm3');
    await store.appendMessage(CH, makeMessage('m4', CH));

    const msgs = await store.getMessagesSince(CH, 'm1');
    expect(msgs.map(m => m.id)).toEqual(['m2', 'm4']);
    expect(msgs.every(m => !('deleted' in m))).toBe(true);
  });

  it('锚点为 null（空频道快照）→ 返回全部活消息', async () => {
    await store.appendMessage(CH, makeMessage('m1', CH));
    await store.appendMessage(CH, makeMessage('m2', CH));
    const msgs = await store.getMessagesSince(CH, null);
    expect(msgs.map(m => m.id)).toEqual(['m1', 'm2']);
  });

  it('锚点 id 已被压实抹除（tombstone 锚点）→ 保守返回全部活消息，绝不漏报', async () => {
    await store.appendMessage(CH, makeMessage('m0', CH)); // 全程存活
    await store.appendMessage(CH, makeMessage('m1', CH));
    await store.softDeleteMessage(CH, 'm1'); // tombstone 成最后一行，快照锚点 = m1
    const version = await store.getChannelVersion(CH);
    expect(version.lastMessageId).toBe('m1');
    await store.appendMessage(CH, makeMessage('m2', CH));

    // 压实抹掉 m1（原行 + tombstone），文件只剩 [m0, m2]
    const compacting = new FileStore(tmpDir, { messageCompaction: { checkInterval: 1, minLines: 2, deadRatio: 0 } });
    await compacting.appendMessage(CH, makeMessage('m3', CH));

    const msgs = await store.getMessagesSince(CH, version.lastMessageId);
    // 锚点位置不可知 → 全部活消息（含锚点之前的 m0），由消费方去重；反向漏报不允许
    expect(msgs.map(m => m.id)).toEqual(['m0', 'm2', 'm3']);
  });

  it('频道不存在 / 读取失败 → 空数组（不阻断发言语义保持）', async () => {
    expect(await store.getMessagesSince('ch-nonexistent', 'x')).toEqual([]);
  });
});

describe('queryMessagesPage 分页下沉 + id 游标（#319）', () => {
  let tmpDir: string;
  let store: FileStore;
  const CH = 'ch-page';

  /** 5 条消息，全部同一 createdAt（同毫秒撞车场景），靠 id 区分 */
  async function seedSameTimestamp() {
    const ts = new Date().toISOString();
    for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) {
      await store.appendMessage(CH, { ...makeMessage(id, CH), createdAt: ts });
    }
  }

  beforeEach(async () => {
    tmpDir = createTempDir();
    store = new FileStore(tmpDir);
    await store.createChannel(makeChannel(CH));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('无 before：返回最新 limit 条（升序），total/hasMore 正确', async () => {
    await seedSameTimestamp();
    const page = await store.queryMessagesPage(CH, { limit: 2 });
    expect(page.messages.map(m => m.id)).toEqual(['p4', 'p5']);
    expect(page.total).toBe(5);
    expect(page.hasMore).toBe(true);
  });

  it('before=<messageId>：锚点之前窗口（不含锚点），同毫秒消息不漏不重', async () => {
    await seedSameTimestamp();
    const page = await store.queryMessagesPage(CH, { before: 'p4', limit: 2 });
    expect(page.messages.map(m => m.id)).toEqual(['p2', 'p3']);
    expect(page.total).toBe(3); // 锚点过滤后的总数（与路由现状语义一致）
    expect(page.hasMore).toBe(true);

    const first = await store.queryMessagesPage(CH, { before: 'p2', limit: 2 });
    expect(first.messages.map(m => m.id)).toEqual(['p1']);
    expect(first.hasMore).toBe(false);
  });

  it('锚点 id 不存在（已删除/被压实抹除）→ 空页、hasMore=false，不整页错发', async () => {
    await seedSameTimestamp();
    const page = await store.queryMessagesPage(CH, { before: 'p-gone', limit: 2 });
    expect(page.messages).toEqual([]);
    expect(page.total).toBe(5);
    expect(page.hasMore).toBe(false);
  });

  it('limit 大于等于可用消息数 → 全量返回、hasMore=false', async () => {
    await seedSameTimestamp();
    const page = await store.queryMessagesPage(CH, { before: 'p3', limit: 50 });
    expect(page.messages.map(m => m.id)).toEqual(['p1', 'p2']);
    expect(page.hasMore).toBe(false);
  });
});
