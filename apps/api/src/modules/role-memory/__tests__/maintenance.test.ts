import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FileStore } from '@dommaker/studio-shared';
import { RoleMemoryStore, roleMemoryDir, roleMemoryRoot } from '../role-memory.js';
import { RoleMemoryMaintenance } from '../maintenance.js';

const createdRoleIds: string[] = [];
function freshRoleId(): string {
  const id = `maintenance-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createdRoleIds.push(id);
  return id;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const id of createdRoleIds.splice(0)) {
    fs.rmSync(path.join(roleMemoryRoot(), id), { recursive: true, force: true });
  }
});

describe('#718 RoleMemoryMaintenance', () => {
  it('promote 在副作用前持久化意图，成功后折叠为 succeeded', async () => {
    const roleId = freshRoleId();
    const store = new RoleMemoryStore();
    const maintenance = new RoleMemoryMaintenance(store);
    const entry = await store.appendDraft(roleId, {
      kind: 'execution-knowledge', title: 'Durable', content: 'body',
    });
    const originalPromote = store.promote.bind(store);
    let statesAtSideEffect: string[] = [];
    vi.spyOn(store, 'promote').mockImplementation(async (rid, ids) => {
      const rows = await new FileStore().readJsonl<{ status: string }>(path.join(roleMemoryDir(roleId), 'maintenance.jsonl'));
      statesAtSideEffect = rows.map(row => row.status);
      return originalPromote(rid, ids);
    });

    const run = await maintenance.execute(roleId, { type: 'promote', entryIds: [entry.id] }, `promote-${entry.id}`);

    expect(statesAtSideEffect).toEqual(['triggered', 'running']);
    expect(run.status).toBe('succeeded');
    expect(await store.readTopic(roleId, 'durable')).toMatchObject({ body: expect.stringContaining('body') });
    await expect(maintenance.getRun(roleId, run.id)).resolves.toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it('failed run 可由启动恢复重试并记录 attempts', async () => {
    const roleId = freshRoleId();
    const store = new RoleMemoryStore();
    const maintenance = new RoleMemoryMaintenance(store);
    const entry = await store.appendDraft(roleId, {
      kind: 'execution-knowledge', title: 'Retry', content: 'body',
    });
    vi.spyOn(store, 'promote').mockRejectedValueOnce(new Error('temporary failure'));

    await expect(maintenance.execute(roleId, { type: 'promote', entryIds: [entry.id] }, 'retry-run')).rejects.toThrow('temporary failure');
    await maintenance.recoverPending();

    await expect(maintenance.getRun(roleId, 'retry-run')).resolves.toMatchObject({ status: 'succeeded', attempts: 2 });
  });

  it('启动恢复重放 running merge，且不重复正文', async () => {
    const roleId = freshRoleId();
    const store = new RoleMemoryStore();
    const fileStore = new FileStore();
    const maintenance = new RoleMemoryMaintenance(store, fileStore);
    const target = await store.appendDraft(roleId, {
      kind: 'execution-knowledge', title: 'Target', content: 'target-body', topicSlug: 'target',
    });
    const source = await store.appendDraft(roleId, {
      kind: 'execution-knowledge', title: 'Source', content: 'source-body', topicSlug: 'source',
    });
    await store.promote(roleId, [target.id, source.id]);
    const run = {
      id: 'merge-recovery', roleId,
      operation: { type: 'merge' as const, targetSlug: 'target', sourceSlugs: ['source'] },
      status: 'running' as const, attempts: 0, updatedAt: new Date().toISOString(),
    };
    await fileStore.appendJsonl(path.join(roleMemoryDir(roleId), 'maintenance.jsonl'), run);

    await maintenance.recoverPending();
    await maintenance.recoverPending();

    expect((await store.readTopic(roleId, 'target'))?.body.split('## Source')).toHaveLength(2);
    await expect(maintenance.getRun(roleId, run.id)).resolves.toMatchObject({ status: 'succeeded', attempts: 1 });
  });

  it('capacity 真正归档 stale，archive/restore 保留原文且可恢复', async () => {
    const roleId = freshRoleId();
    const store = new RoleMemoryStore({ maxTopics: 1 });
    const maintenance = new RoleMemoryMaintenance(store);
    const active = await store.appendDraft(roleId, {
      kind: 'execution-knowledge', title: 'Active', content: 'active-body', topicSlug: 'active',
    });
    const stale = await store.appendDraft(roleId, {
      kind: 'execution-knowledge', title: 'Stale', content: 'stale-body', topicSlug: 'stale',
    });
    await store.promote(roleId, [active.id, stale.id]);
    await store.setLifecycleStatus(roleId, 'stale', 'stale');
    expect((await store.checkCapacity(roleId)).overLimit).toBe(true);

    const capacity = await maintenance.execute(roleId, { type: 'capacity' });
    expect(capacity.result?.capacity?.overLimit).toBe(false);
    expect(await store.readTopic(roleId, 'stale')).toMatchObject({ status: 'archived', body: expect.stringContaining('stale-body') });

    await maintenance.execute(roleId, { type: 'archive', slugs: ['active'] });
    expect(await store.readTopic(roleId, 'active')).toMatchObject({ status: 'archived', body: expect.stringContaining('active-body') });
    await maintenance.execute(roleId, { type: 'restore', slugs: ['active'] });
    expect(await store.readTopic(roleId, 'active')).toMatchObject({ status: 'active', body: expect.stringContaining('active-body') });
  });
});
