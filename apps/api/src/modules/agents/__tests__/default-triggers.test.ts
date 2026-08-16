// AC-4: Default Trigger registration tests
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerDefaultTriggers } from '../default-triggers';
import { TriggerScheduler } from '../../triggers/trigger-scheduler';

describe('Default Triggers', () => {
  let registry: TriggerScheduler;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new TriggerScheduler({ store: null });
  });

  const registeredIds = (): string[] => registry.getStates().map(s => s.config.id);

  it('registers 8 default triggers (6 retained + #163 inspection-scan 双通道)', () => {
    registerDefaultTriggers(registry);

    expect(registeredIds()).toHaveLength(8);
  });

  it('retained triggers are registered', () => {
    registerDefaultTriggers(registry);

    expect(registeredIds()).toEqual(expect.arrayContaining([
      'workunit-timeout',
      'agent-timeout',
      'okr-metric-sync',
      'workunit-input-reminder',
      'evolution-daily-scan',
      'doc-semantic-review',
      'inspection-scan',
      'inspection-scan-schedule',
    ]));
  });

  it('pruned triggers are gone', () => {
    registerDefaultTriggers(registry);

    const ids = registeredIds();
    expect(ids).not.toContain('knowledge-quality-audit');
    expect(ids).not.toContain('session-knowledge-extraction');
    expect(ids).not.toContain('zero-consumption-audit');
    expect(ids).not.toContain('knowledge-synthesis');
  });

  it('does not register stale-recovery handler (stale-recovery was dead code)', () => {
    const spy = vi.spyOn(registry, 'registerExecuteHandler');
    registerDefaultTriggers(registry);

    // Bug 3 fix: stale-recovery handler was dead code (UPDATE action doesn't call EXECUTE handlers)
    const staleCalls = spy.mock.calls.filter((c: any) => c[0] === 'stale-recovery');
    expect(staleCalls).toHaveLength(0);
  });

  it('workunit-timeout fires every 5 minutes', () => {
    registerDefaultTriggers(registry);

    const timeoutCall = registry.getStates().find(s => s.config.id === 'workunit-timeout');
    expect(timeoutCall).toBeDefined();
    expect(timeoutCall!.config.condition).toEqual(
      expect.objectContaining({ type: 'SCHEDULE', cron: '*/5 * * * *' }),
    );
    // P0 修复：UPDATE + 注册时冻结的 timeoutAt 查询永不命中 —— 改为 EXECUTE handler
    // （workunit-timeout-scan 每次 tick 现算基准时间，释放回池 + 频道系统消息 + ≥3 次 blocked）
    expect(timeoutCall!.config.action).toEqual(
      expect.objectContaining({ type: 'EXECUTE', target: 'workunit-timeout-scan' }),
    );
  });

  it('workunit-input-reminder fires every 5 minutes (F5)', () => {
    registerDefaultTriggers(registry);

    const reminderCall = registry.getStates().find(s => s.config.id === 'workunit-input-reminder');
    expect(reminderCall).toBeDefined();
    expect(reminderCall!.config.condition).toEqual(
      expect.objectContaining({ type: 'SCHEDULE', cron: '*/5 * * * *' }),
    );
    expect(reminderCall!.config.action).toEqual(
      expect.objectContaining({ type: 'EXECUTE', target: 'workunit-input-reminder-scan' }),
    );
  });

  it('agent-timeout fires every 2 minutes', () => {
    registerDefaultTriggers(registry);

    const timeoutCall = registry.getStates().find(s => s.config.id === 'agent-timeout');
    expect(timeoutCall).toBeDefined();
    expect(timeoutCall!.config.condition).toEqual(
      expect.objectContaining({ type: 'SCHEDULE', cron: '*/2 * * * *' }),
    );
    expect(timeoutCall!.config.action).toEqual(
      expect.objectContaining({ type: 'EXECUTE', target: 'agent-timeout-scan' }),
    );
  });

  it('doc-semantic-review fires weekly Friday 9:47 and creates WorkUnit', () => {
    registerDefaultTriggers(registry);

    const reviewCall = registry.getStates().find(s => s.config.id === 'doc-semantic-review');
    expect(reviewCall).toBeDefined();
    expect(reviewCall!.config.condition).toEqual(
      expect.objectContaining({ type: 'SCHEDULE', cron: '47 9 * * 5' }),
    );
    expect(reviewCall!.config.action).toEqual(
      expect.objectContaining({
        type: 'CREATE',
        target: 'WorkUnit',
      }),
    );
    expect((reviewCall!.config.action as any).payload.type).toBe('analysis');
    expect((reviewCall!.config.action as any).payload.scope).toContain('README.md');
    expect((reviewCall!.config.action as any).payload.scope).toContain('sync-docs');
    // #162（T8-E1）行为修正：payload 不带 status——「建单落 pending 待人确认」由
    // executeCreateAction 对所有触发器 CREATE 统一落地（按来源不按类型）
    expect((reviewCall!.config.action as any).payload.status).toBeUndefined();
  });

  it('#163（T8-E2）：inspection-scan = EVENT workunit.status_changed + CREATE 巡检单（inspection 标记 + tokenBudget）', () => {
    registerDefaultTriggers(registry);

    const scan = registry.getStates().find(s => s.config.id === 'inspection-scan');
    expect(scan).toBeDefined();
    expect(scan!.config.condition).toEqual(
      expect.objectContaining({ type: 'EVENT', event: 'workunit.status_changed' }),
    );
    const payload = (scan!.config.action as any).payload;
    expect(scan!.config.action).toEqual(expect.objectContaining({ type: 'CREATE', target: 'WorkUnit' }));
    expect(payload.type).toBe('analysis');
    expect(payload.metadata.inspection).toBe(true);
    expect(payload.metadata.tokenBudget).toBeGreaterThan(0);
    // pending 人闸由 executeCreateAction 统一落地，payload 不带 status
    expect(payload.status).toBeUndefined();
    // 默认启用；INSPECTION_SCAN_ENABLED=false 可整体关闭
    expect(scan!.config.enabled).toBe(true);
  });

  it('#163（T8-E2）：inspection-scan-schedule = SCHEDULE 留位默认关闭', () => {
    registerDefaultTriggers(registry);

    const schedule = registry.getStates().find(s => s.config.id === 'inspection-scan-schedule');
    expect(schedule).toBeDefined();
    expect(schedule!.config.condition.type).toBe('SCHEDULE');
    expect(schedule!.config.enabled).toBe(false);
    expect(((schedule!.config.action as any).payload.metadata.inspection)).toBe(true);
  });
});
