/**
 * WorkUnit 事件定义
 *
 * 事件类型常量 + 发射辅助函数。
 * EventBus 统一用 eventBus.publish(topic, data) 模式。
 */

import { eventBus } from '@dommaker/studio-shared';
import { logger } from '@dommaker/studio-shared';

// ─── 事件类型常量 ───

export const WORKUNIT_EVENTS = {
  CREATED: 'workunit.created',
  CLAIMED: 'workunit.claimed',
  STATUS_CHANGED: 'workunit.status_changed',
  DONE: 'workunit.done',
  UNCLAIMED: 'workunit.unclaimed',
  REVIEW_PASSED: 'workunit.review.passed',
  REVIEW_REJECTED: 'workunit.review.rejected',
} as const;

// ─── 事件数据类型 ───

export interface WorkUnitCreatedEvent {
  workUnitId: string;
  type: string;
  scope: string;
  channelId?: string | null;
}

export interface WorkUnitClaimedEvent {
  workUnitId: string;
  agentId: string;
  scope: string;
}

export interface WorkUnitStatusChangedEvent {
  workUnitId: string;
  oldStatus: string;
  newStatus: string;
}

export interface WorkUnitDoneEvent {
  workUnitId: string;
  scope: string;
}

export interface WorkUnitReviewEvent {
  workUnitId: string;
  scope: string;
}

// ─── 发射辅助函数 ───

export function emitWorkUnitCreated(data: WorkUnitCreatedEvent): void {
  try {
    eventBus.publish(WORKUNIT_EVENTS.CREATED, data);
    logger.debug('[WorkUnit] Event emitted', { event: WORKUNIT_EVENTS.CREATED, workUnitId: data.workUnitId });
  } catch (err) {
    logger.warn('[WorkUnit] Failed to emit event', { event: WORKUNIT_EVENTS.CREATED, error: String(err) });
  }
}

export function emitWorkUnitClaimed(data: WorkUnitClaimedEvent): void {
  try {
    eventBus.publish(WORKUNIT_EVENTS.CLAIMED, data);
    logger.debug('[WorkUnit] Event emitted', { event: WORKUNIT_EVENTS.CLAIMED, workUnitId: data.workUnitId });
  } catch (err) {
    logger.warn('[WorkUnit] Failed to emit event', { event: WORKUNIT_EVENTS.CLAIMED, error: String(err) });
  }
}

export function emitWorkUnitStatusChanged(data: WorkUnitStatusChangedEvent): void {
  try {
    eventBus.publish(WORKUNIT_EVENTS.STATUS_CHANGED, data);
    logger.debug('[WorkUnit] Event emitted', { event: WORKUNIT_EVENTS.STATUS_CHANGED, workUnitId: data.workUnitId });
  } catch (err) {
    logger.warn('[WorkUnit] Failed to emit event', { event: WORKUNIT_EVENTS.STATUS_CHANGED, error: String(err) });
  }
}

export function emitWorkUnitDone(data: WorkUnitDoneEvent): void {
  try {
    eventBus.publish(WORKUNIT_EVENTS.DONE, data);
    logger.debug('[WorkUnit] Event emitted', { event: WORKUNIT_EVENTS.DONE, workUnitId: data.workUnitId });
  } catch (err) {
    logger.warn('[WorkUnit] Failed to emit event', { event: WORKUNIT_EVENTS.DONE, error: String(err) });
  }
}

export function emitWorkUnitReviewPassed(data: WorkUnitReviewEvent): void {
  try {
    eventBus.publish(WORKUNIT_EVENTS.REVIEW_PASSED, data);
    logger.debug('[WorkUnit] Event emitted', { event: WORKUNIT_EVENTS.REVIEW_PASSED, workUnitId: data.workUnitId });
  } catch (err) {
    logger.warn('[WorkUnit] Failed to emit event', { event: WORKUNIT_EVENTS.REVIEW_PASSED, error: String(err) });
  }
}

export function emitWorkUnitReviewRejected(data: WorkUnitReviewEvent): void {
  try {
    eventBus.publish(WORKUNIT_EVENTS.REVIEW_REJECTED, data);
    logger.debug('[WorkUnit] Event emitted', { event: WORKUNIT_EVENTS.REVIEW_REJECTED, workUnitId: data.workUnitId });
  } catch (err) {
    logger.warn('[WorkUnit] Failed to emit event', { event: WORKUNIT_EVENTS.REVIEW_REJECTED, error: String(err) });
  }
}
