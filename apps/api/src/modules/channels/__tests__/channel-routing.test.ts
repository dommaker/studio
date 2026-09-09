/**
 * #466: ChannelData.routing 字段（吞并 AC-6.1 的 defaultPipeline 字段测试）
 *
 * routing = { plan?, implement?, review? } —— profile ID；undefined = 未配置。
 * 字段级 round-trip；PATCH 校验逻辑见 routing.test.ts 的 validateRouting 用例。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';

describe('#466: ChannelData.routing field', () => {
  let tmpDir: string;
  let fileStore: FileStore;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-routing-test-'));
    fileStore = new FileStore(tmpDir);
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('createChannel with routing persists field', async () => {
    const now = new Date().toISOString();
    const id = `ch-routing-${Date.now()}`;
    await fileStore.createChannel({
      id, name: `#test-routing-${Date.now()}`, type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: '[]', routing: { plan: 'p-1', implement: 'p-2', review: null },
      createdAt: now, updatedAt: now,
    });
    const stored = await fileStore.getChannel(id);
    expect(stored?.routing).toEqual({ plan: 'p-1', implement: 'p-2', review: null });
  });

  it('createChannel without routing -> field undefined', async () => {
    const now = new Date().toISOString();
    const id = `ch-norouting-${Date.now()}`;
    await fileStore.createChannel({
      id, name: `#test-norouting-${Date.now()}`, type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: '[]',
      createdAt: now, updatedAt: now,
    });
    const stored = await fileStore.getChannel(id);
    expect(stored?.routing).toBeUndefined();
  });

  it('updateChannel with routing updates field', async () => {
    const now = new Date().toISOString();
    const id = `ch-updrouting-${Date.now()}`;
    await fileStore.createChannel({
      id, name: `#test-updrouting-${Date.now()}`, type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: '[]', routing: { plan: 'p-1' },
      createdAt: now, updatedAt: now,
    });
    await fileStore.updateChannel(id, { routing: { plan: null, review: 'p-3' } });
    const stored = await fileStore.getChannel(id);
    expect(stored?.routing).toEqual({ plan: null, review: 'p-3' });
  });
});
