/**
 * P0 修复 6 + #519: traceId 贯穿 — message-routing 段
 *
 * - @mention 建 WU 时 options.traceId 写入 metadata.traceId
 * - 无 traceId 时 metadata 不带该字段（向后兼容）
 * - #519 三路径补齐：线程回复关联的 WU、默认角色派单（新建 + 合并窗口并入的在途 WU）
 *   同样写入/刷新 metadata.traceId；口径统一为「本次消息 traceId」（spec user story 5
 *   二选一，取与 AC「与本次请求一致」对齐的一项）
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { routeMessage } from '../message-routing.js';
import { channelMessageService } from '../channel-message.service.js';

let channelId: string;
let tmpDir: string;
let fileStore: FileStore;

async function findWuMeta(id: string): Promise<Record<string, unknown>> {
  const snapshots = await fileStore.getIndex();
  const wu = snapshots.find(s => s.id === id);
  if (!wu) throw new Error(`WorkUnit ${id} not found`);
  return wu.metadata ? JSON.parse(wu.metadata) : {};
}

describe('message-routing traceId (P0 修复 6)', () => {
  beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'msg-routing-traceid-'));
    fileStore = new FileStore(tmpDir);
  });

  afterAll(() => {
    delete process.env.STUDIO_PROJECTS_ROOT;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.mkdirSync(tmpDir, { recursive: true });
    fileStore = new FileStore(tmpDir);
    channelId = `ch-trace-${Date.now()}`;
    await fileStore.createChannel({
      id: channelId, name: '#trace-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: '[]',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    channelMessageService.setFileStore(fileStore);
    // B3a：线程回复触发归属解析时会查 project-discovery —— 指向空 tmp 目录保持隔离
    process.env.STUDIO_PROJECTS_ROOT = tmpDir;
  });

  it('@mention 建 WU：options.traceId 写入 metadata.traceId', async () => {
    const message = await routeMessage(channelId, '@Nobody 做个事', undefined, fileStore, {
      traceId: 'trace-abc-123',
    });

    expect(message.workUnitId).toBeTruthy();
    const meta = await findWuMeta(message.workUnitId!);
    expect(meta.traceId).toBe('trace-abc-123');
    expect(meta.creationMode).toBe('mention');
  });

  it('@mention 建 WU：无 traceId 时 metadata 不含 traceId 字段', async () => {
    const message = await routeMessage(channelId, '@Nobody 做个事', undefined, fileStore);

    expect(message.workUnitId).toBeTruthy();
    const meta = await findWuMeta(message.workUnitId!);
    expect('traceId' in meta).toBe(false);
  });

  it('线程回复：不建 WU，traceId 不产生任何 WorkUnit', async () => {
    const parent = await routeMessage(channelId, '@Nobody 父消息', undefined, fileStore, {
      traceId: 'trace-parent',
    });
    const wuCountBefore = (await fileStore.getIndex()).length;

    const reply = await routeMessage(channelId, '线程回复', parent.id, fileStore, {
      traceId: 'trace-reply',
    });

    // 回复继承父消息 workUnitId，不新建 WU
    expect(reply.workUnitId).toBe(parent.workUnitId);
    expect((await fileStore.getIndex()).length).toBe(wuCountBefore);
  });

  // #519: traceId 三条派单路径补齐（spec 2026-09-12-channel-mainline-measurement）
  it('#519 线程回复：关联 WU 的 metadata.traceId 刷新为本次请求 traceId', async () => {
    const parent = await routeMessage(channelId, '@Nobody 父消息', undefined, fileStore, {
      traceId: 'trace-parent',
    });

    const reply = await routeMessage(channelId, '线程回复', parent.id, fileStore, {
      traceId: 'trace-reply',
    });

    const meta = await findWuMeta(reply.workUnitId!);
    expect(meta.traceId).toBe('trace-reply');
  });

  it('#519 默认角色派单（新建 WU）：options.traceId 写入 metadata.traceId', async () => {
    await fileStore.updateChannel(channelId, { defaultProfileId: 'default-agent-1' });

    const message = await routeMessage(channelId, '无 @ 的普通消息', undefined, fileStore, {
      traceId: 'trace-default-new',
    });

    expect(message.workUnitId).toBeTruthy();
    const meta = await findWuMeta(message.workUnitId!);
    expect(meta.traceId).toBe('trace-default-new');
    expect(meta.creationMode).toBe('channel-default');
  });

  it('#519 默认角色合并窗口：并入的在途 WU metadata.traceId 刷新为本次消息 traceId', async () => {
    await fileStore.updateChannel(channelId, { defaultProfileId: 'default-agent-1' });
    const first = await routeMessage(channelId, '第一条', undefined, fileStore, {
      traceId: 'trace-merge-first',
    });

    const second = await routeMessage(channelId, '窗口内第二条', undefined, fileStore, {
      traceId: 'trace-merge-second',
    });

    // 合并入同一张在途 WU，不新建
    expect(second.workUnitId).toBe(first.workUnitId);
    const meta = await findWuMeta(first.workUnitId!);
    expect(meta.traceId).toBe('trace-merge-second');
  });
});
