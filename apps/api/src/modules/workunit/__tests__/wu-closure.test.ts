// #176（决策 #62 §3 双出声原则）：closeWorkUnitWithNotice —— 系统推 WU 向终态（closed）
// 的统一出口测试：closed 快照 + workunit:closed 结构化事件 + 频道说明，三件套缺一不可。
// 约定与 waiting-input.test.ts 一致：真实 FileStore（tmpdir）+ 真实 WorkUnitService。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { FileStore, type ChannelMessageData } from '@dommaker/studio-shared';
import { WorkUnitService } from '../workunit.service.js';
import { closeWorkUnitWithNotice } from '../wu-closure.js';
import { buildDeadLetterNotice } from '../blocked-cta.js';

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let channelId: string;
let studioEventsFile: string;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-closure-test-'));
  studioEventsFile = path.join(tmpDir, 'studio-events.jsonl');
  process.env.STUDIO_EVENTS_FILE = studioEventsFile;
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  channelId = `ch-closure-${Date.now()}`;
  await fileStore.createChannel({
    id: channelId, name: '#closure-test', type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null, members: '[]',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
});

afterEach(() => {
  delete process.env.STUDIO_EVENTS_FILE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

async function createBlockedWu() {
  const wu = await wuService.create({
    scope: '死信任务', channelId, type: 'task', status: 'active', assigneeId: 'inst-1',
    metadata: { title: '死信任务' },
  });
  await wuService.transitionStatus(wu.id, 'blocked');
  await wuService.update(wu.id, {
    metadata: { title: '死信任务', blockReason: 'stuck: 连续 3 步无进展', blockedAt: new Date().toISOString() },
  });
  const anchor: ChannelMessageData = {
    id: uuidv4(), channelId, authorType: 'human', agentName: null,
    content: '@agent 死信任务', replyToId: null, meta: '{}',
    workUnitId: wu.id, createdAt: new Date().toISOString(),
  };
  await fileStore.appendMessage(channelId, anchor);
  const snapshot = (await fileStore.getIndex()).find(s => s.id === wu.id)!;
  return { wu, snapshot, anchor };
}

function readStudioEvents(): Array<{ type: string; payload: string; level?: string }> {
  if (!fs.existsSync(studioEventsFile)) return [];
  return fs.readFileSync(studioEventsFile, 'utf8')
    .split('\n').filter(Boolean)
    .map(line => JSON.parse(line));
}

describe('closeWorkUnitWithNotice（双出声统一出口）', () => {
  it('closed 快照 + workunit:closed 事件（含 reason/closedBy/blockedAt）+ 频道死信通知', async () => {
    const { wu, snapshot, anchor } = await createBlockedWu();
    const message = buildDeadLetterNotice('死信任务', 'stuck: 连续 3 步无进展');

    const ok = await closeWorkUnitWithNotice(fileStore, snapshot, {
      reason: 'blocked 超 24h 无人工介入，自动关闭',
      closedBy: 'auto-abandon-stale-blocked',
      message,
    });

    expect(ok).toBe(true);
    // 1) 快照：status=closed + completedAt
    const after = (await fileStore.getIndex()).find(s => s.id === wu.id)!;
    expect(after.status).toBe('closed');
    expect(after.completedAt).toBeTruthy();
    // 2) 结构化事件：type/level/payload 三要素
    const events = readStudioEvents()
      .filter(e => e.type === 'workunit:closed')
      .map(e => ({ ...e, payload: JSON.parse(e.payload) }));
    expect(events).toHaveLength(1);
    expect(events[0].level).toBe('warning');
    expect(events[0].payload).toMatchObject({
      workUnitId: wu.id,
      reason: 'blocked 超 24h 无人工介入，自动关闭',
      closedBy: 'auto-abandon-stale-blocked',
    });
    expect(typeof events[0].payload.blockedAt).toBe('string');
    // 3) 频道出声：死信模板（已关闭 + 后续出路），挂在 anchor 线程
    const messages = await fileStore.queryMessages(channelId, { workUnitId: wu.id });
    const notice = messages.find(m => m.content.includes('已自动关闭'));
    expect(notice).toBeDefined();
    expect(notice!.content).toContain('如需继续请重新派发');
    expect(notice!.content).toContain('stuck: 连续 3 步无进展'); // 失败原因摘要
    expect(notice!.authorType).toBe('agent');
    expect(notice!.replyToId).toBe(anchor.id);
  });

  it('WU 无频道 → 快照 + 事件仍落，仅跳过频道出声', async () => {
    const wu = await wuService.create({ scope: '无频道任务', type: 'task', status: 'active', assigneeId: 'inst-1' });
    await wuService.transitionStatus(wu.id, 'blocked');
    const snapshot = (await fileStore.getIndex()).find(s => s.id === wu.id)!;

    const ok = await closeWorkUnitWithNotice(fileStore, snapshot, {
      reason: '执行超过 2.5h，系统强制关闭',
      closedBy: 'total-time-kill',
    });

    expect(ok).toBe(true);
    expect((await fileStore.getIndex()).find(s => s.id === wu.id)!.status).toBe('closed');
    const events = readStudioEvents().filter(e => e.type === 'workunit:closed');
    expect(events).toHaveLength(1);
  });
});
