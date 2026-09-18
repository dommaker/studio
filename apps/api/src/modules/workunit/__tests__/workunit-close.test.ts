// #550：WorkUnitService.close —— 系统侧关闭唯一入口（状态机单口 + 统一落库尾部）。
// 覆盖票体 AC：三件套（closed 快照 + workunit:closed 结构化事件 + 频道说明）行为不变、
// 系统关闭补发 workunit.status_changed、decision/spec 状态机拒绝、已 closed 幂等、父聚合。
// 约定与 wu-closure.test.ts 一致：真实 FileStore（tmpdir）+ 真实 WorkUnitService。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { FileStore, eventBus, type ChannelMessageData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitData } from '../workunit.service.js';
import { buildDeadLetterNotice } from '../blocked-cta.js';

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let channelId: string;
let studioEventsFile: string;
let statusEvents: WorkUnitData[];
let statusHandler: (payload: { workunit: WorkUnitData }) => void;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-close-test-'));
  studioEventsFile = path.join(tmpDir, 'studio-events.jsonl');
  process.env.STUDIO_EVENTS_FILE = studioEventsFile;
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  channelId = `ch-close-${Date.now()}`;
  await fileStore.createChannel({
    id: channelId, name: '#close-test', type: 'rnd',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null, members: '[]',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  });
  statusEvents = [];
  statusHandler = (payload) => { statusEvents.push(payload.workunit); };
  eventBus.subscribe('workunit.status_changed', statusHandler);
});

afterEach(() => {
  eventBus.unsubscribe('workunit.status_changed', statusHandler);
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
  return { wu, anchor };
}

function readStudioEvents(): Array<{ type: string; payload: string; level?: string }> {
  if (!fs.existsSync(studioEventsFile)) return [];
  return fs.readFileSync(studioEventsFile, 'utf8')
    .split('\n').filter(Boolean)
    .map(line => JSON.parse(line));
}

const flushAsync = () => new Promise(r => setTimeout(r, 50));

describe('WorkUnitService.close（#550 系统侧关闭唯一入口）', () => {
  it('blocked WU：closed 快照 + workunit:closed 事件（含 reason/closedBy/blockedAt）+ 频道死信通知 + status_changed 广播', async () => {
    const { wu, anchor } = await createBlockedWu();
    const message = buildDeadLetterNotice('死信任务', 'stuck: 连续 3 步无进展');
    statusEvents.length = 0;

    const closed = await wuService.close(wu.id, {
      reason: 'blocked 超 24h 无人工介入，自动关闭',
      closedBy: 'auto-abandon-stale-blocked',
      message,
    });

    expect(closed.status).toBe('closed');
    // 1) 快照：status=closed + completedAt/closedAt 同刻落锚
    const after = (await fileStore.getIndex()).find(s => s.id === wu.id)!;
    expect(after.status).toBe('closed');
    expect(after.completedAt).toBeTruthy();
    expect(after.closedAt).toBe(after.completedAt);
    // 2) 结构化事件：type/level/payload 三要素（payload 形态与 wu-closure 时代一致）
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
    expect(notice!.content).toContain('stuck: 连续 3 步无进展');
    expect(notice!.authorType).toBe('agent');
    expect(notice!.replyToId).toBe(anchor.id);
    // 4) status_changed 广播（#550：系统关闭与手工关闭同权，前端列表/REQ rollup/inspection-scan 实时收 closed）
    const broadcast = statusEvents.find(e => e.id === wu.id && e.status === 'closed');
    expect(broadcast).toBeDefined();
  });

  it('active WU 无频道（total-time-kill 形态）：快照 + 事件仍落，跳过频道出声；无 blockedAt 时 payload 不带该键', async () => {
    const wu = await wuService.create({ scope: '超时任务', type: 'task', status: 'active', assigneeId: 'inst-1' });

    const closed = await wuService.close(wu.id, {
      reason: '执行超过 2.5h，系统强制关闭',
      closedBy: 'total-time-kill',
    });

    expect(closed.status).toBe('closed');
    expect((await fileStore.getIndex()).find(s => s.id === wu.id)!.status).toBe('closed');
    const events = readStudioEvents()
      .filter(e => e.type === 'workunit:closed')
      .map(e => ({ ...e, payload: JSON.parse(e.payload) }));
    expect(events).toHaveLength(1);
    expect(events[0].payload.closedBy).toBe('total-time-kill');
    expect(events[0].payload.blockedAt).toBeUndefined();
    expect(statusEvents.some(e => e.id === wu.id && e.status === 'closed')).toBe(true);
  });

  it('decision/spec 裁剪状态机无 closed → close() 抛 Invalid status transition，状态不变、零事件', async () => {
    const wu = await wuService.create({ scope: '决策单', channelId, type: 'decision', status: 'active' });
    await wuService.transitionStatus(wu.id, 'blocked');
    statusEvents.length = 0;

    await expect(wuService.close(wu.id, { reason: '人类关闭指令', closedBy: 'human-command' }))
      .rejects.toThrow('Invalid status transition: blocked → closed');

    const after = (await fileStore.getIndex()).find(s => s.id === wu.id)!;
    expect(after.status).toBe('blocked');
    expect(readStudioEvents().filter(e => e.type === 'workunit:closed')).toHaveLength(0);
    expect(statusEvents.find(e => e.id === wu.id)).toBeUndefined();
  });

  it('幂等：已 closed 的 WU 再 close() 直返现状，不重复发事件/广播/频道出声', async () => {
    const { wu } = await createBlockedWu();
    await wuService.close(wu.id, { reason: '首次关闭', closedBy: 'auto-abandon-stale-blocked' });
    statusEvents.length = 0;
    const messagesBefore = (await fileStore.queryMessages(channelId, { workUnitId: wu.id })).length;

    const again = await wuService.close(wu.id, { reason: '重复关闭', closedBy: 'auto-abandon-stale-blocked' });

    expect(again.status).toBe('closed');
    expect(readStudioEvents().filter(e => e.type === 'workunit:closed')).toHaveLength(1);
    expect(statusEvents.find(e => e.id === wu.id)).toBeUndefined();
    expect((await fileStore.queryMessages(channelId, { workUnitId: wu.id })).length).toBe(messagesBefore);
  });

  it('不存在的 WU → 抛 WorkUnit not found', async () => {
    await expect(wuService.close('no-such-wu', { reason: 'x', closedBy: 'human-command' }))
      .rejects.toThrow('WorkUnit not found');
  });

  it('父聚合：子 WU 经 close() 关闭后父状态按既有规则聚合（全子 closed → 父 closed）', async () => {
    const parent = await wuService.create({ scope: '父单', type: 'task', status: 'active' });
    const child = await wuService.create({ scope: '子单', type: 'task', status: 'active', parentId: parent.id });

    await wuService.close(child.id, { reason: '系统关闭', closedBy: 'total-time-kill' });
    await flushAsync(); // aggregateParentStatus 是 fire-and-forget（同 transitionStatus 先例）

    const parentAfter = (await fileStore.getIndex()).find(s => s.id === parent.id)!;
    expect(parentAfter.status).toBe('closed');
  });
});
