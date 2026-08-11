// P0 修复（WU 超时机制 a/d）：
// - claim 进入 active 时写入 timeoutAt（按 type 默认时长；metadata.timeoutAt 显式值优先；已有列值不动）
// - scanTimedOutWorkUnits：超时 → 释放回 unassigned + metadata 记录 + 频道系统消息；≥3 次 → blocked
// 约定与 waiting-input.test.ts 一致：真实 FileStore（tmpdir）+ 真实 WorkUnitService
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import { WorkUnitService, WU_TIMEOUT_MINUTES, type WorkUnitMetadata } from '../workunit.service.js';
import { parseWuMetadata } from '../wu-metadata.js';
import { scanTimedOutWorkUnits, MAX_TIMEOUT_RELEASES } from '../timeout-release.js';

const { mockPostWuSystemMessage } = vi.hoisted(() => ({ mockPostWuSystemMessage: vi.fn() }));

// wu-messenger 间谍包装：真实发送保留（消息断言不受影响），另断言委托参数（milestone 等）
vi.mock('../wu-messenger.js', async (importOriginal) => {
  const orig = await importOriginal() as { postWuSystemMessage: (...args: unknown[]) => Promise<unknown> };
  mockPostWuSystemMessage.mockImplementation(orig.postWuSystemMessage);
  return { ...orig, postWuSystemMessage: mockPostWuSystemMessage };
});

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let channelId: string;

beforeEach(async () => {
  mockPostWuSystemMessage.mockClear(); // 清调用记录（保留间谍包装的实现）
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'workunit-timeout-test-'));
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  channelId = `ch-timeout-${Date.now()}`;
  await fileStore.createChannel({
    id: channelId, name: '#timeout-test', type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null, members: '[]',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('P0: claim 写入 timeoutAt', () => {
  it('task/bug/feature → 60 分钟；review/analysis → 30 分钟', async () => {
    const before = Date.now();
    for (const [type, minutes] of Object.entries(WU_TIMEOUT_MINUTES)) {
      const wu = await wuService.create({ scope: `${type} 任务`, type, channelId });
      const claimed = await wuService.claim(wu.id, 'instance-1');
      expect(claimed.status).toBe('active');
      expect(claimed.timeoutAt).not.toBeNull();
      const deltaMs = claimed.timeoutAt!.getTime() - before;
      // 容忍执行耗时：落在 [minutes, minutes+1min] 区间
      expect(deltaMs).toBeGreaterThanOrEqual(minutes * 60_000);
      expect(deltaMs).toBeLessThanOrEqual(minutes * 60_000 + 60_000);
    }
  });

  it('metadata.timeoutAt 显式值优先于默认时长', async () => {
    const explicit = '2026-08-01T00:00:00.000Z';
    const wu = await wuService.create({
      scope: '显式超时任务', type: 'task', channelId,
      metadata: { timeoutAt: explicit },
    });
    const claimed = await wuService.claim(wu.id, 'instance-1');
    expect(claimed.timeoutAt!.toISOString()).toBe(explicit);
  });

  it('已有 timeoutAt 列值时 claim 不覆盖', async () => {
    const preset = new Date(Date.now() + 5 * 60_000);
    const wu = await wuService.create({
      scope: '预设超时任务', type: 'task', channelId,
      timeoutAt: preset,
    });
    const claimed = await wuService.claim(wu.id, 'instance-1');
    expect(claimed.timeoutAt!.toISOString()).toBe(preset.toISOString());
  });
});

describe('P0: scanTimedOutWorkUnits（workunit-timeout-scan handler）', () => {
  /** 创建 active + 已超时的 WU */
  async function createTimedOutWorkUnit(metadata: WorkUnitMetadata = {}) {
    const wu = await wuService.create({
      scope: '超时任务', type: 'task', channelId,
      status: 'active', assigneeId: 'instance-1',
      timeoutAt: new Date(Date.now() - 60_000), // 1 分钟前已超时
      metadata,
    });
    return wu;
  }

  it('超时 WU 释放回 unassigned：清 assigneeId/timeoutAt、记 metadata、频道发系统消息', async () => {
    const wu = await createTimedOutWorkUnit();

    const handled = await scanTimedOutWorkUnits(fileStore);
    expect(handled).toBe(1);

    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('unassigned');
    expect(after.assigneeId).toBeNull();
    expect(after.timeoutAt).toBeNull();
    const meta: WorkUnitMetadata = JSON.parse(after.metadata!);
    expect(meta.timeoutReleaseCount).toBe(1);
    expect(typeof meta.timeoutReleasedAt).toBe('string');

    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    expect(messages).toHaveLength(1);
    expect(messages[0].authorType).toBe('agent');
    expect(messages[0].agentName).toBe('Studio');
    expect(messages[0].content).toContain('超时');
    expect(messages[0].content).toContain('释放回任务池');
    // 释放回池非「需要人看」里程碑：委托 wu-messenger 时不带 milestone 标记（2026-07 §6-3）
    const releaseCall = mockPostWuSystemMessage.mock.calls.find(c => String(c[1]).includes('释放回任务池'));
    expect(releaseCall).toBeDefined();
    expect(releaseCall![0]).toEqual(expect.objectContaining({ id: wu.id }));
    expect(releaseCall![2].milestone).toBeUndefined();
    expect(releaseCall![2]).toEqual(expect.objectContaining({ fileStore }));
  });

  it('#108: decision 单不进超时扫描（可能等关键人多天）；spec/task 仍正常处理', async () => {
    const decision = await wuService.create({
      scope: '决策单', type: 'decision', channelId,
      status: 'active', assigneeId: 'instance-1',
      timeoutAt: new Date(Date.now() - 60_000),
    });
    const spec = await wuService.create({
      scope: '成文单', type: 'spec', channelId,
      status: 'active', assigneeId: 'instance-1',
      timeoutAt: new Date(Date.now() - 60_000),
    });
    const task = await createTimedOutWorkUnit();

    const handled = await scanTimedOutWorkUnits(fileStore);
    expect(handled).toBe(2); // spec + task，decision 跳过

    // decision 单原样保留：状态/认领/timeoutAt 均不动，metadata 无释放记录
    const after = (await wuService.getById(decision.id))!;
    expect(after.status).toBe('active');
    expect(after.assigneeId).toBe('instance-1');
    expect(after.timeoutAt).not.toBeNull();
    expect(parseWuMetadata(after.metadata).timeoutReleaseCount).toBeUndefined();

    // spec/task 正常释放回池
    for (const id of [spec.id, task.id]) {
      expect((await wuService.getById(id))!.status).toBe('unassigned');
    }

    // decision 单不发超时系统消息
    const decisionMsgs = await fileStore.queryMessages(channelId, { workUnitId: decision.id });
    expect(decisionMsgs).toHaveLength(0);
  });

  it('未超时 / 非 active 的 WU 不受影响', async () => {
    // 未来才超时
    await wuService.create({
      scope: '未超时任务', type: 'task', channelId,
      status: 'active', assigneeId: 'instance-1',
      timeoutAt: new Date(Date.now() + 3_600_000),
    });
    // 已超时但 status=unassigned（无人认领）
    await wuService.create({
      scope: '未认领任务', type: 'task', channelId,
      status: 'unassigned',
      timeoutAt: new Date(Date.now() - 60_000),
    });
    // active 但无 timeoutAt（历史数据）
    await wuService.create({
      scope: '无超时字段任务', type: 'task', channelId,
      status: 'active', assigneeId: 'instance-1',
    });

    const handled = await scanTimedOutWorkUnits(fileStore);
    expect(handled).toBe(0);

    const messages = await fileStore.queryMessages(channelId, {});
    expect(messages).toHaveLength(0);
  });

  it(`释放次数达到 ${MAX_TIMEOUT_RELEASES} → blocked 且频道说明，不再回池`, async () => {
    const wu = await createTimedOutWorkUnit({ timeoutReleaseCount: MAX_TIMEOUT_RELEASES - 1 });

    const handled = await scanTimedOutWorkUnits(fileStore);
    expect(handled).toBe(1);

    const after = (await wuService.getById(wu.id))!;
    expect(after.status).toBe('blocked');
    const meta: WorkUnitMetadata = JSON.parse(after.metadata!);
    expect(meta.timeoutReleaseCount).toBe(MAX_TIMEOUT_RELEASES);

    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    expect(messages).toHaveLength(1);
    expect(messages[0].agentName).toBe('Studio');
    expect(messages[0].content).toContain('blocked');
    expect(messages[0].content).toContain('人工介入');
    // 2026-07 PMO-flow UX（§6-3）：blocked 转人工 → 以里程碑消息委托 wu-messenger
    expect(mockPostWuSystemMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: wu.id }),
      expect.stringContaining('人工介入'),
      expect.objectContaining({ milestone: true, fileStore }),
    );
  });

  it('释放后可重新认领并获得新的 timeoutAt', async () => {
    const wu = await createTimedOutWorkUnit();
    await scanTimedOutWorkUnits(fileStore);

    const reclaimed = await wuService.claim(wu.id, 'instance-2');
    expect(reclaimed.status).toBe('active');
    expect(reclaimed.timeoutAt).not.toBeNull();
    expect(reclaimed.timeoutAt!.getTime()).toBeGreaterThan(Date.now());
  });
});
