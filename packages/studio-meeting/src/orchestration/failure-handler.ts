/**
 * 失败处理器
 *
 * 功能：
 * 1. 分级处理执行失败
 * 2. 自动重试
 * 3. 升级处理
 * 4. 召集会议
 *
 * 处理策略：
 * - L1: 自动重试
 * - L2: 人工干预
 * - L3: 开会讨论
 * - L4: 回滚
 *
 * 使用 harness ErrorClassifier 进行错误分类
 */

import {
  ErrorClassifier,
  FailureRecorder,
  ErrorType,
  FailureLevel,
  type ErrorClassificationRule,
  type FailureRecord,
} from '@dommaker/harness';
import type { ContextSharer } from './context-sharer';

// ========================================
// 类型定义（业务相关）
// ========================================

/**
 * FailureHandler 配置
 */
export interface FailureHandlerConfig {
  contextSharer: ContextSharer;
  meetingCreator?: MeetingCreator;
  notifier?: FailureNotifier;
  maxRetries?: number;
  /** 日志文件路径，默认 .harness/logs/failures.log */
  logFile?: string;
  /** 自定义分类规则 */
  customRules?: ErrorClassificationRule[];
  eventEmitter?: {
    emit(event: string, data: any): void;
  };
}

/**
 * 会议创建器接口
 */
export interface MeetingCreator {
  create(input: CreateFailureMeetingInput): Promise<{ meetingId: string }>;
}

/**
 * 创建会议输入
 */
export interface CreateFailureMeetingInput {
  title: string;
  participants: string[];
  context: {
    taskId?: string;
    error?: string;
    previousMeetingId?: string;
  };
}

/**
 * 失败通知器接口
 */
export interface FailureNotifier {
  notify(event: FailureEvent): Promise<void>;
}

/**
 * 失败事件
 */
export interface FailureEvent {
  type: 'retry' | 'escalate' | 'meeting' | 'rollback';
  meetingId: string;
  taskId?: string;
  roleId?: string;
  error: Error;
  attempt?: number;
  timestamp: string;
}

/**
 * 处理结果
 */
export interface HandleResult {
  handled: boolean;
  action: 'retry' | 'escalate' | 'meeting' | 'rollback' | 'none';
  message: string;
  data?: any;
}

/**
 * 桥接上下文
 */
export interface BridgeContext {
  meetingId: string;
  taskId?: string;
  roleId?: string;
  skillId?: string;
  attempt?: number;
  participants?: string[];
}

// ========================================
// 失败处理器
// ========================================

/**
 * 失败处理器
 *
 * 使用 harness ErrorClassifier 进行错误分类
 * 使用 harness FailureRecorder 进行日志记录
 */
export class FailureHandler {
  private contextSharer: ContextSharer;
  private meetingCreator?: MeetingCreator;
  private notifier?: FailureNotifier;
  private maxRetries: number;
  private eventEmitter?: { emit(event: string, data: any): void };

  // harness 能力
  private classifier: ErrorClassifier;
  private recorder: FailureRecorder;

  constructor(config: FailureHandlerConfig) {
    this.contextSharer = config.contextSharer;
    this.meetingCreator = config.meetingCreator;
    this.notifier = config.notifier;
    this.maxRetries = config.maxRetries ?? 3;
    this.eventEmitter = config.eventEmitter;

    // 使用 harness 能力
    this.classifier = new ErrorClassifier({
      rules: config.customRules,
    });

    this.recorder = new FailureRecorder({
      logFile: config.logFile ?? '.harness/logs/failures.log',
    });
  }

  /**
   * 处理执行失败
   */
  async handle(error: Error, context: BridgeContext): Promise<HandleResult> {
    // 1. 分类（harness 能力）
    const classification = this.classifier.classify(error);
    const { type, level } = classification;

    // 2. 记录（harness 能力）
    await this.recorder.record({
      type,
      level,
      message: error.message,
      timestamp: Date.now(),
      metadata: {
        meetingId: context.meetingId,
        taskId: context.taskId,
        roleId: context.roleId,
        attempt: context.attempt,
      },
    });

    this.emit('failure.occurred', {
      type,
      level,
      error: error.message,
      context,
    });

    // 3. 业务处理（根据等级）
    switch (level) {
      case FailureLevel.L1:
        return this.handleL1(error, context, type);

      case FailureLevel.L2:
        return this.handleL2(error, context, type);

      case FailureLevel.L3:
        return this.handleL3(error, context, type);

      case FailureLevel.L4:
        return this.handleL4(error, context, type);

      default:
        return this.handleL2(error, context, type);
    }
  }

  /**
   * L1: 自动重试
   */
  private async handleL1(
    error: Error,
    context: BridgeContext,
    type: ErrorType
  ): Promise<HandleResult> {
    const attempt = context.attempt ?? 1;

    if (attempt >= this.maxRetries) {
      // 超过重试次数，升级
      return this.escalate(error, context, type, 'Max retries exceeded');
    }

    this.emit('failure.retry', {
      meetingId: context.meetingId,
      taskId: context.taskId,
      roleId: context.roleId,
      type,
      attempt,
      maxRetries: this.maxRetries,
    });

    return {
      handled: true,
      action: 'retry',
      message: `Auto-retry attempt ${attempt + 1}/${this.maxRetries}`,
      data: { nextAttempt: attempt + 1, errorType: type },
    };
  }

  /**
   * L2: 人工干预
   */
  private async handleL2(
    error: Error,
    context: BridgeContext,
    type: ErrorType
  ): Promise<HandleResult> {
    // 发送通知
    if (this.notifier) {
      await this.notifier.notify({
        type: 'escalate',
        meetingId: context.meetingId,
        taskId: context.taskId,
        roleId: context.roleId,
        error,
        timestamp: new Date().toISOString(),
      });
    }

    this.emit('failure.escalate', {
      meetingId: context.meetingId,
      taskId: context.taskId,
      error: error.message,
      errorType: type,
      reason: 'L2 failure - requires human intervention',
    });

    return {
      handled: true,
      action: 'escalate',
      message: 'L2 failure - requires human intervention',
      data: { errorType: type },
    };
  }

  /**
   * L3: 开会讨论
   */
  private async handleL3(
    error: Error,
    context: BridgeContext,
    type: ErrorType
  ): Promise<HandleResult> {
    // 创建会议
    if (this.meetingCreator) {
      const meeting = await this.meetingCreator.create({
        title: `解决依赖阻塞: ${context.taskId}`,
        participants: context.participants ?? [],
        context: {
          taskId: context.taskId,
          error: error.message,
          previousMeetingId: context.meetingId,
        },
      });

      this.emit('failure.meeting', {
        meetingId: context.meetingId,
        newMeetingId: meeting.meetingId,
        taskId: context.taskId,
        error: error.message,
        errorType: type,
      });

      return {
        handled: true,
        action: 'meeting',
        message: 'Created meeting to resolve dependency block',
        data: { meetingId: meeting.meetingId, errorType: type },
      };
    }

    // 没有会议创建器，升级
    return this.escalate(error, context, type, 'No meeting creator available');
  }

  /**
   * L4: 回滚
   */
  private async handleL4(
    error: Error,
    context: BridgeContext,
    type: ErrorType
  ): Promise<HandleResult> {
    // 发送通知
    if (this.notifier) {
      await this.notifier.notify({
        type: 'rollback',
        meetingId: context.meetingId,
        taskId: context.taskId,
        roleId: context.roleId,
        error,
        timestamp: new Date().toISOString(),
      });
    }

    this.emit('failure.rollback', {
      meetingId: context.meetingId,
      taskId: context.taskId,
      error: error.message,
      errorType: type,
    });

    return {
      handled: true,
      action: 'rollback',
      message: 'L4 failure - rollback required',
      data: { errorType: type },
    };
  }

  /**
   * 升级处理
   */
  private async escalate(
    error: Error,
    context: BridgeContext,
    type: ErrorType,
    reason: string
  ): Promise<HandleResult> {
    if (this.notifier) {
      await this.notifier.notify({
        type: 'escalate',
        meetingId: context.meetingId,
        taskId: context.taskId,
        roleId: context.roleId,
        error,
        timestamp: new Date().toISOString(),
      });
    }

    this.emit('failure.escalate', {
      meetingId: context.meetingId,
      taskId: context.taskId,
      error: error.message,
      errorType: type,
      reason,
    });

    return {
      handled: true,
      action: 'escalate',
      message: `Escalated: ${reason}`,
      data: { errorType: type },
    };
  }

  /**
   * 发送事件
   */
  private emit(event: string, data: any): void {
    this.eventEmitter?.emit(event, data);
  }

  /**
   * 获取分类器（供外部使用）
   */
  getClassifier(): ErrorClassifier {
    return this.classifier;
  }

  /**
   * 获取记录器（供外部使用）
   */
  getRecorder(): FailureRecorder {
    return this.recorder;
  }
}

// ========================================
// 便捷导出
// ========================================

/**
 * 创建失败处理器
 */
export function createFailureHandler(config: FailureHandlerConfig): FailureHandler {
  return new FailureHandler(config);
}

// 重新导出 harness 类型，方便使用
export { ErrorType, FailureLevel } from '@dommaker/harness';
export type { FailureRecord } from '@dommaker/harness';
