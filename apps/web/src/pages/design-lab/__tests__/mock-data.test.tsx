// Design Lab mock 数据 smoke test：覆盖任务要求的全部消息类型与链路数据
import { describe, it, expect } from 'vitest';
import {
  labChannels,
  labMessages,
  labRequirements,
  labWorkUnits,
  labTokenStat,
  findWorkUnit,
  findRequirement,
} from '../mock-data';

describe('design-lab mock-data', () => {
  it('channels include unread counts and agent presence', () => {
    expect(labChannels.length).toBeGreaterThanOrEqual(4);
    expect(labChannels.some((c) => c.unread > 0)).toBe(true);
    expect(labChannels.every((c) => c.agentsOnline <= c.agentsTotal)).toBe(true);
  });

  it('messages cover all required card types', () => {
    const types = new Set(labMessages.map((m) => m.cardType));
    for (const t of ['text', 'requirement', 'progress', 'need_input', 'approval', 'done']) {
      expect(types.has(t as never)).toBe(true);
    }
    // NEED_INPUT 卡带问题与等待标记；进度卡带知识命中
    expect(labMessages.some((m) => m.cardType === 'need_input' && m.waitingForInput && m.question)).toBe(true);
    expect(labMessages.some((m) => m.cardType === 'progress' && (m.knowledgeHits ?? 0) > 0)).toBe(true);
    // 线程：存在 workUnit 锚点与 replyTo 回复
    expect(labMessages.some((m) => m.workUnitId && !m.replyToId)).toBe(true);
    expect(labMessages.some((m) => m.replyToId === 'm-07')).toBe(true);
  });

  it('REQ-0042 chain has 3 work units with varied status', () => {
    const req = findRequirement('REQ-0042');
    expect(req).toBeTruthy();
    expect(req!.workUnitIds).toHaveLength(3);
    const statuses = new Set(req!.workUnitIds.map((id) => findWorkUnit(id)!.status));
    expect(statuses.has('running')).toBe(true);
    expect(statuses.has('blocked')).toBe(true);
    expect(statuses.has('pending')).toBe(true);
  });

  it('token stat carries injected/total and red line comparison', () => {
    expect(labTokenStat.injected).toBeLessThan(labTokenStat.total);
    expect(labTokenStat.overheadRatio).toBeLessThan(labTokenStat.redLine);
    expect(labTokenStat.redLine).toBe(1.2);
    expect(labWorkUnits.every((w) => w.tokens.injected <= w.tokens.total)).toBe(true);
  });
});
