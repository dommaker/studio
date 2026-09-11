/**
 * #497: routing/members 配置漂移收敛
 *
 * AC1: 删除 profile 后各频道 routing 无悬空引用（幂等，其他档/其他频道不动）
 * AC2: members 移出被指名角色 → buildMemberRemovalWarning 产出 warning（不阻断）
 * AC3: 同频道同档同原因 fallback 提醒冷却窗内不重复（shouldEmitFallbackReminder）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore, stringifyChannels } from '@dommaker/studio-shared';
import { AgentProfileService } from '../../agents/agent-profile.service.js';
import {
  buildMemberRemovalWarning,
  shouldEmitFallbackReminder,
  resetFallbackReminderCooldown,
  FALLBACK_REMINDER_COOLDOWN_MS,
} from '../routing.js';

let tmpDir: string;
let fileStore: FileStore;
let service: AgentProfileService;

const now = '2026-09-11T00:00:00.000Z';

async function seedProfile(id: string, name: string) {
  await fileStore.createProfile({
    id, name, description: null,
    channels: '[]', status: 'active', createdAt: now, updatedAt: now,
  });
}

async function seedChannel(id: string, opts: {
  members?: string[];
  routing?: Record<string, string | null>;
  defaultProfileId?: string | null;
} = {}) {
  await fileStore.createChannel({
    id, name: `#${id}`, type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: stringifyChannels(opts.members ?? []),
    ...(opts.routing !== undefined ? { routing: opts.routing } : {}),
    ...(opts.defaultProfileId !== undefined ? { defaultProfileId: opts.defaultProfileId } : {}),
    createdAt: now, updatedAt: now,
  });
}

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-drift-test-'));
  fileStore = new FileStore(tmpDir);
  service = new AgentProfileService(fileStore);
  resetFallbackReminderCooldown();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('#497 AC1: 删除 profile 收敛各频道 routing', () => {
  it('删除被指名 profile → 引用它的 routing 档归一化为 null，其他档/其他频道不动', async () => {
    await seedProfile('p-1', 'planner');
    await seedProfile('p-2', 'exec');
    await seedChannel('ch-a', { members: ['p-1', 'p-2'], routing: { plan: 'p-1', implement: 'p-2' } });
    await seedChannel('ch-b', { members: ['p-1'], routing: { review: 'p-1' } });
    await seedChannel('ch-c', { members: ['p-2'], routing: { plan: 'p-2' } });

    await service.delete('p-1');

    const a = await fileStore.getChannel('ch-a');
    expect(a!.routing).toEqual({ plan: null, implement: 'p-2' });
    expect(JSON.parse(a!.members)).toEqual(['p-2']);

    const b = await fileStore.getChannel('ch-b');
    expect(b!.routing).toEqual({ review: null });
    expect(JSON.parse(b!.members)).toEqual([]);

    // 不引用 p-1 的频道完全不动
    const c = await fileStore.getChannel('ch-c');
    expect(c!.routing).toEqual({ plan: 'p-2' });
    expect(JSON.parse(c!.members)).toEqual(['p-2']);
  });

  it('幂等：删除未被任何 routing/members 引用的 profile → 频道配置零改动', async () => {
    await seedProfile('p-free', 'free-agent');
    await seedProfile('p-kept', 'kept');
    await seedChannel('ch-x', { members: ['p-kept'], routing: { plan: 'p-kept' } });

    await service.delete('p-free');

    const x = await fileStore.getChannel('ch-x');
    expect(x!.routing).toEqual({ plan: 'p-kept' });
    expect(JSON.parse(x!.members)).toEqual(['p-kept']);
  });

  it('members 有引用但 routing 无引用 → 只清 members，不无中生有 routing 字段', async () => {
    await seedProfile('p-m', 'member-only');
    await seedChannel('ch-m', { members: ['p-m'] });

    await service.delete('p-m');

    const ch = await fileStore.getChannel('ch-m');
    expect(JSON.parse(ch!.members)).toEqual([]);
    expect(ch!.routing).toBeUndefined();
  });
});

describe('#497 AC2: members 移出被指名角色 → warning', () => {
  it('移出角色被 routing 档指名 → warning 含阶段标签', async () => {
    await seedChannel('ch-w', { routing: { plan: 'p-1', review: 'p-1' } });
    const ch = await fileStore.getChannel('ch-w');
    const warning = buildMemberRemovalWarning(ch!, ['p-1']);
    expect(warning).toBeTruthy();
    expect(warning).toContain('规划');
    expect(warning).toContain('评审');
  });

  it('移出角色被指名为入口角色 defaultProfileId → warning 含入口角色', async () => {
    await seedChannel('ch-w2', { defaultProfileId: 'p-1' });
    const ch = await fileStore.getChannel('ch-w2');
    const warning = buildMemberRemovalWarning(ch!, ['p-1']);
    expect(warning).toBeTruthy();
    expect(warning).toContain('入口角色');
  });

  it('移出角色未被任何指名引用 → 无 warning', async () => {
    await seedChannel('ch-w3', { routing: { plan: 'p-1' }, defaultProfileId: 'p-2' });
    const ch = await fileStore.getChannel('ch-w3');
    expect(buildMemberRemovalWarning(ch!, ['p-other'])).toBeUndefined();
  });

  it('routing 档值为 null（已清除）→ 不算指名，无 warning', async () => {
    await seedChannel('ch-w4', { routing: { plan: null } });
    const ch = await fileStore.getChannel('ch-w4');
    expect(buildMemberRemovalWarning(ch!, ['p-1'])).toBeUndefined();
  });

  it('remove 为空 → 无 warning', async () => {
    await seedChannel('ch-w5', { routing: { plan: 'p-1' } });
    const ch = await fileStore.getChannel('ch-w5');
    expect(buildMemberRemovalWarning(ch!, [])).toBeUndefined();
  });
});

describe('#497 AC3: fallback 提醒冷却去重', () => {
  const resolution = { profileId: null, fallback: 'not-member' as const, profileName: 'outsider' };

  it('同频道同档同原因：冷却窗内第二次 → false', () => {
    expect(shouldEmitFallbackReminder('ch-1', 'implement', resolution)).toBe(true);
    expect(shouldEmitFallbackReminder('ch-1', 'implement', resolution)).toBe(false);
  });

  it('不同档 → 各自计时', () => {
    expect(shouldEmitFallbackReminder('ch-1', 'implement', resolution)).toBe(true);
    expect(shouldEmitFallbackReminder('ch-1', 'review', resolution)).toBe(true);
  });

  it('不同原因 → 各自计时', () => {
    expect(shouldEmitFallbackReminder('ch-1', 'implement', resolution)).toBe(true);
    expect(shouldEmitFallbackReminder('ch-1', 'implement', { ...resolution, fallback: 'inactive' })).toBe(true);
  });

  it('不同频道 → 各自计时', () => {
    expect(shouldEmitFallbackReminder('ch-1', 'implement', resolution)).toBe(true);
    expect(shouldEmitFallbackReminder('ch-2', 'implement', resolution)).toBe(true);
  });

  it('冷却窗过后 → 再次放行', () => {
    const t0 = 1_000_000;
    expect(shouldEmitFallbackReminder('ch-1', 'implement', resolution, t0)).toBe(true);
    expect(shouldEmitFallbackReminder('ch-1', 'implement', resolution, t0 + FALLBACK_REMINDER_COOLDOWN_MS - 1)).toBe(false);
    expect(shouldEmitFallbackReminder('ch-1', 'implement', resolution, t0 + FALLBACK_REMINDER_COOLDOWN_MS)).toBe(true);
  });
});
