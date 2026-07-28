/**
 * B4a 内置角色（决策 D7/D8）测试
 *
 * - ensureBuiltinRoles: pm/dev/reviewer seed（幂等 / 不覆盖用户改动 / 可禁用）
 * - description → acceptedTypes 关键词解析（agent-loop / skill-selector 同一集合）
 * - ensureBuiltinRoleMembers: 频道自动加入内置角色（幂等）
 * - migrateBuiltinRolesToProjectChannels: 存量工程频道补成员（只动绑定工程的频道）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, parseChannels, type AgentProfileData } from '@dommaker/studio-shared';
import {
  BUILTIN_ROLES,
  ensureBuiltinRoles,
  ensureBuiltinRoleMembers,
  migrateBuiltinRolesToProjectChannels,
} from '../builtin-roles.js';

/** Inline keyword extraction — replaced acceptedTypesFromDescription (removed per decision 9) */
function acceptedTypesFromDescription(text: string): string[] {
  const parts = text.split(/[。.\s]+/);
  const tail = parts[parts.length - 1];
  return tail ? tail.split(/\s+/).filter(k => k.length > 0) : [];
}

function createChannelData(id: string, overrides?: Record<string, unknown>) {
  const now = new Date().toISOString();
  return {
    id, name: `#ch-${id}`, type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: '[]',
    createdAt: now, updatedAt: now,
    ...overrides,
  };
}

describe('B4a: ensureBuiltinRoles', () => {
  let tmpDir: string;
  let fileStore: FileStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-roles-test-'));
    fileStore = new FileStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('首次 seed 创建 pm/dev/reviewer，status=active', async () => {
    const roles = await ensureBuiltinRoles(fileStore);
    expect(roles.map(r => r.name).sort()).toEqual(['dev', 'pm', 'reviewer']);
    for (const role of roles) {
      expect(role.status).toBe('active');
      expect(role.provider).toBeNull();
    }
    // 落盘确认
    const onDisk = await fileStore.listProfiles();
    expect(onDisk.filter(p => ['pm', 'dev', 'reviewer'].includes(p.name))).toHaveLength(3);
  });

  it('description 解析出预期的 acceptedTypes', async () => {
    const roles = await ensureBuiltinRoles(fileStore);
    const byName = new Map(roles.map(r => [r.name, r]));
    // mention 指名 pm 的 WU 默认 type=task，pm 必须能认领 task
    expect(acceptedTypesFromDescription(byName.get('pm')!.description).sort())
      .toEqual(['analysis', 'feature', 'task']);
    expect(acceptedTypesFromDescription(byName.get('dev')!.description).sort())
      .toEqual(['bug', 'feature', 'refactor', 'task']);
    expect(acceptedTypesFromDescription(byName.get('reviewer')!.description).sort())
      .toEqual(['analysis', 'review']);
  });

  it('reviewer description 含 reviewer 字样（ReviewDispatcher 匹配锚点）', async () => {
    const roles = await ensureBuiltinRoles(fileStore);
    const reviewer = roles.find(r => r.name === 'reviewer')!;
    expect(reviewer.description!.toLowerCase()).toContain('reviewer');
  });

  it('幂等：重复 seed 不产生重复 profile，id/description 不变', async () => {
    const first = await ensureBuiltinRoles(fileStore);
    const second = await ensureBuiltinRoles(fileStore);
    expect(second.map(r => r.id).sort()).toEqual(first.map(r => r.id).sort());
    const all = await fileStore.listProfiles();
    expect(all.filter(p => ['pm', 'dev', 'reviewer'].includes(p.name))).toHaveLength(3);
  });

  it('不覆盖用户改动（description/provider）', async () => {
    const seeded = await ensureBuiltinRoles(fileStore);
    const pm = seeded.find(r => r.name === 'pm')!;
    await fileStore.updateProfile(pm.id, { description: '用户改写的产品经理', provider: 'kimi' });

    const again = await ensureBuiltinRoles(fileStore);
    const pmAfter = again.find(r => r.name === 'pm')!;
    expect(pmAfter.id).toBe(pm.id);
    expect(pmAfter.description).toBe('用户改写的产品经理');
    expect(pmAfter.provider).toBe('kimi');
  });

  it('尊重用户禁用（status=inactive 不复活）', async () => {
    const seeded = await ensureBuiltinRoles(fileStore);
    const dev = seeded.find(r => r.name === 'dev')!;
    await fileStore.updateProfile(dev.id, { status: 'inactive' });

    const again = await ensureBuiltinRoles(fileStore);
    const devAfter = again.find(r => r.name === 'dev')!;
    expect(devAfter.status).toBe('inactive');
  });

  it('用户自建同名 profile 时保留用户的（不覆盖）', async () => {
    const now = new Date().toISOString();
    const mine: AgentProfileData = {
      id: 'my-pm', name: 'pm', description: '我自己的 pm',
      channels: '[]', provider: 'claude', status: 'active',
      createdAt: now, updatedAt: now,
    };
    await fileStore.createProfile(mine);

    const roles = await ensureBuiltinRoles(fileStore);
    const pm = roles.find(r => r.name === 'pm')!;
    expect(pm.id).toBe('my-pm');
    expect(pm.description).toBe('我自己的 pm');
  });
});

describe('B4a: ensureBuiltinRoleMembers', () => {
  let tmpDir: string;
  let fileStore: FileStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-members-test-'));
    fileStore = new FileStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('把三个内置角色加入频道 members，保留已有成员', async () => {
    const roles = await ensureBuiltinRoles(fileStore);
    await fileStore.createChannel(createChannelData('ch-1', { members: JSON.stringify(['existing-member']) }));

    const added = await ensureBuiltinRoleMembers(fileStore, 'ch-1');
    expect(added).toBe(3);

    const channel = await fileStore.getChannel('ch-1');
    const members = parseChannels(channel!.members);
    expect(members).toContain('existing-member');
    for (const role of roles) expect(members).toContain(role.id);
  });

  it('幂等：重复加入返回 0，members 不重复', async () => {
    const roles = await ensureBuiltinRoles(fileStore);
    await fileStore.createChannel(createChannelData('ch-2', { members: JSON.stringify([roles[0].id]) }));

    expect(await ensureBuiltinRoleMembers(fileStore, 'ch-2')).toBe(2); // 第一个已在
    expect(await ensureBuiltinRoleMembers(fileStore, 'ch-2')).toBe(0);

    const channel = await fileStore.getChannel('ch-2');
    const members = parseChannels(channel!.members);
    expect(members.length).toBe(new Set(members).size);
    expect(members).toHaveLength(3);
  });

  it('频道不存在返回 0，不抛错', async () => {
    expect(await ensureBuiltinRoleMembers(fileStore, 'no-such-channel')).toBe(0);
  });
});

describe('B4a: migrateBuiltinRolesToProjectChannels', () => {
  let tmpDir: string;
  let fileStore: FileStore;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'builtin-migrate-test-'));
    fileStore = new FileStore(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('只给绑定工程的频道补成员，未绑定的不动', async () => {
    const roles = await ensureBuiltinRoles(fileStore);
    await fileStore.createChannel(createChannelData('ch-bound', { defaultWorkspaceId: 'ws-1' }));
    await fileStore.createChannel(createChannelData('ch-unbound'));

    const result = await migrateBuiltinRolesToProjectChannels(fileStore);
    expect(result).toEqual({ channelsUpdated: 1, membersAdded: 3 });

    const bound = await fileStore.getChannel('ch-bound');
    const boundMembers = parseChannels(bound!.members);
    for (const role of roles) expect(boundMembers).toContain(role.id);

    const unbound = await fileStore.getChannel('ch-unbound');
    expect(parseChannels(unbound!.members)).toEqual([]);
  });

  it('幂等：第二次执行无新增', async () => {
    await ensureBuiltinRoles(fileStore);
    await fileStore.createChannel(createChannelData('ch-bound', { defaultWorkspaceId: 'ws-1' }));

    await migrateBuiltinRolesToProjectChannels(fileStore);
    const second = await migrateBuiltinRolesToProjectChannels(fileStore);
    expect(second).toEqual({ channelsUpdated: 0, membersAdded: 0 });
  });

  it('内置角色全部缺失时不报错、不加成员', async () => {
    await fileStore.createChannel(createChannelData('ch-bound', { defaultWorkspaceId: 'ws-1' }));
    const result = await migrateBuiltinRolesToProjectChannels(fileStore);
    expect(result).toEqual({ channelsUpdated: 0, membersAdded: 0 });
  });

  it('BUILTIN_ROLES 定义与 seed 一致（防漂移）', () => {
    expect(BUILTIN_ROLES.map(r => r.name).sort()).toEqual(['dev', 'pm', 'reviewer']);
    for (const role of BUILTIN_ROLES) {
      expect(acceptedTypesFromDescription(role.description).length).toBeGreaterThan(0);
    }
  });
});
