/**
 * DELETE /api/v1/channels/:id 删除兜底路由测试（B2-012）
 *
 * 验证路由把 WU 重绑委托给 WorkUnitService.rebindSourceChannel：
 *  - context.sourceChannelId 字段相等的顶层 task WU 重挂到兜底频道
 *  - metadata 其它字段仅子串含 channel id 的 WU 不动（字段相等口径）
 *  - 路由周边行为不变：频道删除、响应形状（#155：SDD frontmatter 迁移块已随 SDD 退役删除）
 *
 * 接线：STUDIO_DATA_DIR 指向临时目录后才动态 import channel.routes
 * （模块级 `new FileStore()` 在 import 时解析数据目录）。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import express from 'express';
import type { Server } from 'node:http';
import { FileStore, eventBus } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../../workunit/workunit.service.js';

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let server: Server;
let baseUrl: string;

const CH_DEL = `ch-del-${Date.now()}`;
const CH_FALLBACK = `ch-fallback-${Date.now()}`;

function metaWithSourceChannel(channelId: string): WorkUnitMetadata {
  return { context: { sourceChannelId: channelId } } as unknown as WorkUnitMetadata;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ch-delete-fallback-'));
  process.env.STUDIO_DATA_DIR = tmpDir;
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  eventBus.unsubscribeAll?.('workunit.status_changed');

  const { default: channelRoutes } = await import('../channel.routes.js');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/channels', channelRoutes);
  await new Promise<void>(resolve => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('failed to bind test server');
  baseUrl = `http://127.0.0.1:${addr.port}/api/v1/channels`;

  // 待删频道 + 已存在的 rnd 兜底频道（路由优先复用，不新建 #研发）
  const now = new Date().toISOString();
  for (const [id, name] of [[CH_DEL, '#待删'], [CH_FALLBACK, '#研发']] as const) {
    await fileStore.createChannel({
      id, name, type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: '[]', createdAt: now, updatedAt: now,
    });
  }
});

afterAll(async () => {
  eventBus.unsubscribeAll?.('workunit.status_changed');
  await new Promise<void>(resolve => server.close(() => resolve()));
  delete process.env.STUDIO_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('DELETE /channels/:id fallback', () => {
  it('委托 rebindSourceChannel：字段相等 WU 重挂兜底频道，子串误伤不动，响应形状不变', async () => {
    // 字段相等 → 应重绑
    const wuHit = await wuService.create({ scope: 'hit', metadata: metaWithSourceChannel(CH_DEL) });
    // 仅子串含 channel id（scope 列 + metadata.description），sourceChannelId 不同 → 不动
    const wuTrap = await wuService.create({
      scope: `trap ${CH_DEL}`,
      metadata: {
        description: `channel ${CH_DEL} related`,
        context: { sourceChannelId: 'ch-unrelated' },
      } as unknown as WorkUnitMetadata,
    });
    // 无 metadata → 不动
    const wuEmpty = await wuService.create({ scope: 'empty' });

    const res = await fetch(`${baseUrl}/${CH_DEL}`, { method: 'DELETE' });
    const body: { success: boolean; data: { deleted: boolean; fallbackChannelId: string } } = await res.json();

    // 响应形状不变
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ deleted: true, fallbackChannelId: CH_FALLBACK });

    // 频道已删除
    expect(await fileStore.getChannel(CH_DEL)).toBeNull();

    // WU 重绑委托结果
    const hit = await wuService.getById(wuHit.id);
    expect(JSON.parse(hit!.metadata!).context.sourceChannelId).toBe(CH_FALLBACK);
    const trap = await wuService.getById(wuTrap.id);
    expect(JSON.parse(trap!.metadata!).context.sourceChannelId).toBe('ch-unrelated');
    expect((await wuService.getById(wuEmpty.id))!.metadata).toBeNull();
  });

  it('删除不存在的频道 → 404', async () => {
    const res = await fetch(`${baseUrl}/ch-nonexistent`, { method: 'DELETE' });
    expect(res.status).toBe(404);
  });
});
