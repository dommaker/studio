/**
 * SSE 负载 ↔ 契约 wire parity（#665，ADR 2026-08-24 落地）。
 *
 * 用真实发射点构造器产出的负载，经 JSON 序列化 round-trip（= /events/stream wire 形态）
 * 过 packages/studio-contract 的 sseEventSchema 判别联合——锁定「构造器 drift ↔ 契约」双向：
 * 发射点改了形状契约没跟 → 本测试红；契约收严把真实负载拒之门外 → 本测试红。
 *
 * 覆盖可单测的构造器出口：
 * - execution-step-events：buildExecutionStepEvent（Layer A）/ buildExecutionStreamChunks（Layer B）
 * - workunit-crud：snapshotToData（workunit.created/status_changed 桥负载的 WU 快照源）
 * - requirement 桥负载（requirement.service publish 的 { requirement } 信封）
 * channel/agent/notification/knowledge 发射点走类型同源（编译期，见各发射点 import type）。
 */
import { describe, it, expect } from 'vitest';
import { parseStreamEvents } from '@dommaker/studio-shared';
import { sseEventSchema, type SseEventType } from '@dommaker/studio-contract';
import {
  buildExecutionStepEvent,
  buildExecutionStreamChunks,
  EXECUTION_STEP_SSE_TYPE,
  EXECUTION_STREAM_SSE_TYPE,
} from '../../agent-loop/execution-step-events.js';
import { snapshotToData } from '../../workunit/workunit-crud.js';

const TS = '2026-10-08T01:00:00.000Z';

/** 发射点产物的 wire 形态（sse.routes JSON.stringify 后前端收到的样子） */
function wire<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function envelope(eventType: SseEventType, data: unknown) {
  return { event_id: 'e-1', event_type: eventType, timestamp: TS, data: wire(data) };
}

const ASSISTANT_LINE = JSON.stringify({
  type: 'assistant',
  message: {
    content: [
      { type: 'thinking', thinking: '想想怎么改' },
      { type: 'text', text: '开始动手' },
      { type: 'tool_use', id: 'tu-1', name: 'Read', input: { file_path: '/a.ts' } },
    ],
  },
});

describe('agent-loop 执行事件 ↔ 契约 parity', () => {
  it('workunit.execution.step：buildExecutionStepEvent 产物 wire 形态过判别联合', () => {
    const events = parseStreamEvents(
      [ASSISTANT_LINE, JSON.stringify({ type: 'result', result: 'ACTION: progress', usage: { input_tokens: 3, output_tokens: 5 } })].join('\n'),
    );
    const payload = buildExecutionStepEvent({
      workUnitId: 'wu-1', executionId: 'ex-1', channelId: 'ch-1', step: 2,
      action: 'progress', events, skills: ['tdd'], at: TS,
    });
    expect(payload).not.toBeNull();
    const parsed = sseEventSchema.parse(envelope(EXECUTION_STEP_SSE_TYPE, payload));
    if (parsed.event_type !== 'workunit.execution.step') throw new Error('narrow failed');
    expect(parsed.data.workUnitId).toBe('wu-1');
    expect(parsed.data.status).toBe('success');
    expect(parsed.data.toolCalls[0]).toEqual({ tool: 'Read', summary: '/a.ts' });
  });

  it('workunit.execution.step（失败步）：status=failed + errorType/errorDetail 过契约', () => {
    const payload = buildExecutionStepEvent({
      workUnitId: 'wu-1', executionId: 'ex-1', step: 1,
      status: 'failed', errorType: 'execution_failed', errorDetail: 'boom', at: TS,
    });
    const parsed = sseEventSchema.parse(envelope(EXECUTION_STEP_SSE_TYPE, payload));
    if (parsed.event_type !== 'workunit.execution.step') throw new Error('narrow failed');
    expect(parsed.data.status).toBe('failed');
    expect(parsed.data.errorType).toBe('execution_failed');
  });

  it('workunit.execution.stream：buildExecutionStreamChunks 每个 chunk wire 形态过判别联合', () => {
    const chunks = buildExecutionStreamChunks({
      workUnitId: 'wu-1', executionId: 'ex-1', channelId: 'ch-1', step: 2,
      line: ASSISTANT_LINE, at: TS,
    });
    expect(chunks.length).toBeGreaterThan(0);
    for (const chunk of chunks) {
      const parsed = sseEventSchema.parse(envelope(EXECUTION_STREAM_SSE_TYPE, chunk));
      if (parsed.event_type !== 'workunit.execution.stream') throw new Error('narrow failed');
      expect(parsed.data.workUnitId).toBe('wu-1');
    }
    expect(chunks.map(c => c.kind)).toEqual(['thinking', 'text', 'tool']);
  });
});

describe('桥事件 ↔ 契约 parity', () => {
  it('workunit.status_changed：snapshotToData 快照 + claimable 的 wire 形态过判别联合', () => {
    const snapshot = {
      id: 'wu-1', parentId: null, type: 'task', scope: 's', assigneeId: null,
      status: 'in_progress', failureType: null, retryCount: 0, timeoutAt: null,
      channelId: 'ch-1', projectPath: null, workspaceId: null, reqId: null,
      assigneeRoleId: null, metadata: null,
      createdAt: TS, updatedAt: TS, claimedAt: TS, completedAt: null,
    };
    // 与 workunit-crud.publishStatusChanged 同一构造：{ workunit: { ...snapshotToData(s), claimable } }
    const data = { workunit: { ...snapshotToData(snapshot), claimable: false } };
    const parsed = sseEventSchema.parse(envelope('workunit.status_changed', data));
    if (parsed.event_type !== 'workunit.status_changed') throw new Error('narrow failed');
    expect(parsed.data.workunit.id).toBe('wu-1');
    expect(parsed.data.workunit.claimedAt).toBe(TS); // Date → ISO string 的 wire 形态
  });

  it('workunit:removed：{ id, channelId } 过判别联合（channelId 可 null）', () => {
    const parsed = sseEventSchema.parse(envelope('workunit:removed', { id: 'wu-1', channelId: null }));
    if (parsed.event_type !== 'workunit:removed') throw new Error('narrow failed');
    expect(parsed.data.id).toBe('wu-1');
  });

  it('requirement.created：requirement.service publish 的 { requirement } 信封 wire 形态过判别联合', () => {
    const requirement = {
      id: 'REQ-0042', seq: 42, title: 'r', status: 'open',
      channelId: 'ch-1', createdAt: TS, createdBy: 'mention', projectId: null,
    };
    const parsed = sseEventSchema.parse(envelope('requirement.created', { requirement }));
    if (parsed.event_type !== 'requirement.created') throw new Error('narrow failed');
    expect(parsed.data.requirement.id).toBe('REQ-0042');
  });
});
