/**
 * #464：无频道 in_review 收件箱订阅（in-review-inbox.ts）契约测试。
 * 告警出口 dispatchMonitorAlerts mock（同 analysis-handoff.test.ts 模式）；
 * 真实 FileStore（tmpdir）+ 真实 WorkUnitService 驱动 status_changed。
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';

const { mockDispatch } = vi.hoisted(() => ({ mockDispatch: vi.fn() }));

vi.mock('../../agents/monitor/monitor-alerts.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../agents/monitor/monitor-alerts.js')>();
  return { ...actual, dispatchMonitorAlerts: (...args: unknown[]) => mockDispatch(...args) };
});

import { initInReviewInbox } from '../in-review-inbox.js';
import { WorkUnitService } from '../workunit.service.js';

let tmpDir: string;
let fileStore: FileStore;
let service: WorkUnitService;

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'in-review-inbox-test-'));
  fileStore = new FileStore(tmpDir);
  service = new WorkUnitService(fileStore);
  initInReviewInbox();
  initInReviewInbox(); // 幂等：重复 init 不叠加订阅
});

beforeEach(() => {
  mockDispatch.mockClear();
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 建 active WU 并迁入 in_review（走真实 status_changed 发射） */
async function transitToInReview(input: Parameters<WorkUnitService['create']>[0]) {
  const wu = await service.create({ ...input, status: 'active' });
  await service.transitionStatus(wu.id, 'in_review');
  return wu;
}

describe('#464 无频道 in_review 收件箱', () => {
  it('无频道 task 进 in_review → 收件箱告警（warning + relatedTaskIds 带 wuId）', async () => {
    const wu = await transitToInReview({ scope: '无频道评审单', type: 'task' });

    expect(mockDispatch).toHaveBeenCalledTimes(1);
    const [alerts] = mockDispatch.mock.calls[0];
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({
      source: 'in_review_orphan', // 与 #181 review_stagnation 滞留探针区分（review 修复）
      level: 'warning',
      relatedTaskIds: [wu.id],
      subject: wu.id,
    });
    expect(alerts[0].message).toContain('无频道');
  });

  it('analysis 类型不走本路径（analysis-handoff 既有收件箱，不重复出声）', async () => {
    await transitToInReview({ scope: '分析单', type: 'analysis' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('有频道 in_review → 不出声（频道内既有确认引导）', async () => {
    const now = new Date().toISOString();
    await fileStore.createChannel({
      id: 'ch-ir', name: '#ir', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null, members: '[]',
      createdAt: now, updatedAt: now,
    });
    await transitToInReview({ scope: '有频道评审单', type: 'task', channelId: 'ch-ir' });
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('迁入非 in_review 状态 → 不出声', async () => {
    const wu = await service.create({ scope: '普通单', type: 'task', status: 'unassigned' });
    await service.transitionStatus(wu.id, 'active');
    expect(mockDispatch).not.toHaveBeenCalled();
  });
});
