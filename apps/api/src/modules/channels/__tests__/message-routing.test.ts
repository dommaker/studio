// AC-B1-B4: Message routing contract tests
// RED phase — routeMessage function does not exist yet
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { eventBus, FileStore, type AgentProfileData, type ChannelMessageData } from '@dommaker/studio-shared';
import { routeMessage, detectMention } from '../message-routing.js';
import { channelMessageService } from '../channel-message.service.js';
import { WorkUnitService } from '../../workunit/workunit.service.js';

let channelId: string;
let tmpDir: string;
let fileStore: FileStore;
let workUnitService: WorkUnitService;

/** 从 FileStore 中按 id 查找 WorkUnit snapshot */
async function findWu(id: string): Promise<import('@dommaker/studio-shared').WorkUnitSnapshot | null> {
  const snapshots = await fileStore.getIndex();
  return snapshots.find(s => s.id === id) ?? null;
}

/** 统计 FileStore 中某个 channelId 的 WorkUnit 数量 */
async function countWu(channelId: string): Promise<number> {
  return (await fileStore.getIndex()).filter(s => s.channelId === channelId).length;
}

function createTestAgent(store: FileStore, name: string, status = 'active', overrides?: Partial<AgentProfileData>): Promise<void> {
  const now = new Date().toISOString();
  return store.createProfile({
    id: `test-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name,
    description: `test agent ${name}`,
    channels: '[]',
    status,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
}

describe('Message Routing (AC-B1-B4)', () => {
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-routing-test-'));
    fileStore = new FileStore(tmpDir);
    channelId = `test-routing-${Date.now()}`;
    // Create channel config in FileStore for message routing
    await fileStore.createChannel({
      id: channelId, name: `#test-routing-${Date.now()}`, type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    // 让 singleton service 使用测试 FileStore
    channelMessageService.setFileStore(fileStore);
  });

  afterAll(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    // Clean up FileStore — recreate dir
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    fileStore = new FileStore(tmpDir);
    workUnitService = new WorkUnitService(fileStore);
    // Re-create channel config + re-inject into singleton
    await fileStore.createChannel({
      id: channelId, name: `#test-routing`, type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    channelMessageService.setFileStore(fileStore);
  });

  // ── AC-A1: @mention binds assigneeId ──

  describe('AC-A1: @mention → assigneeId binding', () => {
    it('sets assigneeId when @mention matches active AgentProfile', async () => {
      const agentData = {
        id: 'assign-agent-1',
        name: 'AssignAgent',
        description: 'assignable',
        channels: '[]',
        status: 'active' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await fileStore.createProfile(agentData);

      const result = await routeMessage(channelId, '@AssignAgent do this', undefined, fileStore);

      const wu = await findWu(result.workUnitId!);
      expect(wu!.assigneeId).toBe(agentData.id);
    });

    it('sets assigneeId=null when @mention does not match any Agent', async () => {
      const result = await routeMessage(channelId, '@Nobody help me', undefined, fileStore);

      const wu = await findWu(result.workUnitId!);
      expect(wu!.assigneeId).toBeNull();
    });

    it('sets assigneeId=null when @mention matches inactive Agent', async () => {
      await createTestAgent(fileStore, 'InactiveAgent', 'inactive');

      const result = await routeMessage(channelId, '@InactiveAgent do this', undefined, fileStore);

      const wu = await findWu(result.workUnitId!);
      expect(wu!.assigneeId).toBeNull();
    });

    it('still binds assigneeId when agent is active but has existing WorkUnit', async () => {
      const agentData = {
        id: 'busy-agent-1',
        name: 'BusyAgent',
        description: 'busy',
        channels: '[]',
        status: 'active' as const,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await fileStore.createProfile(agentData);
      // Pre-create a WorkUnit for this agent (simulating busy state)
      await workUnitService.create({ scope: 'existing task', channelId, type: 'task', status: 'active', assigneeId: agentData.id });

      const result = await routeMessage(channelId, '@BusyAgent new task', undefined, fileStore);

      const wu = await findWu(result.workUnitId!);
      expect(wu!.assigneeId).toBe(agentData.id);
    });
  });

  // ── AC-B1: @mention creates WorkUnit ──

  describe('AC-B1: @mention → WorkUnit', () => {
    it('creates WorkUnit when @mention matches active AgentProfile', async () => {
      await createTestAgent(fileStore, 'TestAgent');

      const result = await routeMessage(channelId, '@TestAgent do this task', undefined, fileStore);

      expect(result.workUnitId).toBeTruthy();
      const wu = await findWu(result.workUnitId!);
      expect(wu).toBeTruthy();
      expect(wu!.scope).toBe('do this task');
      expect(wu!.channelId).toBe(channelId);
      expect(wu!.type).toBe('task');
      // B3a 归属链（决策 D2）：测试频道无默认工程、无显式/需求归属
      // → WU 立即 NEED_INPUT 挂起（blocked），等人回复工程名/路径
      expect(wu!.status).toBe('blocked');
      const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
      expect(meta.matched).toBe(true);
      expect(meta.mentionName).toBe('TestAgent');
      expect(meta.waitingForInput).toBe(true);
      expect(meta.waitingReason).toBe('ownership');
    });

    it('creates WorkUnit with matched=false when Agent not found', async () => {
      const result = await routeMessage(channelId, '@UnknownAgent help me', undefined, fileStore);

      expect(result.workUnitId).toBeTruthy();
      const wu = await findWu(result.workUnitId!);
      const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
      expect(meta.matched).toBe(false);
    });

    it('scope strips @name prefix', async () => {
      const result = await routeMessage(channelId, '@Agent please analyze this code', undefined, fileStore);

      const wu = await findWu(result.workUnitId!);
      expect(wu!.scope).toBe('please analyze this code');
    });

    it('takes first @mention when multiple present', async () => {
      await createTestAgent(fileStore, 'First');

      const result = await routeMessage(channelId, '@First and @Second both look at this', undefined, fileStore);

      const wu = await findWu(result.workUnitId!);
      const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
      expect(meta.mentionName).toBe('First');
    });

    it('publishes workunit.created event', async () => {
      const events: Array<{ workunit: { id: string } }> = [];
      const handler = (payload: { workunit: { id: string } }) => events.push(payload);
      eventBus.subscribe('workunit.created', handler);

      await routeMessage(channelId, '@Someone do something', undefined, fileStore);

      expect(events.length).toBe(1);
      eventBus.unsubscribe('workunit.created', handler);
    });

    it('associates workUnitId with ChannelMessage', async () => {
      const result = await routeMessage(channelId, '@Agent do this', undefined, fileStore);

      const found = await fileStore.getMessageById(result.id);
      expect(found).not.toBeNull();
      expect(found!.message.workUnitId).toBe(result.workUnitId);
    });
  });

  // ── AC-B2: Thread reply inherits workUnitId ──

  describe('AC-B2: Thread reply inherits workUnitId', () => {
    it('inherits workUnitId from replied message', async () => {
      // Create original message with workUnitId via FileStore
      const wu = await workUnitService.create({ scope: 'original task', channelId, type: 'task', status: 'unassigned' });
      const now = new Date().toISOString();
      const original: ChannelMessageData = {
        id: uuidv4(), channelId, authorType: 'human', agentName: null,
        content: 'original', replyToId: null, meta: '{}', workUnitId: wu.id, createdAt: now,
      };
      await fileStore.appendMessage(channelId, original);

      const reply = await routeMessage(channelId, 'follow up', original.id, fileStore);

      expect(reply.workUnitId).toBe(wu.id);
      expect(reply.replyToId).toBe(original.id);
    });

    it('workUnitId=null when replied message has no workUnitId', async () => {
      const now = new Date().toISOString();
      const original: ChannelMessageData = {
        id: uuidv4(), channelId, authorType: 'human', agentName: null,
        content: 'plain msg', replyToId: null, meta: '{}', workUnitId: null, createdAt: now,
      };
      await fileStore.appendMessage(channelId, original);

      const reply = await routeMessage(channelId, 'reply to plain', original.id, fileStore);

      expect(reply.workUnitId).toBeNull();
    });

    it('throws when replyToId points to non-existent message', async () => {
      await expect(
        routeMessage(channelId, 'reply to nothing', 'non-existent-id'),
      ).rejects.toThrow();
    });
  });

  // ── AC-B3: Thread @mention = feedback, no new WorkUnit ──

  describe('AC-B3: Thread @mention does not create new WorkUnit', () => {
    it('does not create WorkUnit when replyToId present + @mention', async () => {
      const wu = await workUnitService.create({ scope: 'task', channelId, type: 'task', status: 'unassigned' });
      const now = new Date().toISOString();
      const original: ChannelMessageData = {
        id: uuidv4(), channelId, authorType: 'human', agentName: null,
        content: 'original', replyToId: null, meta: '{}', workUnitId: wu.id, createdAt: now,
      };
      await fileStore.appendMessage(channelId, original);

      const wuCountBefore = await countWu(channelId);

      const reply = await routeMessage(channelId, '@Agent fix this', original.id, fileStore);

      const wuCountAfter = await countWu(channelId);
      expect(wuCountAfter).toBe(wuCountBefore);
      expect(reply.workUnitId).toBe(wu.id); // inherited, not new
    });

    it('stores message with replyToId and inherited workUnitId', async () => {
      const wu = await workUnitService.create({ scope: 'task', channelId, type: 'task', status: 'unassigned' });
      const now = new Date().toISOString();
      const original: ChannelMessageData = {
        id: uuidv4(), channelId, authorType: 'human', agentName: null,
        content: 'original', replyToId: null, meta: '{}', workUnitId: wu.id, createdAt: now,
      };
      await fileStore.appendMessage(channelId, original);

      const reply = await routeMessage(channelId, '@Agent please fix', original.id, fileStore);

      expect(reply.replyToId).toBe(original.id);
      expect(reply.workUnitId).toBe(wu.id);
    });
  });

  // ── AC-B4: Message routing priority ──

  describe('AC-B4: Message routing priority', () => {
    it('plain text → no WorkUnit', async () => {
      const result = await routeMessage(channelId, 'just a message', undefined, fileStore);

      expect(result.workUnitId).toBeNull();
    });

    it('@mention without replyToId → WorkUnit created', async () => {
      const result = await routeMessage(channelId, '@Someone help', undefined, fileStore);

      expect(result.workUnitId).toBeTruthy();
    });

    it('replyToId without @mention → no new WorkUnit, inherits', async () => {
      const wu = await workUnitService.create({ scope: 'task', channelId, type: 'task', status: 'unassigned' });
      const now = new Date().toISOString();
      const original: ChannelMessageData = {
        id: uuidv4(), channelId, authorType: 'human', agentName: null,
        content: 'original', replyToId: null, meta: '{}', workUnitId: wu.id, createdAt: now,
      };
      await fileStore.appendMessage(channelId, original);

      const reply = await routeMessage(channelId, 'follow up', original.id, fileStore);

      expect(reply.workUnitId).toBe(wu.id);
    });

    it('replyToId + @mention → replyToId wins, no new WorkUnit', async () => {
      const wu = await workUnitService.create({ scope: 'task', channelId, type: 'task', status: 'unassigned' });
      const now = new Date().toISOString();
      const original: ChannelMessageData = {
        id: uuidv4(), channelId, authorType: 'human', agentName: null,
        content: 'original', replyToId: null, meta: '{}', workUnitId: wu.id, createdAt: now,
      };
      await fileStore.appendMessage(channelId, original);

      const wuCountBefore = await countWu(channelId);
      const reply = await routeMessage(channelId, '@Agent feedback', original.id, fileStore);
      const wuCountAfter = await countWu(channelId);

      expect(wuCountAfter).toBe(wuCountBefore);
      expect(reply.workUnitId).toBe(wu.id);
    });
  });

  // ── 决策 12: 无 @ 兜底 —— 频道默认角色 ──

  describe('决策 12: channel.defaultProfileId 无 @ 兜底', () => {
    it('配置了默认角色 → 无 @ 消息创建 WU 并关联消息', async () => {
      await fileStore.updateChannel(channelId, { defaultProfileId: 'default-agent-1' });

      const result = await routeMessage(channelId, '没有点名的消息', undefined, fileStore);

      expect(result.workUnitId).toBeTruthy();
      const wu = await findWu(result.workUnitId!);
      expect(wu).not.toBeNull();
      expect(wu!.assigneeId).toBe('default-agent-1');
      expect(wu!.type).toBe('task');
      expect(wu!.scope).toBe('没有点名的消息');
      expect(wu!.status).toBe('unassigned');
      const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
      expect(meta.creationMode).toBe('channel-default');
    });

    it('未配置默认角色 → 维持纯存储（不建 WU）', async () => {
      const result = await routeMessage(channelId, '纯聊天', undefined, fileStore);

      expect(result.workUnitId).toBeNull();
      expect(await countWu(channelId)).toBe(0);
    });
  });

  // ── F5: 回复挂起中的 WorkUnit → 恢复执行 ──

  describe('F5: reply to waiting WorkUnit resumes it', () => {
    /** 创建挂起（blocked + waitingForInput）的 WorkUnit 及 anchor 消息 */
    async function setupParkedWorkUnit() {
      const wu = await workUnitService.create({
        scope: '实现登录功能', channelId, type: 'task', status: 'active', assigneeId: 'instance-1',
      });
      await workUnitService.transitionStatus(wu.id, 'blocked');
      await workUnitService.update(wu.id, {
        metadata: {
          waitingForInput: true,
          waitingQuestion: '使用 OAuth 还是账号密码？',
          waitingSince: new Date().toISOString(),
          waitingReminded: false,
        },
      });
      const anchor: ChannelMessageData = {
        id: uuidv4(), channelId, authorType: 'agent', agentName: 'f5-agent',
        content: '需要输入: 使用 OAuth 还是账号密码？', replyToId: null, meta: '{}',
        workUnitId: wu.id, createdAt: new Date().toISOString(),
      };
      await fileStore.appendMessage(channelId, anchor);
      return { wu, anchor };
    }

    it('human thread reply → WorkUnit un-parks (blocked → active) with reply in pendingReplies', async () => {
      const { wu, anchor } = await setupParkedWorkUnit();

      const reply = await routeMessage(channelId, '用 OAuth', anchor.id, fileStore);

      expect(reply.workUnitId).toBe(wu.id);
      const after = await findWu(wu.id);
      expect(after!.status).toBe('active');
      const meta = after!.metadata ? JSON.parse(after!.metadata) : {};
      expect(meta.waitingForInput).toBe(false);
      expect(meta.pendingReplies).toEqual(['用 OAuth']);
    });

    it('reply to non-waiting blocked WorkUnit → status untouched', async () => {
      const wu = await workUnitService.create({
        scope: '卡住的任务', channelId, type: 'task', status: 'active', assigneeId: 'instance-1',
      });
      await workUnitService.transitionStatus(wu.id, 'blocked'); // 卡住型 blocked（无 waitingForInput）
      const anchor: ChannelMessageData = {
        id: uuidv4(), channelId, authorType: 'agent', agentName: 'f5-agent',
        content: '连续 3 步无进展', replyToId: null, meta: '{}',
        workUnitId: wu.id, createdAt: new Date().toISOString(),
      };
      await fileStore.appendMessage(channelId, anchor);

      await routeMessage(channelId, '看看情况', anchor.id, fileStore);

      expect((await findWu(wu.id))!.status).toBe('blocked');
    });
  });

  // ── detectMention utility ──

  describe('detectMention', () => {
    it('extracts @name from content', () => {
      expect(detectMention('@Agent do this')).toBe('Agent');
    });

    it('returns null when no @mention', () => {
      expect(detectMention('plain text')).toBeNull();
    });

    it('extracts first @name when multiple', () => {
      expect(detectMention('@First and @Second')).toBe('First');
    });

    it('supports hyphens and underscores in names', () => {
      expect(detectMention('@my-agent do this')).toBe('my-agent');
      expect(detectMention('@my_agent do this')).toBe('my_agent');
    });

    it('supports Unicode (CJK) names', () => {
      expect(detectMention('@开发 你好')).toBe('开发');
      expect(detectMention('@测试')).toBe('测试');
      expect(detectMention('@开发 test')).toBe('开发');
    });
  });

  // ── §9.5: mention 匹配以 channel.members 为界 ──

  describe('§9.5: mention matching scoped to channel members', () => {
    function activeProfile(id: string, name: string): AgentProfileData {
      return {
        id, name, description: `test agent ${name}`,
        channels: '[]', status: 'active', provider: null,
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      };
    }

    it('matches when the named profile IS a channel member', async () => {
      const agent = activeProfile('member-agent-1', 'MemberAgent');
      await fileStore.createProfile(agent);
      await fileStore.updateChannel(channelId, { members: JSON.stringify([agent.id]) });

      const result = await routeMessage(channelId, '@MemberAgent do this', undefined, fileStore);

      const wu = await findWu(result.workUnitId!);
      expect(wu!.assigneeId).toBe(agent.id);
      const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
      expect(meta.matched).toBe(true);
    });

    it('treats active but NON-member profile as no-match (assigneeId null, WorkUnit still created)', async () => {
      const outsider = activeProfile('outsider-agent-1', 'OutsiderAgent');
      await fileStore.createProfile(outsider);
      // 频道有 members，但不含 OutsiderAgent
      await fileStore.updateChannel(channelId, { members: JSON.stringify(['some-other-profile']) });

      const result = await routeMessage(channelId, '@OutsiderAgent do this', undefined, fileStore);

      expect(result.workUnitId).toBeTruthy(); // WorkUnit 创建行为不变
      const wu = await findWu(result.workUnitId!);
      expect(wu!.assigneeId).toBeNull();
      const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
      expect(meta.matched).toBe(false);
    });

    it('falls back to matching any active profile when channel members is empty', async () => {
      const agent = activeProfile('legacy-agent-1', 'LegacyAgent');
      await fileStore.createProfile(agent);
      await fileStore.updateChannel(channelId, { members: '[]' }); // 历史频道：members 未回填

      const result = await routeMessage(channelId, '@LegacyAgent do this', undefined, fileStore);

      const wu = await findWu(result.workUnitId!);
      expect(wu!.assigneeId).toBe(agent.id);
    });

    it('matches a CJK-named member and strips the mention from scope', async () => {
      const agent = activeProfile('cjk-agent-1', '开发');
      await fileStore.createProfile(agent);
      await fileStore.updateChannel(channelId, { members: JSON.stringify([agent.id]) });

      const result = await routeMessage(channelId, '@开发 看一下这个问题', undefined, fileStore);

      const wu = await findWu(result.workUnitId!);
      expect(wu!.assigneeId).toBe(agent.id);
      expect(wu!.scope).toBe('看一下这个问题');
      const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
      expect(meta.matched).toBe(true);
      expect(meta.mentionName).toBe('开发');
    });
  });
});
