/**
 * #466: 频道级「阶段→角色」路由表 —— resolveStageRouting / validateRouting
 *
 * 语义（票体定稿）：
 *  - 未配置的阶段 → profileId=null（回池涌现，向后兼容）
 *  - 配置了且角色 active 且为频道成员 → profileId=该角色（指名即硬约束）
 *  - 配置了但角色被移出频道/inactive/不存在 → profileId=null + fallback 原因（回池涌现 + 频道出声）
 *  - 成员判定：channel.members 唯一事实源；members 空（历史频道）回退 profile.channels（agent-loop 同口径）
 *  - validateRouting：PATCH 入口校验——值须为 active profile id（'' / null = 清除该档），不强制成员
 *    （成员边界在路由时判定，defaultProfileId 先例）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore, stringifyChannels } from '@dommaker/studio-shared';
import { resolveStageRouting, validateRouting } from '../routing.js';

let tmpDir: string;
let fileStore: FileStore;

const now = '2026-09-09T00:00:00.000Z';

async function seedProfile(id: string, name: string, status = 'active', channels: string[] = []) {
  await fileStore.createProfile({
    id, name, description: null,
    channels: stringifyChannels(channels), status, createdAt: now, updatedAt: now,
  });
}

async function seedChannel(id: string, opts: { members?: string[]; routing?: Record<string, string | null> } = {}) {
  await fileStore.createChannel({
    id, name: `#${id}`, type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: stringifyChannels(opts.members ?? []),
    ...(opts.routing !== undefined ? { routing: opts.routing } : {}),
    createdAt: now, updatedAt: now,
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-test-'));
  fileStore = new FileStore(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('#466 resolveStageRouting', () => {
  it('频道无 routing 配置 → profileId=null（回池涌现）', async () => {
    await seedChannel('ch-plain');
    const r = await resolveStageRouting(fileStore, 'ch-plain', 'plan');
    expect(r.profileId).toBeNull();
    expect(r.fallback).toBeUndefined();
  });

  it('routing 已配置但该阶段为空 → profileId=null', async () => {
    await seedChannel('ch-partial', { routing: { implement: 'p-exec' } });
    const r = await resolveStageRouting(fileStore, 'ch-partial', 'review');
    expect(r.profileId).toBeNull();
    expect(r.fallback).toBeUndefined();
  });

  it('配置了且角色 active + 频道成员 → 指名该角色', async () => {
    await seedProfile('p-plan', 'planner');
    await seedChannel('ch-routed', { members: ['p-plan'], routing: { plan: 'p-plan' } });
    const r = await resolveStageRouting(fileStore, 'ch-routed', 'plan');
    expect(r.profileId).toBe('p-plan');
    expect(r.profileName).toBe('planner');
    expect(r.fallback).toBeUndefined();
  });

  it('配置了但角色 inactive → 回池涌现 + fallback=inactive', async () => {
    await seedProfile('p-dead', 'gone-agent', 'inactive');
    await seedChannel('ch-inactive', { members: ['p-dead'], routing: { implement: 'p-dead' } });
    const r = await resolveStageRouting(fileStore, 'ch-inactive', 'implement');
    expect(r.profileId).toBeNull();
    expect(r.fallback).toBe('inactive');
    expect(r.profileName).toBe('gone-agent');
  });

  it('配置了但角色不在频道成员 → 回池涌现 + fallback=not-member', async () => {
    await seedProfile('p-outsider', 'outsider');
    await seedChannel('ch-nomember', { members: ['p-other'], routing: { review: 'p-outsider' } });
    const r = await resolveStageRouting(fileStore, 'ch-nomember', 'review');
    expect(r.profileId).toBeNull();
    expect(r.fallback).toBe('not-member');
    expect(r.profileName).toBe('outsider');
  });

  it('配置了但 profile 不存在 → 回池涌现 + fallback=not-found', async () => {
    await seedChannel('ch-ghost', { routing: { plan: 'p-ghost' } });
    const r = await resolveStageRouting(fileStore, 'ch-ghost', 'plan');
    expect(r.profileId).toBeNull();
    expect(r.fallback).toBe('not-found');
  });

  it('members 空（历史频道）→ 回退 profile.channels 判定成员', async () => {
    await seedProfile('p-legacy', 'legacy-agent', 'active', ['ch-legacy']);
    await seedChannel('ch-legacy', { members: [], routing: { plan: 'p-legacy' } });
    const r = await resolveStageRouting(fileStore, 'ch-legacy', 'plan');
    expect(r.profileId).toBe('p-legacy');
  });

  it('members 空且 profile.channels 也不含本频道 → not-member', async () => {
    await seedProfile('p-nomatch', 'nomatch');
    await seedChannel('ch-nomatch', { members: [], routing: { plan: 'p-nomatch' } });
    const r = await resolveStageRouting(fileStore, 'ch-nomatch', 'plan');
    expect(r.profileId).toBeNull();
    expect(r.fallback).toBe('not-member');
  });

  it('频道不存在 → profileId=null（无配置口径）', async () => {
    const r = await resolveStageRouting(fileStore, 'ch-missing', 'plan');
    expect(r.profileId).toBeNull();
    expect(r.fallback).toBeUndefined();
  });
});

describe('#466 validateRouting', () => {
  beforeEach(async () => {
    await seedProfile('p-active', 'active-agent');
    await seedProfile('p-inactive', 'inactive-agent', 'inactive');
  });

  it('undefined → ok 无 value（跳过更新）', async () => {
    const r = await validateRouting(fileStore, undefined);
    expect(r.ok).toBe(true);
    expect(r.value).toBeUndefined();
  });

  it('合法 profile id → ok', async () => {
    const r = await validateRouting(fileStore, { plan: 'p-active', review: 'p-active' });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ plan: 'p-active', review: 'p-active' });
  });

  it('空串 / null → 清除该档（归一化为 null）', async () => {
    const r = await validateRouting(fileStore, { plan: '', implement: null });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ plan: null, implement: null });
  });

  it('非对象 → 拒绝', async () => {
    const r = await validateRouting(fileStore, 'p-active');
    expect(r.ok).toBe(false);
  });

  it('数组 → 拒绝', async () => {
    const r = await validateRouting(fileStore, ['p-active']);
    expect(r.ok).toBe(false);
  });

  it('未知阶段键 → 拒绝', async () => {
    const r = await validateRouting(fileStore, { deploy: 'p-active' });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/deploy/);
  });

  it('profile 不存在或 inactive → 拒绝', async () => {
    expect((await validateRouting(fileStore, { plan: 'p-ghost' })).ok).toBe(false);
    expect((await validateRouting(fileStore, { plan: 'p-inactive' })).ok).toBe(false);
  });

  it('值类型非法（数字）→ 拒绝', async () => {
    const r = await validateRouting(fileStore, { plan: 123 });
    expect(r.ok).toBe(false);
  });
});
