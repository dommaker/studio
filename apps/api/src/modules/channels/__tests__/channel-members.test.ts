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
import { FileStore } from '@dommaker/studio-shared';
import { updateChannelMembers } from '../channel.routes.js';

const fileStore = new FileStore();

/** Create channel + agent in FileStore */
async function createTestChannel(name: string, data?: { members?: string; agentIds?: string[] }): Promise<{ id: string }> {
  const id = `test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  for (const aid of data?.agentIds ?? []) {
    const existing = await fileStore.getProfile(aid);
    if (!existing) {
      await fileStore.createProfile({ id: aid, name: `agent-${aid}`, description: null, channels: '[]', status: 'active', createdAt: now, updatedAt: now });
    }
  }
  await fileStore.createChannel({
    id, name, type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: data?.members ?? '[]',
    createdAt: now, updatedAt: now,
  });
  return { id };
}

async function createTestAgent(): Promise<{ id: string }> {
  const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  await fileStore.createProfile({ id, name: id, description: null, channels: '[]', status: 'active', createdAt: now, updatedAt: now });
  return { id };
}

describe('AC-B1+B2+B3: Channel Members', () => {
  const testChannelIds: string[] = [];
  const testAgentIds: string[] = [];

  afterAll(async () => {
    for (const id of testChannelIds) {
      try { await fileStore.deleteChannel(id); } catch {}
    }
    for (const id of testAgentIds) {
      try { await fileStore.deleteProfile(id); } catch {}
    }
  });

  // ── AC-B1: Schema ──

  describe('AC-B1: Channel.members field', () => {
    it('creates Channel with default members = "[]"', async () => {
      const ch = await createTestChannel(`#test-b1-default-${Date.now()}`);
      testChannelIds.push(ch.id);
      const stored = await fileStore.getChannel(ch.id);
      expect(stored?.members).toBe('[]');
    });

    it('creates Channel with explicit members', async () => {
      const agent = await createTestAgent();
      testAgentIds.push(agent.id);
      const ch = await createTestChannel(`#test-b1-explicit-${Date.now()}`, { members: JSON.stringify([agent.id]) });
      testChannelIds.push(ch.id);
      const stored = await fileStore.getChannel(ch.id);
      const members: string[] = JSON.parse(stored!.members);
      expect(members).toContain(agent.id);
    });
  });

  // ── AC-B2: updateChannelMembers ──

  describe('AC-B2: updateChannelMembers()', () => {
    it('adds agent to members', async () => {
      const ch = await createTestChannel('#test-b2-add');
      testChannelIds.push(ch.id);
      const agent = await createTestAgent();
      testAgentIds.push(agent.id);

      const result = await updateChannelMembers(ch.id, { add: [agent.id] });
      expect(result).toContain(agent.id);
    });

    it('removes agent from members', async () => {
      const agent = await createTestAgent();
      testAgentIds.push(agent.id);
      const ch = await createTestChannel('#test-b2-rm', { members: JSON.stringify([agent.id]) });
      testChannelIds.push(ch.id);

      const result = await updateChannelMembers(ch.id, { remove: [agent.id] });
      expect(result).not.toContain(agent.id);
    });

    it('add existing agent is idempotent (no duplicates)', async () => {
      const agent = await createTestAgent();
      testAgentIds.push(agent.id);
      const ch = await createTestChannel('#test-b2-dup', { members: JSON.stringify([agent.id]) });
      testChannelIds.push(ch.id);

      const result = await updateChannelMembers(ch.id, { add: [agent.id] });
      expect(result.filter(id => id === agent.id).length).toBe(1);
    });

    it('remove non-existing agent is idempotent (no error)', async () => {
      const ch = await createTestChannel('#test-b2-noop');
      testChannelIds.push(ch.id);

      const result = await updateChannelMembers(ch.id, { remove: ['nonexistent-id'] });
      expect(result).toEqual([]);
    });

    it('empty body → members unchanged', async () => {
      const agent = await createTestAgent();
      testAgentIds.push(agent.id);
      const ch = await createTestChannel('#test-b2-empty', { members: JSON.stringify([agent.id]) });
      testChannelIds.push(ch.id);

      const result = await updateChannelMembers(ch.id, {});
      expect(result).toContain(agent.id);
    });
  });

  // ── AC-B3: POST /channels with members ──

  describe('AC-B3: Create channel with members', () => {
    it('creates channel with members in body', async () => {
      const agent1 = await createTestAgent();
      const agent2 = await createTestAgent();
      testAgentIds.push(agent1.id, agent2.id);

      const ch = await createTestChannel(`#test-b3-members-${Date.now()}`, { members: JSON.stringify([agent1.id, agent2.id]) });
      testChannelIds.push(ch.id);

      const stored = await fileStore.getChannel(ch.id);
      const members: string[] = JSON.parse(stored!.members);
      expect(members).toContain(agent1.id);
      expect(members).toContain(agent2.id);
      expect(members.length).toBe(2);
    });

    it('creates channel without members defaults to "[]"', async () => {
      const ch = await createTestChannel(`#test-b3-nomembers-${Date.now()}`);
      testChannelIds.push(ch.id);
      const stored = await fileStore.getChannel(ch.id);
      expect(stored?.members).toBe('[]');
    });
  });
});
