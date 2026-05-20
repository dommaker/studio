/**
 * Discussion 事件定义与处理
 * 
 * DD-007 + DD-019: DiscussionDriver 事件机制 + 并行发言
 * AS-009: 争议检查事件
 */

import { v4 as uuidv4 } from 'uuid';
import { memoryStore } from '@dommaker/studio-shared';

/**
 * Discussion 事件类型
 */
export type DiscussionEventType =
  | 'discussion.started'
  | 'discussion.auto_start'
  | 'discussion.speaker_selected'
  | 'discussion.message_sent'
  | 'discussion.round_completed'  // 🆕 DD-019
  | 'discussion.consensus_reached'
  | 'discussion.user_intervention_needed'
  | 'discussion.max_rounds_reached'
  | 'discussion.timeout'
  | 'discussion.stopped'
  | 'discussion.completed'
  | 'discussion.controversy_injected';  // 🆕 AS-009

/**
 * Discussion 事件数据
 */
export interface DiscussionEvent {
  event_id: string;
  event_type: DiscussionEventType;
  timestamp: string;
  data: {
    meetingId: string;
    taskId?: string;
    topic?: string;
    round?: number;
    roleId?: string;
    reason?: string;
    messageLength?: number;
    messageCount?: number;  // 🆕 DD-019
    decisions?: number;
    confidence?: number;
    maxRounds?: number;
    elapsedMs?: number;
    result?: string;
    pendingQuestions?: string[];
  };
}

/**
 * Discussion 事件发布器
 */
export class DiscussionEventPublisher {
  private channel = 'events:discussion';

  async publish(eventType: DiscussionEventType, meetingId: string, data: any): Promise<void> {
    const event: DiscussionEvent = {
      event_id: uuidv4(),
      event_type: eventType,
      timestamp: new Date().toISOString(),
      data: { meetingId, ...data },
    };

    await memoryStore.publish(this.channel, JSON.stringify(event));
    console.log(`[Discussion Event] ${eventType} - ${meetingId}`, data);
  }

  async publishStarted(meetingId: string, topic: string): Promise<void> {
    await this.publish('discussion.started', meetingId, { topic });
  }

  async publishAutoStart(meetingId: string, taskId: string, topic: string, maxRounds: number): Promise<void> {
    await this.publish('discussion.auto_start', meetingId, { taskId, topic, maxRounds });
  }

  async publishSpeakerSelected(meetingId: string, round: number, roleId: string, reason: string): Promise<void> {
    await this.publish('discussion.speaker_selected', meetingId, { round, roleId, reason });
  }

  async publishMessageSent(meetingId: string, round: number, roleId: string, messageLength: number): Promise<void> {
    await this.publish('discussion.message_sent', meetingId, { round, roleId, messageLength });
  }

  async publishRoundCompleted(meetingId: string, round: number, messageCount: number): Promise<void> {
    await this.publish('discussion.round_completed', meetingId, { round, messageCount });
  }

  async publishConsensusReached(meetingId: string, round: number, decisions: number, confidence: number): Promise<void> {
    await this.publish('discussion.consensus_reached', meetingId, { round, decisions, confidence });
  }

  async publishUserInterventionNeeded(meetingId: string, round: number, reason: string): Promise<void> {
    await this.publish('discussion.user_intervention_needed', meetingId, { round, reason });
  }

  async publishMaxRoundsReached(meetingId: string, round: number): Promise<void> {
    await this.publish('discussion.max_rounds_reached', meetingId, { round });
  }

  async publishTimeout(meetingId: string, elapsedMs: number): Promise<void> {
    await this.publish('discussion.timeout', meetingId, { elapsedMs });
  }

  async publishStopped(meetingId: string, reason: string): Promise<void> {
    await this.publish('discussion.stopped', meetingId, { reason });
  }

  async publishCompleted(meetingId: string, result: string, round: number): Promise<void> {
    await this.publish('discussion.completed', meetingId, { result, round });
  }

  // 🆕 AS-009: 争议注入事件
  async publishControversyInjected(meetingId: string, round: number, contentPreview: string): Promise<void> {
    await this.publish('discussion.controversy_injected', meetingId, { 
      round, 
      reason: '缺乏反对意见，自动注入 Devil\'s Advocate',
      contentPreview: contentPreview.slice(0, 100),
    });
  }
}

/**
 * Discussion 事件订阅器
 */
export class DiscussionEventSubscriber {
  private channel = 'events:discussion';
  private handlers: Map<DiscussionEventType, (event: DiscussionEvent) => Promise<void>>;

  constructor() {
    this.handlers = new Map();
  }

  async subscribe(): Promise<void> {
    memoryStore.subscribe(this.channel, async (message: string) => {
      try {
        const event: DiscussionEvent = JSON.parse(message);
        const handler = this.handlers.get(event.event_type);
        if (handler) await handler(event);
      } catch (error) {
        console.error('[Discussion Event Subscriber] Error:', error);
      }
    });
  }

  on(eventType: DiscussionEventType, handler: (event: DiscussionEvent) => Promise<void>): void {
    this.handlers.set(eventType, handler);
  }

  async unsubscribe(): Promise<void> {
    // no-op: in-memory EventBus, managed by framework
  }
}

export const discussionEventPublisher = new DiscussionEventPublisher();
export const discussionEventSubscriber = new DiscussionEventSubscriber();