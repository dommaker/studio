/**
 * 状态转换监听器
 * 
 * 功能：
 * 1. 监听状态转换事件
 * 2. 触发上下文桥接
 * 3. 发送通知
 * 4. 记录审计
 * 
 * 内置监听器：
 * - ContextBridgeListener: 触发上下文桥接
 * - NotificationListener: 发送通知
 * - AuditListener: 记录审计
 */

import type { TransitionEvent, ErrorEvent, StateListener } from './meeting-state-machine';
import type { ContextBridge } from './context-bridge';

/**
 * 上下文桥接监听器
 * 
 * 状态转换时自动触发上下文桥接
 */
export class ContextBridgeListener implements StateListener {
  private bridge: ContextBridge;

  constructor(bridge: ContextBridge) {
    this.bridge = bridge;
  }

  async onTransition(event: TransitionEvent): Promise<void> {
    const { to, meetingId, taskId } = event;

    switch (to) {
      case 'executing':
        // 进入执行阶段，准备角色上下文
        await this.prepareExecutionContext(meetingId, taskId);
        break;

      case 'testing':
        // 进入测试阶段，准备测试上下文
        await this.prepareTestingContext(meetingId, taskId);
        break;

      case 'reviewing':
        // 进入评审阶段，准备评审上下文
        await this.prepareReviewContext(meetingId, taskId);
        break;

      case 'completed':
        // 完成，归档上下文
        await this.archiveContext(meetingId);
        break;
    }
  }

  private async prepareExecutionContext(meetingId: string, taskId?: string): Promise<void> {
    if (!taskId) return;

    // 预加载角色上下文（渐进式披露）
    // 实际执行时由 ContextBridge.extract() 完成
    console.log(`[ContextBridgeListener] Preparing execution context for meeting: ${meetingId}`);
  }

  private async prepareTestingContext(meetingId: string, taskId?: string): Promise<void> {
    console.log(`[ContextBridgeListener] Preparing testing context for meeting: ${meetingId}`);
  }

  private async prepareReviewContext(meetingId: string, taskId?: string): Promise<void> {
    console.log(`[ContextBridgeListener] Preparing review context for meeting: ${meetingId}`);
  }

  private async archiveContext(meetingId: string): Promise<void> {
    console.log(`[ContextBridgeListener] Archiving context for meeting: ${meetingId}`);
  }
}

/**
 * 通知监听器
 * 
 * 状态转换时发送通知
 */
export class NotificationListener implements StateListener {
  private notifier: Notifier;

  constructor(notifier: Notifier) {
    this.notifier = notifier;
  }

  async onTransition(event: TransitionEvent): Promise<void> {
    const { meetingId, from, to, trigger, gates } = event;

    // 关键状态转换发送通知
    const shouldNotify = this.shouldNotify(from, to);

    if (shouldNotify) {
      await this.notifier.send({
        type: 'state_transition',
        meetingId,
        from,
        to,
        trigger,
        gatesPassed: gates.every(g => g.passed),
        timestamp: event.timestamp,
      });
    }
  }

  private shouldNotify(from: string, to: string): boolean {
    // 关键状态转换
    const criticalTransitions = [
      ['discussing', 'designing'],
      ['designing', 'task_splitting'],
      ['task_splitting', 'executing'],
      ['testing', 'reviewing'],
      ['reviewing', 'completed'],
    ];

    return criticalTransitions.some(([f, t]) => f === from && t === to);
  }

  async onError(event: ErrorEvent): Promise<void> {
    await this.notifier.send({
      type: 'state_error',
      meetingId: event.meetingId,
      error: event.error.message,
      timestamp: event.timestamp,
    });
  }
}

/**
 * 审计监听器
 * 
 * 状态转换时记录审计链
 */
export class AuditListener implements StateListener {
  private auditor: Auditor;

  constructor(auditor: Auditor) {
    this.auditor = auditor;
  }

  async onTransition(event: TransitionEvent): Promise<void> {
    const { meetingId, from, to, trigger, gates, signatures } = event;

    await this.auditor.record({
      type: 'state_transition',
      meetingId,
      data: {
        from,
        to,
        trigger,
        gates,
        signatures,
      },
      timestamp: event.timestamp,
    });
  }

  async onError(event: ErrorEvent): Promise<void> {
    await this.auditor.record({
      type: 'state_error',
      meetingId: event.meetingId,
      data: {
        error: event.error.message,
        context: event.context,
      },
      timestamp: event.timestamp,
    });
  }
}

/**
 * 组合监听器
 * 
 * 将多个监听器组合为一个
 */
export class CompositeListener implements StateListener {
  private listeners: StateListener[];

  constructor(listeners: StateListener[]) {
    this.listeners = listeners;
  }

  async onTransition(event: TransitionEvent): Promise<void> {
    await Promise.all(
      this.listeners.map(async listener => {
        try {
          await listener.onTransition(event);
        } catch (err) {
          console.error('[CompositeListener] Error in listener:', err);
        }
      })
    );
  }

  async onError(event: ErrorEvent): Promise<void> {
    await Promise.all(
      this.listeners
        .filter(listener => listener.onError !== undefined)
        .map(async listener => {
          try {
            await listener.onError!(event);
          } catch (err) {
            console.error('[CompositeListener] Error in error handler:', err);
          }
        })
    );
  }
}

// ============================================
// 类型定义
// ============================================

/**
 * 通知器接口
 */
export interface Notifier {
  send(notification: Notification): Promise<void>;
}

/**
 * 通知
 */
export interface Notification {
  type: string;
  meetingId: string;
  from?: string;
  to?: string;
  trigger?: string;
  gatesPassed?: boolean;
  error?: string;
  timestamp: string;
}

/**
 * 审计器接口
 */
export interface Auditor {
  record(entry: AuditEntry): Promise<void>;
}

/**
 * 审计条目
 */
export interface AuditEntry {
  type: string;
  meetingId: string;
  data: any;
  timestamp: string;
}

/**
 * 创建默认监听器组合
 */
export function createDefaultListeners(
  bridge: ContextBridge,
  notifier?: Notifier,
  auditor?: Auditor
): StateListener[] {
  const listeners: StateListener[] = [new ContextBridgeListener(bridge)];

  if (notifier) {
    listeners.push(new NotificationListener(notifier));
  }

  if (auditor) {
    listeners.push(new AuditListener(auditor));
  }

  return listeners;
}
