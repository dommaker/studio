/**
 * AC-E1+E2: Convert to Task
 *
 * Contract tests for:
 * - E1: POST /channels/:id/messages/:messageId/convert-to-task
 * - E2: POST /channels/:id/messages/:messageId/convert-to-task/suggest
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';

// We'll import convert-to-task service once implemented
let ConvertToTaskService: typeof import('../convert-to-task.service.js').ConvertToTaskService;

describe('AC-E1+E2: Convert to Task', () => {
  const testChannelIds: string[] = [];
  const testMessageIds: string[] = [];
  const testWorkUnitIds: string[] = [];

  beforeAll(async () => {
    // Dynamic import (will fail until implemented)
    try {
      const mod = await import('../convert-to-task.service.js');
      ConvertToTaskService = mod.ConvertToTaskService;
    } catch {
      // Not yet implemented
    }
  });

  afterAll(async () => {
    await prisma.channelMessage.deleteMany({ where: { id: { in: testMessageIds } } });
    await prisma.workUnit.deleteMany({ where: { id: { in: testWorkUnitIds } } });
    await prisma.channel.deleteMany({ where: { id: { in: testChannelIds } } });
  });

  // ── AC-E1: Convert to Task API ──

  describe('AC-E1: Convert to Task API', () => {
    it('normal convert → WorkUnit created + message linked', async () => {
      const ch = await prisma.channel.create({ data: { name: `#e1-test-${Date.now()}` } });
      testChannelIds.push(ch.id);
      const msg = await prisma.channelMessage.create({
        data: { channelId: ch.id, content: 'Fix the login bug', authorType: 'human' },
      });
      testMessageIds.push(msg.id);

      const service = new ConvertToTaskService(prisma);
      const workUnit = await service.convert(ch.id, msg.id, {
        title: 'Fix login bug',
        description: 'Users cannot login with SSO',
      });
      testWorkUnitIds.push(workUnit.id);

      expect(workUnit).toBeDefined();
      expect(workUnit.scope).toBe('Fix login bug');
      expect(workUnit.channelId).toBe(ch.id);
      expect(workUnit.status).toBe('unassigned');

      // Message should now be linked
      const updatedMsg = await prisma.channelMessage.findUnique({ where: { id: msg.id } });
      expect(updatedMsg!.workUnitId).toBe(workUnit.id);
    });

    it('message already has workUnitId → 400', async () => {
      const ch = await prisma.channel.create({ data: { name: `#e1-dup-${Date.now()}` } });
      testChannelIds.push(ch.id);
      const existingWu = await prisma.workUnit.create({
        data: { scope: 'existing', channelId: ch.id, type: 'task', status: 'unassigned' },
      });
      testWorkUnitIds.push(existingWu.id);
      const msg = await prisma.channelMessage.create({
        data: { channelId: ch.id, content: 'already linked', authorType: 'human', workUnitId: existingWu.id },
      });
      testMessageIds.push(msg.id);

      const service = new ConvertToTaskService(prisma);
      await expect(service.convert(ch.id, msg.id, {})).rejects.toThrow(/already/i);
    });

    it('message not found → error', async () => {
      const ch = await prisma.channel.create({ data: { name: `#e1-404-${Date.now()}` } });
      testChannelIds.push(ch.id);

      const service = new ConvertToTaskService(prisma);
      await expect(service.convert(ch.id, 'nonexistent-msg-id', {})).rejects.toThrow(/not found/i);
    });

    it('convert makes message the anchor (workUnitId set, replyToId null)', async () => {
      const ch = await prisma.channel.create({ data: { name: `#e1-anchor-${Date.now()}` } });
      testChannelIds.push(ch.id);
      const msg = await prisma.channelMessage.create({
        data: { channelId: ch.id, content: 'anchor message', authorType: 'human' },
      });
      testMessageIds.push(msg.id);

      const service = new ConvertToTaskService(prisma);
      const workUnit = await service.convert(ch.id, msg.id, { title: 'Anchor task' });
      testWorkUnitIds.push(workUnit.id);

      const updatedMsg = await prisma.channelMessage.findUnique({ where: { id: msg.id } });
      expect(updatedMsg!.workUnitId).toBe(workUnit.id);
      expect(updatedMsg!.replyToId).toBeNull();
    });

    it('with assigneeId → WorkUnit.status = active', async () => {
      const ch = await prisma.channel.create({ data: { name: `#e1-assignee-${Date.now()}` } });
      testChannelIds.push(ch.id);
      const agent = await prisma.agentProfile.create({ data: { name: `e1-agent-${Date.now()}` } });
      const msg = await prisma.channelMessage.create({
        data: { channelId: ch.id, content: 'assign me', authorType: 'human' },
      });
      testMessageIds.push(msg.id);

      const service = new ConvertToTaskService(prisma);
      const workUnit = await service.convert(ch.id, msg.id, { assigneeId: agent.id });
      testWorkUnitIds.push(workUnit.id);

      expect(workUnit.assigneeId).toBe(agent.id);
      expect(workUnit.status).toBe('active');

      await prisma.agentProfile.delete({ where: { id: agent.id } });
    });

    it('without assigneeId → WorkUnit.status = unassigned', async () => {
      const ch = await prisma.channel.create({ data: { name: `#e1-noassign-${Date.now()}` } });
      testChannelIds.push(ch.id);
      const msg = await prisma.channelMessage.create({
        data: { channelId: ch.id, content: 'no assignee', authorType: 'human' },
      });
      testMessageIds.push(msg.id);

      const service = new ConvertToTaskService(prisma);
      const workUnit = await service.convert(ch.id, msg.id, {});
      testWorkUnitIds.push(workUnit.id);

      expect(workUnit.assigneeId).toBeNull();
      expect(workUnit.status).toBe('unassigned');
    });
  });

  // ── AC-E2: LLM 预填建议 ──

  describe('AC-E2: LLM suggest', () => {
    it('normal suggest → returns suggestion object', async () => {
      const service = new ConvertToTaskService(prisma);

      // Mock the LLM call
      const mockSuggest = vi.spyOn(service as unknown as Record<string, unknown>, 'callLLM' as never)
        .mockResolvedValue({ title: 'Fix bug', description: 'Login issue', suggestedAssigneeId: undefined, suggestedProjectPath: undefined });

      const result = await service.suggest('Please fix the login bug', [], []);
      expect(result).toBeDefined();
      expect(result.title).toBeDefined();

      mockSuggest.mockRestore();
    });

    it('empty message → returns empty suggestion', async () => {
      const service = new ConvertToTaskService(prisma);
      const result = await service.suggest('', [], []);
      expect(result).toEqual({});
    });

    it('LLM call failure → returns empty suggestion (non-blocking)', async () => {
      const service = new ConvertToTaskService(prisma);

      // Force LLM to fail by mocking fetch
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

      const result = await service.suggest('Some message content', [], []);
      expect(result).toEqual({});

      fetchSpy.mockRestore();
    });
  });
});
