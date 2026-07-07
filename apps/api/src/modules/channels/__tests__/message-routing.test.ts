// AC-B1-B4: Message routing contract tests
// RED phase — routeMessage function does not exist yet
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';
import { eventBus } from '@dommaker/studio-shared';
import { routeMessage, detectMention } from '../message-routing.js';

let channelId: string;

describe('Message Routing (AC-B1-B4)', () => {
  beforeAll(async () => {
    const channel = await prisma.channel.create({
      data: { name: `#test-routing-${Date.now()}`, type: 'rnd' },
    });
    channelId = channel.id;
  });

  afterAll(async () => {
    await prisma.channelMessage.deleteMany({ where: { channelId } });
    await prisma.workUnit.deleteMany({ where: { channelId } });
    await prisma.channel.delete({ where: { id: channelId } });
  });

  beforeEach(async () => {
    await prisma.channelMessage.deleteMany({ where: { channelId } });
    await prisma.workUnit.deleteMany({ where: { channelId } });
    await prisma.agentProfile.deleteMany({});
  });

  // ── AC-B1: @mention creates WorkUnit ──

  describe('AC-B1: @mention → WorkUnit', () => {
    it('creates WorkUnit when @mention matches active AgentProfile', async () => {
      await prisma.agentProfile.create({
        data: { name: 'TestAgent', description: 'test', status: 'active' },
      });

      const result = await routeMessage(channelId, '@TestAgent do this task');

      expect(result.workUnitId).toBeTruthy();
      const wu = await prisma.workUnit.findUnique({ where: { id: result.workUnitId! } });
      expect(wu).toBeTruthy();
      expect(wu!.scope).toBe('do this task');
      expect(wu!.channelId).toBe(channelId);
      expect(wu!.type).toBe('task');
      expect(wu!.status).toBe('unassigned');
      const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
      expect(meta.matched).toBe(true);
      expect(meta.mentionName).toBe('TestAgent');
    });

    it('creates WorkUnit with matched=false when Agent not found', async () => {
      const result = await routeMessage(channelId, '@UnknownAgent help me');

      expect(result.workUnitId).toBeTruthy();
      const wu = await prisma.workUnit.findUnique({ where: { id: result.workUnitId! } });
      const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
      expect(meta.matched).toBe(false);
    });

    it('scope strips @name prefix', async () => {
      const result = await routeMessage(channelId, '@Agent please analyze this code');

      const wu = await prisma.workUnit.findUnique({ where: { id: result.workUnitId! } });
      expect(wu!.scope).toBe('please analyze this code');
    });

    it('takes first @mention when multiple present', async () => {
      await prisma.agentProfile.create({
        data: { name: 'First', description: 'first', status: 'active' },
      });

      const result = await routeMessage(channelId, '@First and @Second both look at this');

      const wu = await prisma.workUnit.findUnique({ where: { id: result.workUnitId! } });
      const meta = wu!.metadata ? JSON.parse(wu!.metadata) : {};
      expect(meta.mentionName).toBe('First');
    });

    it('publishes workunit.created event', async () => {
      const events: Array<{ workunit: { id: string } }> = [];
      const handler = (payload: { workunit: { id: string } }) => events.push(payload);
      eventBus.subscribe('workunit.created', handler);

      await routeMessage(channelId, '@Someone do something');

      expect(events.length).toBe(1);
      eventBus.unsubscribe('workunit.created', handler);
    });

    it('associates workUnitId with ChannelMessage', async () => {
      const result = await routeMessage(channelId, '@Agent do this');

      const msg = await prisma.channelMessage.findUnique({ where: { id: result.id } });
      expect(msg!.workUnitId).toBe(result.workUnitId);
    });
  });

  // ── AC-B2: Thread reply inherits workUnitId ──

  describe('AC-B2: Thread reply inherits workUnitId', () => {
    it('inherits workUnitId from replied message', async () => {
      // Create original message with workUnitId
      const wu = await prisma.workUnit.create({
        data: { scope: 'original task', channelId, type: 'task', status: 'unassigned' },
      });
      const original = await prisma.channelMessage.create({
        data: { channelId, content: 'original', authorType: 'human', workUnitId: wu.id },
      });

      const reply = await routeMessage(channelId, 'follow up', original.id);

      expect(reply.workUnitId).toBe(wu.id);
      expect(reply.replyToId).toBe(original.id);
    });

    it('workUnitId=null when replied message has no workUnitId', async () => {
      const original = await prisma.channelMessage.create({
        data: { channelId, content: 'plain msg', authorType: 'human' },
      });

      const reply = await routeMessage(channelId, 'reply to plain', original.id);

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
      const wu = await prisma.workUnit.create({
        data: { scope: 'task', channelId, type: 'task', status: 'unassigned' },
      });
      const original = await prisma.channelMessage.create({
        data: { channelId, content: 'original', authorType: 'human', workUnitId: wu.id },
      });

      const wuCountBefore = await prisma.workUnit.count({ where: { channelId } });

      const reply = await routeMessage(channelId, '@Agent fix this', original.id);

      const wuCountAfter = await prisma.workUnit.count({ where: { channelId } });
      expect(wuCountAfter).toBe(wuCountBefore);
      expect(reply.workUnitId).toBe(wu.id); // inherited, not new
    });

    it('stores message with replyToId and inherited workUnitId', async () => {
      const wu = await prisma.workUnit.create({
        data: { scope: 'task', channelId, type: 'task', status: 'unassigned' },
      });
      const original = await prisma.channelMessage.create({
        data: { channelId, content: 'original', authorType: 'human', workUnitId: wu.id },
      });

      const reply = await routeMessage(channelId, '@Agent please fix', original.id);

      expect(reply.replyToId).toBe(original.id);
      expect(reply.workUnitId).toBe(wu.id);
    });
  });

  // ── AC-B4: Routing priority ──

  describe('AC-B4: Message routing priority', () => {
    it('plain text → no WorkUnit', async () => {
      const result = await routeMessage(channelId, 'just a message');

      expect(result.workUnitId).toBeNull();
    });

    it('@mention without replyToId → WorkUnit created', async () => {
      const result = await routeMessage(channelId, '@Someone help');

      expect(result.workUnitId).toBeTruthy();
    });

    it('replyToId without @mention → no new WorkUnit, inherits', async () => {
      const wu = await prisma.workUnit.create({
        data: { scope: 'task', channelId, type: 'task', status: 'unassigned' },
      });
      const original = await prisma.channelMessage.create({
        data: { channelId, content: 'original', authorType: 'human', workUnitId: wu.id },
      });

      const reply = await routeMessage(channelId, 'follow up', original.id);

      expect(reply.workUnitId).toBe(wu.id);
    });

    it('replyToId + @mention → replyToId wins, no new WorkUnit', async () => {
      const wu = await prisma.workUnit.create({
        data: { scope: 'task', channelId, type: 'task', status: 'unassigned' },
      });
      const original = await prisma.channelMessage.create({
        data: { channelId, content: 'original', authorType: 'human', workUnitId: wu.id },
      });

      const wuCountBefore = await prisma.workUnit.count({ where: { channelId } });
      const reply = await routeMessage(channelId, '@Agent feedback', original.id);
      const wuCountAfter = await prisma.workUnit.count({ where: { channelId } });

      expect(wuCountAfter).toBe(wuCountBefore);
      expect(reply.workUnitId).toBe(wu.id);
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
  });
});
