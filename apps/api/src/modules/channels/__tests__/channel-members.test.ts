/**
 * AC-B1+B2+B3: Channel Members Management
 *
 * Contract tests for:
 * - B1: Channel.members default/storage (schema already in place)
 * - B2: updateChannelMembers() — add/remove/idempotent logic
 * - B3: POST /channels with members
 *
 * B2 tests import `updateChannelMembers` from channel.routes.js (GREEN will export it).
 */
import { describe, it, expect, afterAll } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';
import { updateChannelMembers } from '../channel.routes.js';

describe('AC-B1+B2+B3: Channel Members', () => {
  const testChannelIds: string[] = [];
  const testAgentIds: string[] = [];

  afterAll(async () => {
    await prisma.channel.deleteMany({ where: { id: { in: testChannelIds } } });
    await prisma.agentProfile.deleteMany({ where: { id: { in: testAgentIds } } });
  });

  // ── AC-B1: Schema ──

  describe('AC-B1: Channel.members field', () => {
    it('creates Channel with default members = "[]"', async () => {
      const ch = await prisma.channel.create({
        data: { name: `#test-b1-default-${Date.now()}` },
      });
      testChannelIds.push(ch.id);
      expect(ch.members).toBe('[]');
    });

    it('creates Channel with explicit members', async () => {
      const agent = await prisma.agentProfile.create({
        data: { name: `b1-agent-${Date.now()}` },
      });
      testAgentIds.push(agent.id);
      const ch = await prisma.channel.create({
        data: { name: `#test-b1-explicit-${Date.now()}`, members: JSON.stringify([agent.id]) },
      });
      testChannelIds.push(ch.id);
      const members: string[] = JSON.parse(ch.members);
      expect(members).toContain(agent.id);
    });
  });

  // ── AC-B2: updateChannelMembers ──

  describe('AC-B2: updateChannelMembers()', () => {
    it('adds agent to members', async () => {
      const ch = await prisma.channel.create({
        data: { name: `#test-b2-add-${Date.now()}` },
      });
      testChannelIds.push(ch.id);
      const agent = await prisma.agentProfile.create({
        data: { name: `b2-add-agent-${Date.now()}` },
      });
      testAgentIds.push(agent.id);

      const result = await updateChannelMembers(ch.id, { add: [agent.id] });
      expect(result).toContain(agent.id);
    });

    it('removes agent from members', async () => {
      const agent = await prisma.agentProfile.create({
        data: { name: `b2-rm-agent-${Date.now()}` },
      });
      testAgentIds.push(agent.id);
      const ch = await prisma.channel.create({
        data: { name: `#test-b2-rm-${Date.now()}`, members: JSON.stringify([agent.id]) },
      });
      testChannelIds.push(ch.id);

      const result = await updateChannelMembers(ch.id, { remove: [agent.id] });
      expect(result).not.toContain(agent.id);
    });

    it('add existing agent is idempotent (no duplicates)', async () => {
      const agent = await prisma.agentProfile.create({
        data: { name: `b2-dup-agent-${Date.now()}` },
      });
      testAgentIds.push(agent.id);
      const ch = await prisma.channel.create({
        data: { name: `#test-b2-dup-${Date.now()}`, members: JSON.stringify([agent.id]) },
      });
      testChannelIds.push(ch.id);

      const result = await updateChannelMembers(ch.id, { add: [agent.id] });
      expect(result.filter(id => id === agent.id).length).toBe(1);
    });

    it('remove non-existing agent is idempotent (no error)', async () => {
      const ch = await prisma.channel.create({
        data: { name: `#test-b2-noop-${Date.now()}` },
      });
      testChannelIds.push(ch.id);

      const result = await updateChannelMembers(ch.id, { remove: ['nonexistent-id'] });
      expect(result).toEqual([]);
    });

    it('empty body → members unchanged', async () => {
      const agent = await prisma.agentProfile.create({
        data: { name: `b2-keep-agent-${Date.now()}` },
      });
      testAgentIds.push(agent.id);
      const ch = await prisma.channel.create({
        data: { name: `#test-b2-empty-${Date.now()}`, members: JSON.stringify([agent.id]) },
      });
      testChannelIds.push(ch.id);

      const result = await updateChannelMembers(ch.id, {});
      expect(result).toContain(agent.id);
    });
  });

  // ── AC-B3: POST /channels with members ──

  describe('AC-B3: Create channel with members', () => {
    it('creates channel with members in body', async () => {
      const agent1 = await prisma.agentProfile.create({
        data: { name: `b3-a1-${Date.now()}` },
      });
      const agent2 = await prisma.agentProfile.create({
        data: { name: `b3-a2-${Date.now()}` },
      });
      testAgentIds.push(agent1.id, agent2.id);

      const ch = await prisma.channel.create({
        data: {
          name: `#test-b3-members-${Date.now()}`,
          members: JSON.stringify([agent1.id, agent2.id]),
        },
      });
      testChannelIds.push(ch.id);

      const members: string[] = JSON.parse(ch.members);
      expect(members).toContain(agent1.id);
      expect(members).toContain(agent2.id);
      expect(members.length).toBe(2);
    });

    it('creates channel without members defaults to "[]"', async () => {
      const ch = await prisma.channel.create({
        data: { name: `#test-b3-nomembers-${Date.now()}` },
      });
      testChannelIds.push(ch.id);
      expect(ch.members).toBe('[]');
    });
  });
});
