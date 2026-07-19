/**
 * rollup tests — REQ 状态汇总的事件接线（vision §5.3）
 * initRequirementRollup 订阅 workunit.status_changed → maybeRollUpToDone
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { eventBus } from '@dommaker/studio-shared';
import { initRequirementRollup } from '../rollup.js';
import type { RequirementService } from '../requirement.service.js';

function makeService(result = true) {
  return { maybeRollUpToDone: vi.fn().mockResolvedValue(result) } as unknown as RequirementService & {
    maybeRollUpToDone: ReturnType<typeof vi.fn>;
  };
}

async function flush() {
  await new Promise(resolve => setImmediate(resolve));
  await new Promise(resolve => setImmediate(resolve));
}

afterEach(() => {
  eventBus.unsubscribeAll?.('workunit.status_changed');
});

describe('initRequirementRollup', () => {
  it('forwards workunit.status_changed with reqId to maybeRollUpToDone', async () => {
    const svc = makeService();
    const off = initRequirementRollup(svc);
    eventBus.publish('workunit.status_changed', { workunit: { id: 'wu-1', reqId: 'REQ-0001' } });
    await flush();
    expect(svc.maybeRollUpToDone).toHaveBeenCalledWith('REQ-0001');
    off();
  });

  it('ignores events without reqId', async () => {
    const svc = makeService();
    const off = initRequirementRollup(svc);
    eventBus.publish('workunit.status_changed', { workunit: { id: 'wu-2', reqId: null } });
    eventBus.publish('workunit.status_changed', { workunit: { id: 'wu-3' } });
    await flush();
    expect(svc.maybeRollUpToDone).not.toHaveBeenCalled();
    off();
  });

  it('unbind function detaches the handler', async () => {
    const svc = makeService();
    const off = initRequirementRollup(svc);
    off();
    eventBus.publish('workunit.status_changed', { workunit: { id: 'wu-4', reqId: 'REQ-0002' } });
    await flush();
    expect(svc.maybeRollUpToDone).not.toHaveBeenCalled();
  });

  it('swallows service errors (best-effort)', async () => {
    const svc = { maybeRollUpToDone: vi.fn().mockRejectedValue(new Error('boom')) } as unknown as RequirementService;
    const off = initRequirementRollup(svc);
    expect(() => eventBus.publish('workunit.status_changed', { workunit: { reqId: 'REQ-0003' } })).not.toThrow();
    await flush();
    off();
  });
});
