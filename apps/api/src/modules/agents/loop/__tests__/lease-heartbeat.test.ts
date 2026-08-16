/**
 * #178（#63 决议 1/2，2026-08-16）lease-heartbeat 单测：
 * - 持有期间每跳把 timeoutAt 推前为 now+5min（固定 WU_LEASE_TTL_MS，测试注入短间隔）
 * - 易主（unclaim → 他人认领，claimedAt 换代）→ 停跳 + onLost('lost')，zombie 不再覆盖新 holder 租约
 * - WU 被删 → 停跳 + onLost('missing')
 * 真实 FileStore（tmpdir）+ 真实 WorkUnitService（claim/unclaim 产真实 claimedAt 令牌）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, WU_LEASE_TTL_MS } from '../../../workunit/workunit.service.js';
import { startLeaseHeartbeat } from '../lease-heartbeat.js';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let channelId: string;
const stoppers: Array<() => void> = [];

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-heartbeat-'));
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  channelId = `ch-lease-hb-${Date.now()}`;
  await fileStore.createChannel({
    id: channelId, name: '#lease-hb-test', type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null, members: '[]',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
});

afterEach(() => {
  for (const stop of stoppers) stop();
  stoppers.length = 0;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createClaimed(assigneeId: string) {
  const wu = await wuService.create({
    scope: '租约心跳任务', type: 'task', channelId,
    status: 'unassigned', // #126：task 默认落 pending（不可认领），显式置 unassigned
  });
  return wuService.claim(wu.id, assigneeId);
}

function startHeartbeat(claimed: Awaited<ReturnType<typeof createClaimed>>, onLost: (reason: 'lost' | 'missing') => void) {
  const stop = startLeaseHeartbeat({
    fileStore, wuId: claimed.id, assigneeId: 'inst-1',
    claimedAt: claimed.claimedAt!.toISOString(),
    onLost, intervalMs: 40,
  });
  stoppers.push(stop);
  return stop;
}

describe('#178: startLeaseHeartbeat（30s 心跳推 timeoutAt=now+5min）', () => {
  it('持有期间每跳推前 timeoutAt（固定 5min TTL）', async () => {
    const claimed = await createClaimed('inst-1');
    const initial = claimed.timeoutAt!.getTime();

    startHeartbeat(claimed, () => {});
    await sleep(150);

    const after = (await wuService.getById(claimed.id))!;
    // 心跳多跳后 timeoutAt 被推到「此刻 +5min」量级（显著晚于 claim 时的初值）
    expect(after.timeoutAt!.getTime()).toBeGreaterThan(initial);
    expect(after.timeoutAt!.getTime()).toBeGreaterThanOrEqual(Date.now() + WU_LEASE_TTL_MS - 5_000);
  });

  it('易主（unclaim → 他人认领）→ onLost(lost) 且停跳，zombie 不再覆盖新 holder 租约', async () => {
    const claimed = await createClaimed('inst-1');
    const onLost = vi.fn();
    startHeartbeat(claimed, onLost);

    // 超时释放 → 新 holder 认领（claimedAt 换代）
    await wuService.unclaim(claimed.id);
    const reclaimed = await wuService.claim(claimed.id, 'inst-2');
    await sleep(150);

    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith('lost');

    // zombie 已停跳：新 holder 的租约值不被旧 holder 推高
    const leaseAfterSteal = (await wuService.getById(claimed.id))!.timeoutAt!.toISOString();
    expect(leaseAfterSteal).toBe(reclaimed.timeoutAt!.toISOString());
    await sleep(120);
    expect((await wuService.getById(claimed.id))!.timeoutAt!.toISOString()).toBe(leaseAfterSteal);
  });

  it('WU 被删 → onLost(missing)', async () => {
    const claimed = await createClaimed('inst-1');
    const onLost = vi.fn();
    startHeartbeat(claimed, onLost);

    await wuService.delete(claimed.id);
    await sleep(150);

    expect(onLost).toHaveBeenCalledTimes(1);
    expect(onLost).toHaveBeenCalledWith('missing');
  });
});
