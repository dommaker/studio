/**
 * sse.routes topic 映射单测
 *  - getTopicFromEventType 纯前缀映射：event_type → SSE topic
 *  - requirement.* → requirements（REQ chips SSE 驱动的路由依据）
 *  - workunit.* （含 workunit.tokens / workunit.execution.step）→ workunits
 */
import { describe, it, expect } from 'vitest';
import { getTopicFromEventType } from '../sse.routes.js';

describe('getTopicFromEventType', () => {
  it('requirement.created / requirement.updated → requirements', () => {
    expect(getTopicFromEventType('requirement.created')).toBe('requirements');
    expect(getTopicFromEventType('requirement.updated')).toBe('requirements');
  });

  it('workunit.* 一族 → workunits（含 workunit.tokens 与 execution step/stream）', () => {
    expect(getTopicFromEventType('workunit.created')).toBe('workunits');
    expect(getTopicFromEventType('workunit.status_changed')).toBe('workunits');
    expect(getTopicFromEventType('workunit.tokens')).toBe('workunits');
    expect(getTopicFromEventType('workunit.execution.step')).toBe('workunits');
    expect(getTopicFromEventType('workunit.execution.stream')).toBe('workunits');
  });

  it('既有前缀映射不变；未知 → all', () => {
    expect(getTopicFromEventType('execution.started')).toBe('executions');
    expect(getTopicFromEventType('runtime.tick')).toBe('executions');
    expect(getTopicFromEventType('channel.message_created')).toBe('channels');
    expect(getTopicFromEventType('knowledge.extracted')).toBe('knowledge');
    expect(getTopicFromEventType('something.else')).toBe('all');
  });
});
