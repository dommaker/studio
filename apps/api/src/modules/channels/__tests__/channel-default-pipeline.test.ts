/**
 * AC-6.1: ChannelData.defaultPipeline 字段
 * AC-6.2: channel.routes POST/PATCH 支持 defaultPipeline 校验
 *
 * 校验规则：defaultPipeline 每项必须是 active AgentProfile name。
 * 校验失败返回 400。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { validateDefaultPipeline } from '../channel.routes.js';

describe('AC-6.1 + AC-6.2: Channel defaultPipeline', () => {
  let tmpDir: string;
  let fileStore: FileStore;

  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-pipeline-test-'));
    fileStore = new FileStore(tmpDir);

    // Seed active profiles
    const now = new Date().toISOString();
    await fileStore.createProfile({
      id: 'p-active-1', name: 'executor', description: null,
      channels: '[]', status: 'active', createdAt: now, updatedAt: now,
    });
    await fileStore.createProfile({
      id: 'p-active-2', name: 'reviewer', description: null,
      channels: '[]', status: 'active', createdAt: now, updatedAt: now,
    });
    await fileStore.createProfile({
      id: 'p-inactive', name: 'archived-agent', description: null,
      channels: '[]', status: 'inactive', createdAt: now, updatedAt: now,
    });
  });

  afterAll(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── AC-6.1: ChannelData field round-trip ──

  describe('AC-6.1: ChannelData.defaultPipeline field', () => {
    it('createChannel with defaultPipeline persists field', async () => {
      const now = new Date().toISOString();
      const id = `ch-field-${Date.now()}`;
      await fileStore.createChannel({
        id, name: `#test-field-${Date.now()}`, type: 'rnd',
        defaultWorkspaceId: null, defaultPath: null,
        discordChannelId: null, discordWebhookUrl: null,
        members: '[]', defaultPipeline: ['executor', 'reviewer'],
        createdAt: now, updatedAt: now,
      });
      const stored = await fileStore.getChannel(id);
      expect(stored?.defaultPipeline).toEqual(['executor', 'reviewer']);
    });

    it('createChannel without defaultPipeline -> field undefined', async () => {
      const now = new Date().toISOString();
      const id = `ch-nopipe-${Date.now()}`;
      await fileStore.createChannel({
        id, name: `#test-nopipe-${Date.now()}`, type: 'rnd',
        defaultWorkspaceId: null, defaultPath: null,
        discordChannelId: null, discordWebhookUrl: null,
        members: '[]',
        createdAt: now, updatedAt: now,
      });
      const stored = await fileStore.getChannel(id);
      expect(stored?.defaultPipeline).toBeUndefined();
    });

    it('updateChannel with defaultPipeline updates field', async () => {
      const now = new Date().toISOString();
      const id = `ch-upd-${Date.now()}`;
      await fileStore.createChannel({
        id, name: `#test-upd-${Date.now()}`, type: 'rnd',
        defaultWorkspaceId: null, defaultPath: null,
        discordChannelId: null, discordWebhookUrl: null,
        members: '[]', defaultPipeline: ['executor'],
        createdAt: now, updatedAt: now,
      });
      await fileStore.updateChannel(id, { defaultPipeline: ['reviewer'] });
      const stored = await fileStore.getChannel(id);
      expect(stored?.defaultPipeline).toEqual(['reviewer']);
    });
  });

  // ── AC-6.2: validateDefaultPipeline ──

  describe('AC-6.2: validateDefaultPipeline()', () => {
    it('validates active profile names -> ok', async () => {
      const result = await validateDefaultPipeline(fileStore, ['executor', 'reviewer']);
      expect(result.ok).toBe(true);
      expect(result.value).toEqual(['executor', 'reviewer']);
    });

    it('rejects non-existent profile name', async () => {
      const result = await validateDefaultPipeline(fileStore, ['ghost']);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not found or not active/i);
    });

    it('rejects inactive profile name', async () => {
      const result = await validateDefaultPipeline(fileStore, ['archived-agent']);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/not found or not active/i);
    });

    it('rejects non-string item', async () => {
      const result = await validateDefaultPipeline(fileStore, [123]);
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/must be string/i);
    });

    it('rejects non-array value', async () => {
      const result = await validateDefaultPipeline(fileStore, 'executor');
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/must be an array/i);
    });

    it('accepts empty array (clear pipeline)', async () => {
      const result = await validateDefaultPipeline(fileStore, []);
      expect(result.ok).toBe(true);
      expect(result.value).toEqual([]);
    });

    it('undefined -> ok with no value (skip update)', async () => {
      const result = await validateDefaultPipeline(fileStore, undefined);
      expect(result.ok).toBe(true);
      expect(result.value).toBeUndefined();
    });
  });
});
