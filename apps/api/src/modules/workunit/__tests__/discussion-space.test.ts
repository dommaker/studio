// Discussion Space service test (AS-025 §5.16)
// Tests: ChannelMessage.workUnitId grouping — list/create/patch
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';
import { channelMessageService } from '../../channels/channel-message.service.js';

let channelId: string;

describe('Discussion Space (ChannelMessage.workUnitId)', () => {
  const cleanupIds: string[] = [];

  beforeAll(async () => {
    const channel = await prisma.channel.create({
      data: { name: `#test-discussion-${Date.now()}`, type: 'rnd' },
    });
    channelId = channel.id;
  });

  afterAll(async () => {
    await prisma.channelMessage.deleteMany({ where: { channelId } });
    await prisma.channel.deleteMany({ where: { id: channelId } });
  });

  beforeEach(async () => {
    await prisma.channelMessage.deleteMany({ where: { channelId } });
  });

  // ── createMessage with workUnitId ──

  describe('createMessage with workUnitId', () => {
    it('AC1: human message with workUnitId stores association', async () => {
      const msg = await channelMessageService.createHumanMessage(
        channelId, 'Discuss this task', undefined, 'wu-1',
      );
      cleanupIds.push(msg.id);

      expect(msg.workUnitId).toBe('wu-1');
    });

    it('AC1: agent message with workUnitId stores association', async () => {
      const msg = await channelMessageService.createAgentMessage(
        channelId, 'Executor', 'Working on it',
        { workUnitId: 'wu-2' },
      );
      cleanupIds.push(msg.id);

      expect(msg.workUnitId).toBe('wu-2');
    });

    it('AC1: message without workUnitId has null workUnitId', async () => {
      const msg = await channelMessageService.createHumanMessage(
        channelId, 'General chat',
      );
      cleanupIds.push(msg.id);

      expect(msg.workUnitId).toBeNull();
    });
  });

  // ── listByWorkUnitId ──

  describe('listByWorkUnitId', () => {
    it('AC2: returns only messages matching workUnitId', async () => {
      // Create 3 messages: 2 for wu-A, 1 for wu-B
      const m1 = await channelMessageService.createHumanMessage(
        channelId, 'msg1', undefined, 'wu-A',
      );
      const m2 = await channelMessageService.createAgentMessage(
        channelId, 'Executor', 'msg2', { workUnitId: 'wu-A' },
      );
      const m3 = await channelMessageService.createHumanMessage(
        channelId, 'msg3', undefined, 'wu-B',
      );
      cleanupIds.push(m1.id, m2.id, m3.id);

      const result = await channelMessageService.listByWorkUnitId('wu-A');

      expect(result.data).toHaveLength(2);
      expect(result.data.every(m => m.workUnitId === 'wu-A')).toBe(true);
      expect(result.total).toBe(2);
    });

    it('AC2: excludes messages with null workUnitId', async () => {
      const m1 = await channelMessageService.createHumanMessage(
        channelId, 'no wu',
      );
      const m2 = await channelMessageService.createHumanMessage(
        channelId, 'has wu', undefined, 'wu-X',
      );
      cleanupIds.push(m1.id, m2.id);

      const result = await channelMessageService.listByWorkUnitId('wu-X');

      expect(result.data).toHaveLength(1);
      expect(result.data[0].id).toBe(m2.id);
    });

    it('AC2: returns empty array for unknown workUnitId', async () => {
      const result = await channelMessageService.listByWorkUnitId('wu-nonexistent');

      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('AC2: orders by createdAt ascending (chronological)', async () => {
      const m1 = await channelMessageService.createHumanMessage(
        channelId, 'first', undefined, 'wu-ord',
      );
      // Small delay to ensure different timestamps
      await new Promise(r => setTimeout(r, 10));
      const m2 = await channelMessageService.createHumanMessage(
        channelId, 'second', undefined, 'wu-ord',
      );
      cleanupIds.push(m1.id, m2.id);

      const result = await channelMessageService.listByWorkUnitId('wu-ord');

      expect(result.data).toHaveLength(2);
      expect(result.data[0].content).toBe('first');
      expect(result.data[1].content).toBe('second');
    });
  });

  // ── updateMessage content ──

  describe('updateMessage for discussion', () => {
    it('AC3: updates content of message with workUnitId', async () => {
      const msg = await channelMessageService.createHumanMessage(
        channelId, 'Original', undefined, 'wu-edit',
      );
      cleanupIds.push(msg.id);

      const updated = await channelMessageService.updateMessage(msg.id, {
        content: 'Edited content',
      });

      expect(updated.content).toBe('Edited content');
      expect(updated.workUnitId).toBe('wu-edit');
    });
  });
});
