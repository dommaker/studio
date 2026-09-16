/**
 * #532：channel 记录 service 收口
 *
 * 契约：
 * - 写路径（create/update/archive/restore/deleteWithFallback/updateMembers）
 *   内部即失效 channels 列表缓存——clearCache('/api/v1/channels') 由 service 调用，
 *   路由不再感知
 * - 读判定单点：getOrThrow 记录不存在抛 ChannelError(404, 'Channel not found')；
 *   updateMembers 保留历史文案 `Channel <id> not found`
 * - 重名创建抛 ChannelError(409)；restore 非归档频道抛 ChannelError(400)
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FileStore } from '@dommaker/studio-shared';

vi.mock('../../../middleware/api-cache.js', async (importActual) => {
  const actual = await importActual<typeof import('../../../middleware/api-cache.js')>();
  return { ...actual, clearCache: vi.fn().mockResolvedValue(undefined) };
});

import { clearCache } from '../../../middleware/api-cache.js';
import { ChannelService, ChannelError, validateDefaultWorkspaceId } from '../channel.service.js';

const clearCacheMock = vi.mocked(clearCache);

let fileStore: FileStore;
let service: ChannelService;

beforeEach(() => {
  fileStore = new FileStore();
  service = new ChannelService(fileStore);
  clearCacheMock.mockClear();
});

async function seedChannel(suffix: string, extra?: Partial<{ name: string; members: string }>): Promise<string> {
  const id = `ch-svc-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  const now = new Date().toISOString();
  await fileStore.createChannel({
    id, name: extra?.name ?? `#svc-${suffix}`, type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: extra?.members ?? '[]', createdAt: now, updatedAt: now,
  });
  return id;
}

describe('getOrThrow：404 判定单点', () => {
  it('记录存在 → 返回频道', async () => {
    const id = await seedChannel('get');
    const channel = await service.getOrThrow(id);
    expect(channel.id).toBe(id);
  });

  it('记录不存在 → ChannelError(404, "Channel not found")', async () => {
    const err = await service.getOrThrow('ch-does-not-exist').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect((err as ChannelError).status).toBe(404);
    expect((err as ChannelError).message).toBe('Channel not found');
  });

  it('自定义文案（chore-pmo 现状）', async () => {
    const err = await service.getOrThrow('ch-x', 'Channel not found: ch-x').catch((e: unknown) => e);
    expect((err as ChannelError).message).toBe('Channel not found: ch-x');
  });
});

describe('写路径内部失效缓存', () => {
  it('create → clearCache("/api/v1/channels")', async () => {
    await service.create({ name: 'svc-create', type: 'rnd', defaultPath: null });
    expect(clearCacheMock).toHaveBeenCalledWith('/api/v1/channels');
  });

  it('create 重名 → ChannelError(409)，不失效缓存', async () => {
    await seedChannel('dup', { name: '#svc-dup' });
    const err = await service.create({ name: 'svc-dup', type: 'rnd', defaultPath: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect((err as ChannelError).status).toBe(409);
    expect((err as ChannelError).message).toBe('Channel name already exists');
    expect(clearCacheMock).not.toHaveBeenCalled();
  });

  it('update → 写入 + 失效 + 返回更新记录', async () => {
    const id = await seedChannel('upd');
    const updated = await service.update(id, { name: '#svc-upd-renamed' });
    expect(updated.name).toBe('#svc-upd-renamed');
    expect(clearCacheMock).toHaveBeenCalledWith('/api/v1/channels');
  });

  it('update 不存在 → ChannelError(404)', async () => {
    const err = await service.update('ch-nope', { name: '#x' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect((err as ChannelError).status).toBe(404);
  });

  it('update 合并 routing：单档更新不清其他档', async () => {
    const id = await seedChannel('routing');
    await service.update(id, { routing: { plan: 'p1' } });
    const updated = await service.update(id, { routing: { implement: 'p2' } });
    expect(updated.routing).toEqual({ plan: 'p1', implement: 'p2' });
  });

  it('archive → 改名带 -archived- 后缀 + 失效', async () => {
    const id = await seedChannel('arch');
    const newName = await service.archive(id);
    expect(newName).toMatch(/^#svc-arch-archived-\d+$/);
    expect(clearCacheMock).toHaveBeenCalledWith('/api/v1/channels');
  });

  it('restore 非归档频道 → ChannelError(400, "Channel is not archived")', async () => {
    const id = await seedChannel('rest400');
    const err = await service.restore(id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect((err as ChannelError).status).toBe(400);
    expect((err as ChannelError).message).toBe('Channel is not archived');
  });

  it('archive → restore 回原名 + 失效', async () => {
    const id = await seedChannel('rest');
    await service.archive(id);
    clearCacheMock.mockClear();
    const name = await service.restore(id);
    expect(name).toBe('#svc-rest');
    expect(clearCacheMock).toHaveBeenCalledWith('/api/v1/channels');
  });

  it('deleteWithFallback → 删除 + 返回兜底频道 + 失效', async () => {
    // 独立数据根：共享根里有其他用例的 rnd 频道，fallback 拣选前提不成立
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ch-svc-del-'));
    const store = new FileStore(dir);
    const isolated = new ChannelService(store);
    const id = `ch-svc-del-${Date.now()}`;
    const fallbackId = `ch-svc-del-fb-${Date.now()}`;
    const now = new Date().toISOString();
    for (const [cid, name] of [[id, '#svc-del'], [fallbackId, '#svc-del-fallback']] as const) {
      await store.createChannel({
        id: cid, name, type: 'rnd', defaultWorkspaceId: null, defaultPath: null,
        discordChannelId: null, discordWebhookUrl: null, members: '[]', createdAt: now, updatedAt: now,
      });
    }
    clearCacheMock.mockClear();
    const result = await isolated.deleteWithFallback(id);
    expect(result.fallbackChannelId).toBe(fallbackId);
    expect(await isolated.getOrThrow(fallbackId)).toBeTruthy();
    await expect(isolated.getOrThrow(id)).rejects.toThrow(ChannelError);
    expect(clearCacheMock).toHaveBeenCalledWith('/api/v1/channels');
  });

  it('deleteWithFallback 无其他 rnd 频道 → 自建 #研发 兜底', async () => {
    const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'ch-svc-alone-'));
    const store = new FileStore(dir);
    const isolated = new ChannelService(store);
    const id = `ch-svc-del-alone-${Date.now()}`;
    const now = new Date().toISOString();
    await store.createChannel({
      id, name: '#svc-del-alone', type: 'rnd', defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]', createdAt: now, updatedAt: now,
    });
    const result = await isolated.deleteWithFallback(id);
    expect(result.fallbackChannelId).not.toBe(id);
    const fallback = await isolated.getOrThrow(result.fallbackChannelId);
    expect(fallback.name).toBe('#研发');
  });

  it('updateMembers → 合并写回 + 失效', async () => {
    const id = await seedChannel('members');
    // updateMembers 校验 add 的 profile 存在性——先确保 agent-a 存在
    if (!(await fileStore.getProfile('agent-a'))) {
      const now = new Date().toISOString();
      await fileStore.createProfile({ id: 'agent-a', name: 'agent-a', description: null, channels: '[]', status: 'active', createdAt: now, updatedAt: now });
    }
    const members = await service.updateMembers(id, { add: ['agent-a'] });
    expect(members).toEqual(['agent-a']);
    expect(clearCacheMock).toHaveBeenCalledWith('/api/v1/channels');
  });

  it('updateMembers 不存在 → ChannelError(404) 保留历史文案 `Channel <id> not found`', async () => {
    const err = await service.updateMembers('ch-gone', { add: ['a'] }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChannelError);
    expect((err as ChannelError).status).toBe(404);
    expect((err as ChannelError).message).toBe('Channel ch-gone not found');
  });
});

describe('validateDefaultWorkspaceId（自 routes 搬入）', () => {
  it("'' / null / 非字符串 → null（清除默认工程）", async () => {
    expect((await validateDefaultWorkspaceId('')).value).toBeNull();
    expect((await validateDefaultWorkspaceId(null)).value).toBeNull();
    expect((await validateDefaultWorkspaceId(123)).value).toBeNull();
  });

  it('未注册 workspace → ok:false 含 id', async () => {
    const result = await validateDefaultWorkspaceId('ws-never-registered-532');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('ws-never-registered-532');
  });
});
