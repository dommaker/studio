/**
 * 状态映射工具测试
 */

import { describe, it, expect } from 'vitest';
import {
  GOAL_TO_WORKUNIT_STATUS,
  EXECUTION_TO_WORKUNIT_STATUS,
  WORKUNIT_TO_GOAL_STATUS,
  mapGoalStatuses,
  mapExecutionStatuses,
  isTerminalStatus,
  isActiveStatus,
} from '../status-mapping.js';

describe('GOAL_TO_WORKUNIT_STATUS', () => {
  it('maps all Goal statuses', () => {
    expect(GOAL_TO_WORKUNIT_STATUS.draft).toBe('unassigned');
    expect(GOAL_TO_WORKUNIT_STATUS.planning).toBe('unassigned');
    expect(GOAL_TO_WORKUNIT_STATUS.executing).toBe('active');
    expect(GOAL_TO_WORKUNIT_STATUS.succeeded).toBe('done');
    expect(GOAL_TO_WORKUNIT_STATUS.failed).toBe('closed');
    expect(GOAL_TO_WORKUNIT_STATUS.blocked).toBe('blocked');
  });
});

describe('EXECUTION_TO_WORKUNIT_STATUS', () => {
  it('maps all Execution statuses', () => {
    expect(EXECUTION_TO_WORKUNIT_STATUS.pending).toBe('unassigned');
    expect(EXECUTION_TO_WORKUNIT_STATUS.running).toBe('active');
    expect(EXECUTION_TO_WORKUNIT_STATUS.succeeded).toBe('done');
    expect(EXECUTION_TO_WORKUNIT_STATUS.failed).toBe('closed');
  });
});

describe('WORKUNIT_TO_GOAL_STATUS (reverse)', () => {
  it('maps all WorkUnit statuses back to Goal', () => {
    expect(WORKUNIT_TO_GOAL_STATUS.unassigned).toBe('draft');
    expect(WORKUNIT_TO_GOAL_STATUS.active).toBe('executing');
    expect(WORKUNIT_TO_GOAL_STATUS.in_review).toBe('executing');
    expect(WORKUNIT_TO_GOAL_STATUS.done).toBe('succeeded');
    expect(WORKUNIT_TO_GOAL_STATUS.closed).toBe('failed');
    expect(WORKUNIT_TO_GOAL_STATUS.blocked).toBe('blocked');
  });
});

describe('mapGoalStatuses', () => {
  it('maps array of Goal statuses to WorkUnit statuses', () => {
    expect(mapGoalStatuses(['succeeded', 'failed'])).toEqual(['done', 'closed']);
    expect(mapGoalStatuses(['draft', 'executing'])).toEqual(['unassigned', 'active']);
  });

  it('filters unmapped statuses', () => {
    expect(mapGoalStatuses(['unknown', 'succeeded'])).toEqual(['done']);
  });

  it('returns empty for empty input', () => {
    expect(mapGoalStatuses([])).toEqual([]);
  });
});

describe('mapExecutionStatuses', () => {
  it('maps array of Execution statuses', () => {
    expect(mapExecutionStatuses(['running', 'pending'])).toEqual(['active', 'unassigned']);
    expect(mapExecutionStatuses(['succeeded', 'failed'])).toEqual(['done', 'closed']);
  });
});

describe('isTerminalStatus', () => {
  it('returns true for done and closed', () => {
    expect(isTerminalStatus('done')).toBe(true);
    expect(isTerminalStatus('closed')).toBe(true);
  });

  it('returns false for non-terminal', () => {
    expect(isTerminalStatus('active')).toBe(false);
    expect(isTerminalStatus('unassigned')).toBe(false);
    expect(isTerminalStatus('blocked')).toBe(false);
    expect(isTerminalStatus('in_review')).toBe(false);
  });
});

describe('isActiveStatus', () => {
  it('returns true for active and in_review', () => {
    expect(isActiveStatus('active')).toBe(true);
    expect(isActiveStatus('in_review')).toBe(true);
  });

  it('returns false for non-active', () => {
    expect(isActiveStatus('unassigned')).toBe(false);
    expect(isActiveStatus('done')).toBe(false);
    expect(isActiveStatus('closed')).toBe(false);
    expect(isActiveStatus('blocked')).toBe(false);
  });
});
