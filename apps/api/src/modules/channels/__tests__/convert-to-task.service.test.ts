/**
 * AC-E1+E2: Convert to Task
 *
 * Contract tests for:
 * - E1: POST /channels/:id/messages/:messageId/convert-to-task
 * - E2: POST /channels/:id/messages/:messageId/convert-to-task/suggest
 */
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from 'vitest';
import { FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
import { WorkUnitService } from '../../workunit/workunit.service.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// We'll import convert-to-task service once implemented
let ConvertToTaskService: typeof import('../convert-to-task.service.js').ConvertToTaskService;

describe('AC-E1+E2: Convert to Task', () => {
  const testChannelIds: string[] = [];
  const testWorkUnitIds: string[] = [];
  let tmpDir: string;
  let fileStore: FileStore;
  let workUnitService: WorkUnitService;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'convert-task-'));
    fileStore = new FileStore(tmpDir);
    workUnitService = new WorkUnitService(fileStore);
    try {
      const mod = await import('../convert-to-task.service.js');
      ConvertToTaskService = mod.ConvertToTaskService;
    } catch {
      // Not yet implemented
    }
  });

  afterAll(async () => {
    for (const id of testWorkUnitIds) {
      await workUnitService.delete(id).catch(() => {});
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // Recreate FileStore for clean state
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    fileStore = new FileStore(tmpDir);
  });

  /** 在 FileStore 中创建消息，返回 {channelId, msgId} */
  async function createFsMessage(content: string, opts?: { workUnitId?: string }): Promise<{ channelId: string; msgId: string }> {
    const chId = `test-ch-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    testChannelIds.push(chId);
    await fileStore.createChannel({
      id: chId, name: `#e1-test`, type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const now = new Date().toISOString();
    const msg: ChannelMessageData = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      channelId: chId, authorType: 'human', agentName: null,
      content, replyToId: null, meta: '{}',
      workUnitId: opts?.workUnitId ?? null, createdAt: now,
    };
    await fileStore.appendMessage(chId, msg);
    return { channelId: chId, msgId: msg.id };
  }

  // ── AC-E1: Convert to Task API ──

  describe('AC-E1: Convert to Task API', () => {
    it('normal convert → WorkUnit created + message linked', async () => {
      const { channelId, msgId } = await createFsMessage('Fix the login bug');
      const service = new ConvertToTaskService(fileStore);
      const workUnit = await service.convert(channelId, msgId, {
        title: 'Fix login bug',
        description: 'Users cannot login with SSO',
      });
      testWorkUnitIds.push(workUnit.id);

      expect(workUnit).toBeDefined();
      expect(workUnit.scope).toBe('Fix login bug');
      expect(workUnit.channelId).toBe(channelId);
      expect(workUnit.status).toBe('unassigned');

      // Message should now be linked
      const found = await fileStore.getMessageById(msgId);
      expect(found).not.toBeNull();
      expect(found!.message.workUnitId).toBe(workUnit.id);
    });

    it('message already has workUnitId → error', async () => {
      const existingWu = await workUnitService.create({
        scope: 'existing', type: 'task', status: 'unassigned',
      });
      testWorkUnitIds.push(existingWu.id);
      const { channelId, msgId } = await createFsMessage('already linked', { workUnitId: existingWu.id });

      const service = new ConvertToTaskService(fileStore);
      await expect(service.convert(channelId, msgId, {})).rejects.toThrow(/already/i);
    });

    it('message not found → error', async () => {
      const service = new ConvertToTaskService(fileStore);
      await expect(service.convert('ch-id', 'nonexistent-msg-id', {})).rejects.toThrow(/not found/i);
    });

    it('convert makes message the anchor (workUnitId set, replyToId null)', async () => {
      const { channelId, msgId } = await createFsMessage('anchor message');
      const service = new ConvertToTaskService(fileStore);
      const workUnit = await service.convert(channelId, msgId, { title: 'Anchor task' });
      testWorkUnitIds.push(workUnit.id);

      const found = await fileStore.getMessageById(msgId);
      expect(found).not.toBeNull();
      expect(found!.message.workUnitId).toBe(workUnit.id);
      expect(found!.message.replyToId).toBeNull();
    });

    it('with assigneeId → WorkUnit.status = active', async () => {
      const { channelId, msgId } = await createFsMessage('assign me');
      const agentId = `agent-e1-${Date.now()}`;
      const now = new Date().toISOString();
      await fileStore.createProfile({ id: agentId, name: `e1-agent`, description: null, channels: '[]', status: 'active', createdAt: now, updatedAt: now });
      const service = new ConvertToTaskService(fileStore);
      const workUnit = await service.convert(channelId, msgId, { assigneeId: agentId });
      testWorkUnitIds.push(workUnit.id);

      expect(workUnit.assigneeId).toBe(agentId);
      expect(workUnit.status).toBe('active');
    });

    it('without assigneeId → WorkUnit.status = unassigned', async () => {
      const { channelId, msgId } = await createFsMessage('no assignee');
      const service = new ConvertToTaskService(fileStore);
      const workUnit = await service.convert(channelId, msgId, {});
      testWorkUnitIds.push(workUnit.id);

      expect(workUnit.assigneeId).toBeNull();
      expect(workUnit.status).toBe('unassigned');
    });
  });

  // ── AC-E2: LLM 预填建议 ──

  describe('AC-E2: LLM suggest', () => {
    it('normal suggest → returns suggestion object', async () => {
      const service = new ConvertToTaskService(undefined);

      // Mock the LLM call
      const mockSuggest = vi.spyOn(service as unknown as Record<string, unknown>, 'callLLM' as never)
        .mockResolvedValue({ title: 'Fix bug', description: 'Login issue', suggestedAssigneeId: undefined, suggestedProjectPath: undefined });

      const result = await service.suggest('Please fix the login bug', [], []);
      expect(result).toBeDefined();
      expect(result.title).toBeDefined();

      mockSuggest.mockRestore();
    });

    it('empty message → returns empty suggestion', async () => {
      const service = new ConvertToTaskService(undefined);
      const result = await service.suggest('', [], []);
      expect(result).toEqual({});
    });

    it('LLM call failure → returns empty suggestion (non-blocking)', async () => {
      const service = new ConvertToTaskService(undefined);

      // Force LLM to fail by mocking fetch
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'));

      const result = await service.suggest('Some message content', [], []);
      expect(result).toEqual({});

      fetchSpy.mockRestore();
    });
  });
});
