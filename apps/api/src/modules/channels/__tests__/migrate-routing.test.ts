/**
 * #466: defaultPipeline 吞并迁移 —— 存量频道配置自动并入路由表
 *
 * 规则：
 *  - routing 未配置（undefined）且 defaultPipeline 非空 → defaultPipeline[0] 的 name
 *    解析为 active profile id，落 routing.implement，并移除 defaultPipeline 字段
 *  - routing 已配置 → 不动（幂等 / 不覆盖人工新配置）
 *  - defaultPipeline[0] 无法解析为 active profile → 死配置吞并移除（展开本就 no-op），记 warn
 *  - 幂等：重复执行结果不变
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore, stringifyChannels } from '@dommaker/studio-shared';
import { migrateDefaultPipelineToRouting } from '../migrate-routing.js';

let tmpDir: string;
let fileStore: FileStore;

const now = '2026-09-09T00:00:00.000Z';

/** 以旧数据形态直接写频道（defaultPipeline 已从 ChannelData 退役，测试模拟存量数据） */
async function seedLegacyChannel(id: string, defaultPipeline?: string[], routing?: Record<string, string | null>) {
  await fileStore.createChannel({
    id, name: `#${id}`, type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: stringifyChannels([]),
    createdAt: now, updatedAt: now,
  } as Parameters<FileStore['createChannel']>[0]);
  const patch: Record<string, unknown> = {};
  if (defaultPipeline !== undefined) patch.defaultPipeline = defaultPipeline;
  if (routing !== undefined) patch.routing = routing;
  if (Object.keys(patch).length > 0) {
    await fileStore.updateChannel(id, patch as Partial<import('@dommaker/studio-shared').ChannelData>);
  }
}

async function rawChannel(id: string): Promise<Record<string, unknown>> {
  const raw = await fileStore.readJson<Record<string, unknown>>(
    path.join(tmpDir, 'channels', id, 'config.json'),
  );
  return raw!;
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-routing-'));
  fileStore = new FileStore(tmpDir);
  await fileStore.createProfile({
    id: 'p-exec', name: 'executor', description: null,
    channels: '[]', status: 'active', createdAt: now, updatedAt: now,
  });
  await fileStore.createProfile({
    id: 'p-dead', name: 'dead-agent', description: null,
    channels: '[]', status: 'inactive', createdAt: now, updatedAt: now,
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('#466 migrateDefaultPipelineToRouting', () => {
  it('defaultPipeline=[name] → routing.implement=对应 profile id，defaultPipeline 字段移除', async () => {
    await seedLegacyChannel('ch-legacy', ['executor']);
    const result = await migrateDefaultPipelineToRouting(fileStore);
    expect(result.migrated).toBe(1);

    const raw = await rawChannel('ch-legacy');
    expect(raw.routing).toEqual({ implement: 'p-exec' });
    expect('defaultPipeline' in raw).toBe(false);
  });

  it('多跳管线只吞并第一跳（D10：本就只展开第一跳）', async () => {
    await seedLegacyChannel('ch-multi', ['executor', 'dead-agent']);
    await migrateDefaultPipelineToRouting(fileStore);
    const raw = await rawChannel('ch-multi');
    expect(raw.routing).toEqual({ implement: 'p-exec' });
  });

  it('routing 已配置 → 不动（不覆盖）', async () => {
    await seedLegacyChannel('ch-routed', ['executor'], { plan: 'p-exec' });
    const result = await migrateDefaultPipelineToRouting(fileStore);
    expect(result.migrated).toBe(0);
    const raw = await rawChannel('ch-routed');
    expect(raw.routing).toEqual({ plan: 'p-exec' });
  });

  it('defaultPipeline 首跳无法解析（不存在/inactive）→ 死配置移除，routing 不落', async () => {
    await seedLegacyChannel('ch-dead', ['dead-agent']);
    await seedLegacyChannel('ch-ghost', ['ghost-name']);
    const result = await migrateDefaultPipelineToRouting(fileStore);
    expect(result.migrated).toBe(0);
    expect(result.dropped).toBe(2);
    expect('defaultPipeline' in await rawChannel('ch-dead')).toBe(false);
    expect('defaultPipeline' in await rawChannel('ch-ghost')).toBe(false);
    expect((await rawChannel('ch-dead')).routing).toBeUndefined();
  });

  it('无 defaultPipeline 的频道不受影响', async () => {
    await seedLegacyChannel('ch-clean');
    const result = await migrateDefaultPipelineToRouting(fileStore);
    expect(result.migrated).toBe(0);
    expect(result.dropped).toBe(0);
    expect('defaultPipeline' in await rawChannel('ch-clean')).toBe(false);
  });

  it('幂等：第二次执行零变更', async () => {
    await seedLegacyChannel('ch-idem', ['executor']);
    await migrateDefaultPipelineToRouting(fileStore);
    const second = await migrateDefaultPipelineToRouting(fileStore);
    expect(second.migrated).toBe(0);
    expect(second.dropped).toBe(0);
  });
});
