/**
 * 事件系统
 *
 * 通用 EventEmitter 封装，从 agent-platform/runtime 提取。
 * 适用于所有需要事件驱动的模块。
 */

import { EventEmitter as EE } from 'eventemitter3';

export type EventHandler = (event: Event) => void;

export interface Event {
  type: string;
  data?: any;
  timestamp: Date;
}

export class EventEmitter {
  private emitter = new EE();

  on(event: string, handler: EventHandler): this {
    this.emitter.on(event, handler);
    return this;
  }

  once(event: string, handler: EventHandler): this {
    this.emitter.once(event, handler);
    return this;
  }

  off(event: string, handler?: EventHandler): this {
    this.emitter.off(event, handler);
    return this;
  }

  emit(type: string, data?: any): void {
    const event: Event = {
      type,
      data,
      timestamp: new Date()
    };
    this.emitter.emit(type, event);
    this.emitter.emit('*', event);
  }

  removeAllListeners(): void {
    this.emitter.removeAllListeners();
  }
}

// 事件类型常量
export const Events = {
  WORKFLOW_STARTED: 'workflow.started',
  WORKFLOW_COMPLETED: 'workflow.completed',
  WORKFLOW_FAILED: 'workflow.failed',
  WORKFLOW_CANCELLED: 'workflow.cancelled',

  STEP_STARTED: 'step.started',
  STEP_PROGRESS: 'step.progress',
  STEP_COMPLETED: 'step.completed',
  STEP_FAILED: 'step.failed',
  STEP_SKIPPED: 'step.skipped',

  TOOL_STARTED: 'tool.started',
  TOOL_COMPLETED: 'tool.completed',
  TOOL_FAILED: 'tool.failed',

  AGENT_STARTED: 'agent.started',
  AGENT_PROGRESS: 'agent.progress',
  AGENT_COMPLETED: 'agent.completed',
  AGENT_FAILED: 'agent.failed',
} as const;
