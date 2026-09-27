/**
 * P0 修复 6 + #519: traceId 贯穿 — message-routing 段
 *
 * - @mention 建 WU 时 options.traceId 写入 metadata.traceId
 * - 无 traceId 时 metadata 不带该字段（向后兼容）
 * - #519 三路径补齐：线程回复关联的 WU、显式建单（#632 intent=new-task）+ 合并窗口并入的在途 WU
 *   同样写入/刷新 metadata.traceId；口径统一为「本次消息 traceId」（spec user story 5
 *   二选一，取与 AC「与本次请求一致」对齐的一项）
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { routeMessage } from '../message-routing.js';
import { channelMessageService } from '../channel-message.service.js';
import { WorkUnitService } from '../../workunit/workunit.service.js';

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
    const message = await routeMessage(channelId, '@Nobody 做个事', undefined, { fs: fileStore,
      traceId: 'trace-abc-123',
    });

    expect(message.workUnitId).toBeTruthy();
    const meta = await findWuMeta(message.workUnitId!);
    expect(meta.traceId).toBe('trace-abc-123');
    expect(meta.creationMode).toBe('mention');
  });

  it('@mention 建 WU：无 traceId 时 metadata 不含 traceId 字段', async () => {
    const message = await routeMessage(channelId, '@Nobody 做个事', undefined, { fs: fileStore });

    expect(message.workUnitId).toBeTruthy();
    const meta = await findWuMeta(message.workUnitId!);
    expect('traceId' in meta).toBe(false);
  });

  it('线程回复：不建 WU，traceId 不产生任何 WorkUnit', async () => {
    const parent = await routeMessage(channelId, '@Nobody 父消息', undefined, { fs: fileStore,
      traceId: 'trace-parent',
    });
    const wuCountBefore = (await fileStore.getIndex()).length;

    const reply = await routeMessage(channelId, '线程回复', parent.id, { fs: fileStore,
      traceId: 'trace-reply',
    });

    // 回复继承父消息 workUnitId，不新建 WU
    expect(reply.workUnitId).toBe(parent.workUnitId);
    expect((await fileStore.getIndex()).length).toBe(wuCountBefore);
  });

  // #519: traceId 三条派单路径补齐（spec 2026-09-12-channel-mainline-measurement）
  it('#519 线程回复：关联 WU 的 metadata.traceId 刷新为本次请求 traceId', async () => {
    const parent = await routeMessage(channelId, '@Nobody 父消息', undefined, { fs: fileStore,
      traceId: 'trace-parent',
    });

    const reply = await routeMessage(channelId, '线程回复', parent.id, { fs: fileStore,
      traceId: 'trace-reply',
    });

    const meta = await findWuMeta(reply.workUnitId!);
    expect(meta.traceId).toBe('trace-reply');
  });

  it('#519 显式建单（intent=new-task）：options.traceId 写入 metadata.traceId', async () => {
    const message = await routeMessage(channelId, '无 @ 的普通消息', undefined, { fs: fileStore,
      traceId: 'trace-default-new',
      intent: 'new-task',
    });

    expect(message.workUnitId).toBeTruthy();
    const meta = await findWuMeta(message.workUnitId!);
    expect(meta.traceId).toBe('trace-default-new');
    expect(meta.creationMode).toBe('channel-new-task');
  });

  it('#519 合并窗口：并入的在途 WU metadata.traceId 刷新为本次消息 traceId', async () => {
    const first = await routeMessage(channelId, '第一条', undefined, { fs: fileStore,
      traceId: 'trace-merge-first',
      intent: 'new-task',
    });

    const second = await routeMessage(channelId, '窗口内第二条', undefined, { fs: fileStore,
      traceId: 'trace-merge-second',
    });

    // 合并入同一张在途 WU，不新建
    expect(second.workUnitId).toBe(first.workUnitId);
    const meta = await findWuMeta(first.workUnitId!);
    expect(meta.traceId).toBe('trace-merge-second');
  });

  // B2：merge/reply 路径折叠 metadata 重复写——锁内写次数断言（spy 计 updateMetadata 调用数）
  describe('B2：traceId 折叠锁内写（消独立 refreshWuTraceId 的全量 index R/W）', () => {
    /** 造一张 blocked + waitingForInput 的在途 WU + 窗口内一条携带它的人类消息 */
    async function seedBlockedWuWithMessage() {
      const wuService = new WorkUnitService(fileStore);
      const wu = await wuService.create({
        scope: '挂起任务', channelId, type: 'task', status: 'active', assigneeId: 'i-1',
      });
      await wuService.transitionStatus(wu.id, 'blocked');
      await wuService.update(wu.id, {
        metadata: { waitingForInput: true, waitingQuestion: '继续吗？', waitingSince: new Date().toISOString() },
      });
      await fileStore.appendMessage(channelId, {
        id: `m-${wu.id}`, channelId, authorType: 'human', agentName: null,
        content: '关于挂起任务的消息', replyToId: null, meta: '{}', workUnitId: wu.id,
        createdAt: new Date().toISOString(),
      });
      return wu;
    }

    it('线程回复 blocked WU：复活 + traceId 一次锁内写（原 resume 写 + 独立 refresh 两次）', async () => {
      const wu = await seedBlockedWuWithMessage();
      const spy = vi.spyOn(fileStore, 'updateMetadata');

      const reply = await routeMessage(channelId, '继续，用方案 B', `m-${wu.id}`, { fs: fileStore,
        traceId: 'trace-fold-reply',
      });

      expect(reply.workUnitId).toBe(wu.id);
      expect(spy).toHaveBeenCalledTimes(1); // transitionStatus 不走 updateMetadata
      const meta = await findWuMeta(wu.id);
      expect(meta.traceId).toBe('trace-fold-reply');
      expect(meta.pendingReplies).toEqual(['继续，用方案 B']);
      spy.mockRestore();
    });

    it('合并窗口 blocked WU：复活 + traceId 一次锁内写', async () => {
      const wu = await seedBlockedWuWithMessage();
      const spy = vi.spyOn(fileStore, 'updateMetadata');

      const merged = await routeMessage(channelId, '窗口内补充', undefined, { fs: fileStore,
        traceId: 'trace-fold-merge',
      });

      expect(merged.workUnitId).toBe(wu.id);
      expect(spy).toHaveBeenCalledTimes(1);
      const meta = await findWuMeta(wu.id);
      expect(meta.traceId).toBe('trace-fold-merge');
      expect(meta.pendingReplies).toEqual(['窗口内补充']);
      spy.mockRestore();
    });

    it('合并窗口未消费分支（unassigned）：pendingReplies + traceId 并成一次 updateMetadata（原两次）', async () => {
      const wuService = new WorkUnitService(fileStore);
      const wu = await wuService.create({
        scope: '在途任务', channelId, type: 'task', status: 'unassigned', assigneeId: null,
      });
      await fileStore.appendMessage(channelId, {
        id: `m-${wu.id}`, channelId, authorType: 'human', agentName: null,
        content: '关于在途任务的消息', replyToId: null, meta: '{}', workUnitId: wu.id,
        createdAt: new Date().toISOString(),
      });
      const spy = vi.spyOn(fileStore, 'updateMetadata');

      const merged = await routeMessage(channelId, '窗口内第二条', undefined, { fs: fileStore,
        traceId: 'trace-fold-pending',
      });

      expect(merged.workUnitId).toBe(wu.id);
      expect(spy).toHaveBeenCalledTimes(1);
      const meta = await findWuMeta(wu.id);
      expect(meta.traceId).toBe('trace-fold-pending');
      expect(meta.pendingReplies).toEqual(['窗口内第二条']);
      spy.mockRestore();
    });
  });
});
