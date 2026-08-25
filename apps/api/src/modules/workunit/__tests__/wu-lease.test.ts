/**
 * #178（#63 决议，2026-08-16）WU 租约（lease）机制：
 * - claim 写固定 5min 租约 timeoutAt（废除按 type 30/60min 默认 + metadata.timeoutAt 显式优先，
 *   「已有列值不动」一并废除——租约语义下认领即发新租约）
 * - FileStore.refreshWorkUnitLease：fencing（claimedAt 代际令牌 + assigneeId 双比对）+
 *   推前 timeoutAt；#314 起高频小写缓冲、flushWorkUnitLeases 复核 fencing 后合并落盘
 * - timeout-release 释放即杀：顺 assigneeId → 实例记录 → pid 杀原 holder 进程组
 *  （自身 pid 跳过、ESRCH 跳过、pid 复用按 /proc 启动时间与实例 startedAt 比对兜底）
 * 约定与 workunit-timeout.test.ts 一致：真实 FileStore（tmpdir）+ 真实 Service。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, WU_LEASE_TTL_MS, type WorkUnitMetadata } from '../workunit.service.js';
import { scanTimedOutWorkUnits } from '../timeout-release.js';

vi.mock('../wu-messenger.js', () => ({
  postWuSystemMessage: vi.fn().mockResolvedValue(null),
}));

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let channelId: string;
const spawned: ChildProcess[] = [];

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-lease-test-'));
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  channelId = `ch-lease-${Date.now()}`;
  await fileStore.createChannel({
    id: channelId, name: '#lease-test', type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null, members: '[]',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
});

afterEach(() => {
  for (const child of spawned) {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); } catch { /* 已死 */ }
      try { process.kill(child.pid, 'SIGKILL'); } catch { /* 已死 */ }
    }
  }
  spawned.length = 0;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createClaimable(type: string, metadata?: WorkUnitMetadata) {
  return wuService.create({
    scope: `${type} 租约任务`, type, channelId,
    status: 'unassigned', // #126：task/feature 默认落 pending（不可认领），显式置 unassigned
    metadata,
  });
}

/** 进程死亡轮询（≤2s）：SIGKILL 后子进程被 Node 异步 reap，kill(pid,0) 立即探活可能仍命中僵尸 */
async function waitForProcessDeath(pid: number): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      process.kill(pid, 0);
    } catch {
      return; // ESRCH：已死
    }
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`process ${pid} still alive after 2s`);
}

describe('#178: claim 写固定 5min 租约（废除按 type 默认）', () => {
  it('task/review/analysis/未知 type 一律 5min 租约', async () => {
    for (const type of ['task', 'review', 'analysis', 'spike']) {
      const before = Date.now();
      const wu = await createClaimable(type);
      const claimed = await wuService.claim(wu.id, 'inst-1');
      expect(claimed.status).toBe('active');
      const deltaMs = claimed.timeoutAt!.getTime() - before;
      expect(deltaMs).toBeGreaterThanOrEqual(WU_LEASE_TTL_MS);
      expect(deltaMs).toBeLessThanOrEqual(WU_LEASE_TTL_MS + 60_000);
      expect(WU_LEASE_TTL_MS).toBe(5 * 60_000);
    }
  });

  it('metadata.timeoutAt 显式值不再优先（租约 TTL 单一固定值）', async () => {
    const before = Date.now();
    const wu = await createClaimable('task', { timeoutAt: '2026-09-01T00:00:00.000Z' });
    const claimed = await wuService.claim(wu.id, 'inst-1');
    const deltaMs = claimed.timeoutAt!.getTime() - before;
    expect(deltaMs).toBeGreaterThanOrEqual(WU_LEASE_TTL_MS);
    expect(deltaMs).toBeLessThanOrEqual(WU_LEASE_TTL_MS + 60_000);
  });

  it('已有 timeoutAt 列值被刷新为新租约（认领即发新租约）', async () => {
    const before = Date.now();
    const stale = new Date(Date.now() + 30 * 60_000); // 旧的 30min 死线残留
    const wu = await wuService.create({
      scope: '残留死线', type: 'review', channelId, status: 'unassigned', timeoutAt: stale,
    });
    const claimed = await wuService.claim(wu.id, 'inst-1');
    const deltaMs = claimed.timeoutAt!.getTime() - before;
    expect(deltaMs).toBeGreaterThanOrEqual(WU_LEASE_TTL_MS);
    expect(deltaMs).toBeLessThanOrEqual(WU_LEASE_TTL_MS + 60_000);
    expect(claimed.timeoutAt!.toISOString()).not.toBe(stale.toISOString());
  });
});

describe('#178: refreshWorkUnitLease（锁内 fencing + 推前 timeoutAt）', () => {
  async function createClaimed() {
    const wu = await createClaimable('task');
    return wuService.claim(wu.id, 'inst-1');
  }

  it('令牌匹配 → ok；#314 起缓冲至落盘窗口，flush 后推前 timeoutAt', async () => {
    const claimed = await createClaimed();
    const next = new Date(Date.now() + WU_LEASE_TTL_MS);

    const result = await fileStore.refreshWorkUnitLease(
      claimed.id, 'inst-1', claimed.claimedAt!.toISOString(), next,
    );

    expect(result).toBe('ok');
    // #314（D2）：心跳高频小写缓冲，flush 前磁盘值不变（不再每跳全量重写）
    const beforeFlush = (await wuService.getById(claimed.id))!;
    expect(beforeFlush.timeoutAt!.toISOString()).toBe(claimed.timeoutAt!.toISOString());

    await fileStore.flushWorkUnitLeases();
    const after = (await wuService.getById(claimed.id))!;
    expect(after.timeoutAt!.toISOString()).toBe(next.toISOString());
    // 其余字段不动
    expect(after.assigneeId).toBe('inst-1');
    expect(after.claimedAt!.toISOString()).toBe(claimed.claimedAt!.toISOString());
  });

  it('claimedAt 不匹配（易主）→ lost 且一字不写', async () => {
    const claimed = await createClaimed();
    const before = (await wuService.getById(claimed.id))!;

    const result = await fileStore.refreshWorkUnitLease(
      claimed.id, 'inst-1', '2000-01-01T00:00:00.000Z', new Date(Date.now() + 999_000),
    );

    expect(result).toBe('lost');
    const after = (await wuService.getById(claimed.id))!;
    expect(after.timeoutAt!.toISOString()).toBe(before.timeoutAt!.toISOString());
    expect(after.updatedAt.toISOString()).toBe(before.updatedAt.toISOString());
  });

  it('assigneeId 不匹配 → lost；WU 不存在 → missing', async () => {
    const claimed = await createClaimed();

    await expect(fileStore.refreshWorkUnitLease(
      claimed.id, 'inst-2', claimed.claimedAt!.toISOString(), new Date(),
    )).resolves.toBe('lost');
    await expect(fileStore.refreshWorkUnitLease(
      'wu-gone', 'inst-1', claimed.claimedAt!.toISOString(), new Date(),
    )).resolves.toBe('missing');
  });
});

describe('#178: timeout-release 释放即杀原 holder 进程组', () => {
  function spawnHolder(): ChildProcess {
    const child = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
    child.unref();
    spawned.push(child);
    return child;
  }

  async function registerHolder(instanceId: string, pid: number, startedAt?: string) {
    await fileStore.createState(instanceId, {
      id: instanceId, roleId: 'role-1', sessionId: null, status: 'active',
      currentWorkUnitId: null, startedAt: startedAt ?? new Date().toISOString(),
      terminatedAt: null, lastHeartbeat: null, metadata: null, pid,
    });
  }

  async function createTimedOut(assigneeId: string) {
    return wuService.create({
      scope: '超时任务', type: 'task', channelId,
      status: 'active', assigneeId,
      timeoutAt: new Date(Date.now() - 60_000),
    });
  }

  it('释放时顺 assigneeId → 实例 pid 杀原 holder 进程组', async () => {
    const holder = spawnHolder();
    await registerHolder('inst-holder', holder.pid!);
    const wu = await createTimedOut('inst-holder');

    const handled = await scanTimedOutWorkUnits(fileStore);

    expect(handled).toBe(1);
    expect((await wuService.getById(wu.id))!.status).toBe('unassigned');
    // 进程组已被杀
    await waitForProcessDeath(holder.pid!);
  });

  it('≥3 次超时转 blocked 路径同样杀原 holder', async () => {
    const holder = spawnHolder();
    await registerHolder('inst-holder', holder.pid!);
    const wu = await wuService.create({
      scope: '超时任务', type: 'task', channelId,
      status: 'active', assigneeId: 'inst-holder',
      timeoutAt: new Date(Date.now() - 60_000),
      metadata: { timeoutReleaseCount: 2 },
    });

    await scanTimedOutWorkUnits(fileStore);

    expect((await wuService.getById(wu.id))!.status).toBe('blocked');
    await waitForProcessDeath(holder.pid!);
  });

  it('holder 是本进程（pid === process.pid）→ 跳过不自杀，WU 正常释放', async () => {
    await registerHolder('inst-self', process.pid);
    const wu = await createTimedOut('inst-self');

    const handled = await scanTimedOutWorkUnits(fileStore);

    expect(handled).toBe(1);
    expect((await wuService.getById(wu.id))!.status).toBe('unassigned');
    expect(() => process.kill(process.pid, 0)).not.toThrow(); // 自己还活着
  });

  it('pid 已死（ESRCH）/ 无实例记录 → 跳过，释放照常', async () => {
    await registerHolder('inst-dead', 999_999);
    const wu1 = await createTimedOut('inst-dead');
    const wu2 = await createTimedOut('inst-no-record');

    const handled = await scanTimedOutWorkUnits(fileStore);

    expect(handled).toBe(2);
    expect((await wuService.getById(wu1.id))!.status).toBe('unassigned');
    expect((await wuService.getById(wu2.id))!.status).toBe('unassigned');
  });

  it('pid 复用兜底：/proc 启动时间与实例 startedAt 偏差过大 → 不杀', async () => {
    const holder = spawnHolder();
    // 实例记录声称 2020 年启动 —— 与实际进程启动时间偏差远超容忍窗 → 判定 pid 复用，不杀
    await registerHolder('inst-stale', holder.pid!, '2020-01-01T00:00:00.000Z');
    const wu = await createTimedOut('inst-stale');

    await scanTimedOutWorkUnits(fileStore);

    expect((await wuService.getById(wu.id))!.status).toBe('unassigned');
    expect(() => process.kill(holder.pid!, 0)).not.toThrow(); // 进程未被误杀
  });
});
