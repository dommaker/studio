/**
 * #591 B 类：trigger 触发 CREATE/EXECUTE 决策埋点（落 audit-logs 轨）
 *
 * 埋点位置 = TriggerScheduler.executeTrigger 单点（自动 SCHEDULE/EVENT 同路径），
 * traceId 现场生成并透传 executeCreateAction 落 WU metadata.traceId（链路打通）；
 * 依据 = 摘要（triggerName + condition 摘要 + outcome），不落全 payload。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { FileStore, StudioEventBus } from '@dommaker/studio-shared';
import { TriggerScheduler } from '../trigger-scheduler';
import { TriggerStore } from '../trigger-store';
import {
  setTriggerActionFileStore,
  registerExecuteHandler,
  unregisterExecuteHandler,
} from '../trigger-action';
import type { TriggerConfig } from '../trigger.types';

const { decisionSpy } = vi.hoisted(() => ({ decisionSpy: vi.fn() }));
vi.mock('../../audit-logs/agent-decision.js', () => ({ recordAgentDecision: decisionSpy }));

const createTrigger: TriggerConfig = {
  id: 'trig-audit-create',
  name: '巡检建单',
  condition: { type: 'SCHEDULE', cron: '* * * * *' },
  action: { type: 'CREATE', target: 'WorkUnit', payload: { type: 'monitor', scope: '扫描一轮' } },
  enabled: true,
  scope: 'system',
};

const executeTrigger: TriggerConfig = {
  id: 'trig-audit-exec',
  name: '事件执行',
  condition: { type: 'EVENT', event: 'workunit.created' },
  action: { type: 'EXECUTE', target: 'audit-test-handler' },
  enabled: true,
  scope: 'system',
};

describe('trigger 触发决策埋点（#591）', () => {
  let tmpDir: string;
  let fileStore: FileStore;
  let store: TriggerStore;
  let bus: StudioEventBus;
  let scheduler: TriggerScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trigger-audit-'));
    fileStore = new FileStore(tmpDir);
    setTriggerActionFileStore(fileStore);
    store = new TriggerStore(tmpDir);
    bus = new StudioEventBus();
    scheduler = new TriggerScheduler({ store, eventBus: bus });
  });

  afterEach(() => {
    scheduler.dispose();
    bus.clear();
    unregisterExecuteHandler('audit-test-handler');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('SCHEDULE CREATE 触发 → create 行（condition 摘要 + outcome=created + workUnitId），WU metadata 落同一 traceId', async () => {
    store.save(createTrigger);
    scheduler.loadTriggers();

    scheduler.tick(new Date('2026-09-20T10:00:30.000Z'));

    await vi.waitFor(() => expect(decisionSpy).toHaveBeenCalledTimes(1));
    const call = decisionSpy.mock.calls[0][0];
    expect(call).toMatchObject({
      action: 'create',
      resource: 'trigger',
      resourceId: 'trig-audit-create',
      status: 'success',
      details: {
        triggerName: '巡检建单',
        condition: 'cron:* * * * *',
        outcome: 'created',
        workUnitId: expect.any(String),
      },
    });
    expect(typeof call.requestId).toBe('string');
    // traceId 贯穿到建出 WU 的 metadata（与频道链路同一关联键口径）
    const wu = (await fileStore.getIndex()).find(s => s.id === call.details.workUnitId);
    expect(wu).toBeDefined();
    expect(JSON.parse(wu!.metadata!).traceId).toBe(call.requestId);
  });

  it('同分钟去重命中 → outcome=deduped（跨 scheduler 共享数据根的幂等兜底路径）', async () => {
    store.save(createTrigger);
    scheduler.loadTriggers();
    const scheduler2 = new TriggerScheduler({ store });
    scheduler2.loadTriggers();
    const now = new Date('2026-09-20T11:00:30.000Z');

    scheduler.tick(now);
    await vi.waitFor(() => expect(decisionSpy).toHaveBeenCalledTimes(1));
    scheduler2.tick(now); // 另一进程实例：in-memory lastFiredAt 不共享，走落盘去重
    await vi.waitFor(() => expect(decisionSpy).toHaveBeenCalledTimes(2));
    scheduler2.dispose();

    expect(decisionSpy.mock.calls[0][0].details.outcome).toBe('created');
    expect(decisionSpy.mock.calls[1][0].details).toMatchObject({ outcome: 'deduped' });
  });

  it('EVENT EXECUTE 触发 → execute 行（condition=event 摘要 + target）', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    registerExecuteHandler('audit-test-handler', handler);
    scheduler.registerTrigger(executeTrigger);

    bus.publish('workunit.created', { id: 'wu-x' });

    await vi.waitFor(() => expect(decisionSpy).toHaveBeenCalledTimes(1));
    expect(decisionSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'execute',
      resource: 'trigger',
      resourceId: 'trig-audit-exec',
      details: expect.objectContaining({
        triggerName: '事件执行',
        condition: 'event:workunit.created',
        outcome: 'executed',
        target: 'audit-test-handler',
      }),
    }));
  });

  it('动作执行抛错 → status=failure + outcome=error（错误原样上抛不改变既有语义）', async () => {
    registerExecuteHandler('audit-test-handler', vi.fn().mockRejectedValue(new Error('handler boom')));
    scheduler.registerTrigger(executeTrigger);

    bus.publish('workunit.created', { id: 'wu-x' });

    await vi.waitFor(() => expect(decisionSpy).toHaveBeenCalledTimes(1));
    expect(decisionSpy).toHaveBeenCalledWith(expect.objectContaining({
      action: 'execute',
      status: 'failure',
      details: expect.objectContaining({ outcome: 'error', error: 'handler boom' }),
    }));
  });
});
