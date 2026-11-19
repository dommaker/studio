/**
 * SSE 事件负载契约测试（#665，ADR 2026-08-24 落地）。
 * 正本 = apps/api 各 SSE 发射点（eventBus 'events' 频道）实测 wire 形态：
 * - 信封：{ event_id?, event_type, timestamp, data }（knowledge 桥历史包袱用 payload 键，见 loose 信封）
 * - connection.established 是裸帧（无信封，无 event_type），见 connectionEstablishedFrameSchema
 * fixture 均为「发射点产物 JSON 序列化后」的 wire 形态（Date → ISO string）。
 */

import { describe, it, expect } from 'vitest';
import {
  SSE_EVENT_TYPES,
  sseEnvelopeSchema,
  sseEventSchema,
  connectionEstablishedFrameSchema,
  channelMessageSentPayloadSchema,
  channelMessageUpdatedPayloadSchema,
  workunitEventPayloadSchema,
  workunitRemovedPayloadSchema,
  requirementEventPayloadSchema,
  executionStepEventSchema,
  executionStreamChunkSchema,
  workunitTokenEventSchema,
  agentInstanceStatusChangedPayloadSchema,
  agentHealthFailedPayloadSchema,
  notificationCreatedPayloadSchema,
  knowledgeEntryChangedPayloadSchema,
  type SseEventPayloadMap,
  type SseEventType,
} from '../sse-events.js';
import * as contractIndex from '../index.js';

const TS = '2026-10-08T01:00:00.000Z';

const message = {
  id: 'msg-1',
  channelId: 'ch-1',
  workUnitId: null,
  authorType: 'human',
  agentName: null,
  content: 'hello',
  replyToId: null,
  meta: { atHuman: true },
  createdAt: TS,
};

const workunit = {
  id: 'wu-1',
  parentId: null,
  type: 'task',
  scope: 'do something',
  assigneeId: null,
  status: 'unassigned',
  failureType: null,
  retryCount: 0,
  timeoutAt: null,
  channelId: 'ch-1',
  projectPath: null,
  workspaceId: null,
  reqId: null,
  assigneeRoleId: null,
  metadata: null,
  createdAt: TS,
  updatedAt: TS,
  claimedAt: null,
  completedAt: null,
  claimable: true,
};

const requirement = {
  id: 'REQ-0042',
  seq: 42,
  title: 'req',
  status: 'open',
  channelId: 'ch-1',
  createdAt: TS,
  createdBy: 'mention',
  projectId: null,
};

describe('信封与词表', () => {
  it('loose 信封：未知 event_type 透传；knowledge 桥 payload 键容忍；缺 event_type 拒绝', () => {
    expect(sseEnvelopeSchema.parse({ event_type: 'runtime.event', timestamp: TS, data: { x: 1 } }).event_type).toBe('runtime.event');
    expect(sseEnvelopeSchema.parse({ event_type: 'knowledge.promoted', timestamp: TS, payload: { id: 'k1' } }).payload).toEqual({ id: 'k1' });
    expect(sseEnvelopeSchema.parse({ event_type: 'task.updated', event_id: 'e-1' }).data).toBeUndefined();
    expect(() => sseEnvelopeSchema.parse({ timestamp: TS, data: {} })).toThrow();
  });

  it('connection.established 裸帧（无信封无 event_type，sse.routes 连接帧直发 payload）', () => {
    expect(connectionEstablishedFrameSchema.parse({ clientId: 'c-1', topics: ['all'] })).toEqual({ clientId: 'c-1', topics: ['all'] });
    expect(() => connectionEstablishedFrameSchema.parse({ clientId: 'c-1' })).toThrow();
  });

  it('SSE_EVENT_TYPES = 判别联合成员全集；SseEventPayloadMap 键与词表一一对应（编译期）', () => {
    const parsed = SSE_EVENT_TYPES.map(t => ({ t }));
    expect(new Set(SSE_EVENT_TYPES).size).toBe(SSE_EVENT_TYPES.length);
    expect(parsed.length).toBeGreaterThan(0);
    // 编译期锁定：词表每个成员都在 payload map 里有类型
    const _check: Record<SseEventType, true> = Object.fromEntries(SSE_EVENT_TYPES.map(t => [t, true])) as Record<SseEventType, true>;
    const _mapHasAll: Pick<SseEventPayloadMap, SseEventType> = {} as SseEventPayloadMap;
    void _check; void _mapHasAll;
    expect(SSE_EVENT_TYPES).toContain('workunit:removed'); // 冒号命名（与其他 workunit.* 点号不一致，词表如实记录）
  });
});

describe('channel 事件负载', () => {
  it('channel.message_sent：{ channelId, message }（shapeMessageData 产物，meta 已解析为 object）', () => {
    const data = { channelId: 'ch-1', message };
    expect(channelMessageSentPayloadSchema.parse(data)).toEqual(data);
    expect(() => channelMessageSentPayloadSchema.parse({ channelId: 'ch-1' })).toThrow();
  });

  it('channel.message_updated：messageId + 全量 message 必有；content/meta/workUnitId 为 additive 增量可缺省', () => {
    const full = { channelId: 'ch-1', messageId: 'msg-1', meta: { a: 1 }, message };
    expect(channelMessageUpdatedPayloadSchema.parse(full)).toEqual(full);
    expect(channelMessageUpdatedPayloadSchema.parse({ channelId: 'ch-1', messageId: 'msg-1', content: 'x', message })).toBeTruthy();
    expect(channelMessageUpdatedPayloadSchema.parse({ channelId: 'ch-1', messageId: 'msg-1', workUnitId: 'wu-1', message })).toBeTruthy();
    expect(() => channelMessageUpdatedPayloadSchema.parse({ channelId: 'ch-1', messageId: 'msg-1' })).toThrow();
  });
});

describe('workunit / requirement 桥事件负载', () => {
  it('workunit.created / status_changed：{ workunit } 全量快照（snapshotToData wire 形态 + claimable）', () => {
    expect(workunitEventPayloadSchema.parse({ workunit })).toEqual({ workunit });
    expect(() => workunitEventPayloadSchema.parse({ workunit: { id: 'wu-1' } })).toThrow();
  });

  it('workunit:removed：{ id, channelId }（#538 删除出声，channelId 可 null）', () => {
    expect(workunitRemovedPayloadSchema.parse({ id: 'wu-1', channelId: 'ch-1' })).toBeTruthy();
    expect(workunitRemovedPayloadSchema.parse({ id: 'wu-1', channelId: null })).toBeTruthy();
    expect(() => workunitRemovedPayloadSchema.parse({ id: 'wu-1' })).toThrow();
  });

  it('requirement.created / updated：{ requirement } 信封全量（与 REST get 同源）', () => {
    expect(requirementEventPayloadSchema.parse({ requirement })).toEqual({ requirement });
    expect(() => requirementEventPayloadSchema.parse({ requirement: { id: 'REQ-1' } })).toThrow();
  });
});

describe('agent-loop 执行事件负载', () => {
  const stepEvent = {
    workUnitId: 'wu-1',
    executionId: 'ex-1',
    channelId: 'ch-1',
    sessionId: 's-1',
    cliSessionId: 'cli-1',
    sessionResumed: false,
    step: 3,
    action: 'progress',
    status: 'success',
    thinking: ['t'],
    toolCalls: [{ tool: 'Read', summary: '/a.ts' }],
    skills: ['tdd'],
    text: 'done',
    usage: { inputTokens: 1, outputTokens: 2, model: 'm' },
    at: TS,
  };

  it('workunit.execution.step：全字段 + 失败步 errorType/errorDetail；可选项缺省放行', () => {
    expect(executionStepEventSchema.parse(stepEvent)).toEqual(stepEvent);
    const failed = { ...stepEvent, status: 'failed', errorType: 'execution_failed', errorDetail: 'boom' };
    expect(executionStepEventSchema.parse(failed).status).toBe('failed');
    const minimal = {
      workUnitId: 'wu-1', executionId: 'ex-1', step: 1, status: 'success',
      thinking: [], toolCalls: [], skills: [], at: TS,
    };
    expect(executionStepEventSchema.parse(minimal)).toEqual(minimal);
    expect(() => executionStepEventSchema.parse({ ...minimal, status: 'bogus' })).toThrow();
    expect(() => executionStepEventSchema.parse({ ...minimal, step: undefined })).toThrow();
  });

  it('workunit.execution.stream：kind 词表 + toolUseId 配对锚点 + isError', () => {
    const base = { workUnitId: 'wu-1', executionId: 'ex-1', step: 1, at: TS };
    for (const kind of ['step-start', 'thinking', 'text', 'tool', 'tool-result', 'result'] as const) {
      expect(executionStreamChunkSchema.parse({ ...base, kind }).kind).toBe(kind);
    }
    expect(executionStreamChunkSchema.parse({ ...base, kind: 'tool', tool: 'Bash', summary: 'ls', toolUseId: 'tu-1' })).toBeTruthy();
    expect(executionStreamChunkSchema.parse({ ...base, kind: 'tool-result', toolUseId: 'tu-1', isError: true })).toBeTruthy();
    expect(executionStreamChunkSchema.parse({ ...base, kind: 'thinking', channelId: null })).toBeTruthy();
    expect(() => executionStreamChunkSchema.parse({ ...base, kind: 'bogus' })).toThrow();
  });

  it('workunit.tokens：injected/execution(nullable)/total 必有；usage 明细 additive 可缺省', () => {
    const minimal = { workUnitId: 'wu-1', injectedTokens: 10, executionTokens: null, totalTokens: 10 };
    expect(workunitTokenEventSchema.parse(minimal)).toEqual(minimal);
    const full = {
      ...minimal,
      executionId: 'ex-1',
      injectedSource: 'estimate:token-estimator',
      executionTokens: 5,
      executionSource: 'cli-usage',
      totalTokens: 15,
      extractionTokens: 1, inputTokens: 2, outputTokens: 3,
      cacheReadTokens: 4, cacheCreationTokens: 5,
      billedTokens: 6, costUsd: 0.01, numTurns: 2,
      triggerId: 'tr-1', provider: 'claude', channelId: 'ch-1',
    };
    expect(workunitTokenEventSchema.parse(full)).toEqual(full);
    expect(() => workunitTokenEventSchema.parse({ workUnitId: 'wu-1' })).toThrow();
  });
});

describe('agent / notification / knowledge 事件负载', () => {
  it('agent.instance.status_changed：profileId/name/status + nullable 快照段（#312/#318 additive 定型）', () => {
    const data = {
      profileId: 'pm', instanceId: 'inst-1', name: 'PM', status: 'active',
      currentWorkUnitId: 'wu-1',
      currentWorkUnit: { id: 'wu-1', title: 't', type: 'task', status: 'in_progress', claimedAt: TS },
      channelId: 'ch-1',
      pmo: { id: 'p-1', pmoNumber: 'PMO-1', title: 'proj' },
      startedAt: TS, lastError: null, lastErrorAt: null,
    };
    expect(agentInstanceStatusChangedPayloadSchema.parse(data)).toEqual(data);
    const errorShape = {
      profileId: 'pm', instanceId: null, name: 'PM', status: 'error',
      currentWorkUnitId: null, currentWorkUnit: null, channelId: null, pmo: null,
      startedAt: TS, lastError: 'spawn failed', lastErrorAt: TS,
    };
    expect(agentInstanceStatusChangedPayloadSchema.parse(errorShape)).toEqual(errorShape);
    expect(() => agentInstanceStatusChangedPayloadSchema.parse({ profileId: 'pm' })).toThrow();
  });

  it('agent.health.failed：{ profileId, name, provider, error }', () => {
    const data = { profileId: 'pm', name: 'PM', provider: 'claude', error: 'boom' };
    expect(agentHealthFailedPayloadSchema.parse(data)).toEqual(data);
    expect(() => agentHealthFailedPayloadSchema.parse({ profileId: 'pm' })).toThrow();
  });

  it('notification.created：{ title, content, wuId, link }（gate-escalation tier1 铃铛信封）', () => {
    const data = { title: 't', content: 'c', wuId: 'wu-1', link: '/workunits/wu-1' };
    expect(notificationCreatedPayloadSchema.parse(data)).toEqual(data);
    expect(() => notificationCreatedPayloadSchema.parse({ title: 't' })).toThrow();
  });

  it('knowledge.entry_changed：action 词表 + 轻量元信息（重拉信号，无 event_id 也成信封）', () => {
    expect(knowledgeEntryChangedPayloadSchema.parse({ action: 'created' })).toEqual({ action: 'created' });
    expect(knowledgeEntryChangedPayloadSchema.parse({ action: 'promoted', entryId: 'k1', entryType: 'pattern', title: 't' })).toBeTruthy();
    expect(() => knowledgeEntryChangedPayloadSchema.parse({ action: 'bogus' })).toThrow();
  });
});

describe('sseEventSchema 判别联合（wire 校验入口）', () => {
  it('按 event_type narrow 到具名负载；全词表逐一过', () => {
    const cases: Array<{ event_type: SseEventType; data: unknown }> = [
      { event_type: 'channel.message_sent', data: { channelId: 'ch-1', message } },
      { event_type: 'channel.message_updated', data: { channelId: 'ch-1', messageId: 'msg-1', message } },
      { event_type: 'workunit.created', data: { workunit } },
      { event_type: 'workunit.status_changed', data: { workunit } },
      { event_type: 'workunit:removed', data: { id: 'wu-1', channelId: null } },
      { event_type: 'workunit.execution.step', data: { workUnitId: 'wu-1', executionId: 'ex-1', step: 1, status: 'success', thinking: [], toolCalls: [], skills: [], at: TS } },
      { event_type: 'workunit.execution.stream', data: { workUnitId: 'wu-1', executionId: 'ex-1', step: 1, kind: 'result', at: TS } },
      { event_type: 'workunit.tokens', data: { workUnitId: 'wu-1', injectedTokens: 1, executionTokens: null, totalTokens: 1 } },
      { event_type: 'requirement.created', data: { requirement } },
      { event_type: 'requirement.updated', data: { requirement } },
      { event_type: 'agent.instance.status_changed', data: { profileId: 'pm', instanceId: 'i', name: 'PM', status: 'idle', currentWorkUnitId: null, currentWorkUnit: null, channelId: null, pmo: null, startedAt: null, lastError: null, lastErrorAt: null } },
      { event_type: 'agent.health.failed', data: { profileId: 'pm', name: 'PM', provider: 'claude', error: 'x' } },
      { event_type: 'notification.created', data: { title: 't', content: 'c', wuId: 'wu-1', link: '/l' } },
      { event_type: 'knowledge.entry_changed', data: { action: 'demoted' } },
    ];
    expect(cases.map(c => c.event_type).sort()).toEqual([...SSE_EVENT_TYPES].sort());
    for (const c of cases) {
      const envelope = { event_id: 'e-1', event_type: c.event_type, timestamp: TS, data: c.data };
      const parsed = sseEventSchema.parse(envelope);
      expect(parsed.event_type).toBe(c.event_type);
      if (parsed.event_type === 'workunit:removed') {
        expect(parsed.data.id).toBe('wu-1'); // narrow 生效：data 具名类型
      }
    }
  });

  it('event_id 可缺省（knowledge.entry_changed 发射点不带）；词表外 event_type / 负载不符拒绝', () => {
    expect(sseEventSchema.parse({ event_type: 'knowledge.entry_changed', timestamp: TS, data: { action: 'created' } })).toBeTruthy();
    expect(sseEventSchema.safeParse({ event_type: 'runtime.event', timestamp: TS, data: {} }).success).toBe(false);
    expect(sseEventSchema.safeParse({ event_type: 'notification.created', timestamp: TS, data: { title: 't' } }).success).toBe(false);
  });

  it('index 桶导出', () => {
    expect(contractIndex.sseEventSchema).toBe(sseEventSchema);
    expect(contractIndex.SSE_EVENT_TYPES).toBe(SSE_EVENT_TYPES);
  });
});
