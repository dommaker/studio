/**
 * WorkUnitService 状态变化事件补齐单测
 *  - claim（unassigned → active）发 workunit.status_changed
 *  - unclaim（→ unassigned）发 workunit.status_changed
 *  - reviewRejected（in_review → active）发 workunit.status_changed
 * （此前只有 transitionStatus/reviewPassed 发，前端列表看不到认领/打回）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore, eventBus } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitData } from '../workunit.service.js';

let tmpDir: string;
let fileStore: FileStore;
let wuService: WorkUnitService;
let events: WorkUnitData[];
let handler: (payload: { workunit: WorkUnitData }) => void;

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wu-status-events-'));
  fileStore = new FileStore(tmpDir);
  wuService = new WorkUnitService(fileStore);
  events = [];
  handler = (payload) => { events.push(payload.workunit); };
  eventBus.subscribe('workunit.status_changed', handler);
});

afterEach(() => {
  eventBus.unsubscribe('workunit.status_changed', handler);
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('WorkUnitService 状态变化事件补齐', () => {
  it('claim → 发 status_changed（active + assignee）', async () => {
    const wu = await wuService.create({ scope: '任务', type: 'task', channelId: 'ch-1' });
    const claimed = await wuService.claim(wu.id, 'inst-1');

    expect(claimed.status).toBe('active');
    const evt = events.find(e => e.id === wu.id && e.status === 'active');
    expect(evt).toBeDefined();
    expect(evt!.assigneeId).toBe('inst-1');
  });

  it('unclaim → 发 status_changed（unassigned）', async () => {
    const wu = await wuService.create({ scope: '任务', type: 'task', channelId: 'ch-1' });
    await wuService.claim(wu.id, 'inst-1');
    events.length = 0;

    await wuService.unclaim(wu.id);
    const evt = events.find(e => e.id === wu.id && e.status === 'unassigned');
    expect(evt).toBeDefined();
    expect(evt!.assigneeId).toBeNull();
  });

  it('reviewRejected → 发 status_changed（active 返工）', async () => {
    const wu = await wuService.create({ scope: '任务', type: 'task', channelId: 'ch-1', status: 'active' });
    await wuService.transitionStatus(wu.id, 'in_review');
    events.length = 0;

    await wuService.reviewRejected(wu.id, '打回重做');
    const evt = events.find(e => e.id === wu.id && e.status === 'active');
    expect(evt).toBeDefined();
  });
});
