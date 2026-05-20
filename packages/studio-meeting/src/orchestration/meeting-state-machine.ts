/**
 * 会议室状态机引擎
 * 
 * 功能：
 * 1. 8 状态转换（pending → discussing → designing → ... → completed）
 * 2. 门禁检查
 * 3. 状态持久化（乐观锁）
 * 4. 事件通知
 * 
 * 使用示例：
 * ```typescript
 * const stateMachine = createMeetingStateMachine({
 *   storage: redisStorage,
 *   gateChecker,
 *   listeners: [contextBridgeListener, notificationListener],
 * });
 * 
 * await stateMachine.transition('meeting-123', 'discussing', 'designing', {
 *   trigger: 'requirements_confirmed',
 * });
 * ```
 */

import type { ContextSharer } from './context-sharer';

/**
 * 会议室状态
 */
export type MeetingState =
  | 'pending'
  | 'discussing'
  | 'designing'
  | 'task_splitting'
  | 'executing'
  | 'testing'
  | 'reviewing'
  | 'completed';

/**
 * 状态转换触发器
 */
export type TransitionTrigger =
  | 'user_starts_meeting'
  | 'requirements_confirmed'
  | 'design_confirmed'
  | 'tasks_assigned'
  | 'implementation_done'
  | 'tests_passed'
  | 'review_passed'
  | 'tests_failed'
  | 'changes_requested';

/**
 * 状态机配置
 */
export interface StateMachineConfig {
  contextSharer: ContextSharer;
  gateChecker?: GateChecker;
  listeners?: StateListener[];
  eventEmitter?: {
    emit(event: string, data: any): void;
  };
}

/**
 * 门禁检查器接口
 */
export interface GateChecker {
  checkGates(meetingId: string, toState: MeetingState): Promise<GateCheckResult>;
}

/**
 * 门禁检查结果
 */
export interface GateCheckResult {
  passed: boolean;
  gates: GateResult[];
  failedGates: string[];
}

/**
 * 门禁结果
 */
export interface GateResult {
  name: string;
  passed: boolean;
  message?: string;
}

/**
 * 状态转换事件
 */
export interface TransitionEvent {
  meetingId: string;
  taskId?: string;
  from: MeetingState;
  to: MeetingState;
  trigger: TransitionTrigger;
  timestamp: string;
  gates: GateResult[];
  signatures: Signature[];
}

/**
 * 签名
 */
export interface Signature {
  roleId: string;
  signedAt: string;
  approved: boolean;
}

/**
 * 状态持久化记录
 */
export interface MeetingStateRecord {
  meetingId: string;
  currentState: MeetingState;
  previousState: MeetingState | null;
  lastTransition: string | null;
  transitionHistory: TransitionEntry[];
  version: number;
  updatedAt: string;
}

/**
 * 转换历史条目
 */
export interface TransitionEntry {
  from: MeetingState;
  to: MeetingState;
  trigger: TransitionTrigger;
  timestamp: string;
  gatesPassed: boolean;
  signatures: Signature[];
}

/**
 * 转换请求
 */
export interface TransitionRequest {
  trigger: TransitionTrigger;
  taskId?: string;
  signatures?: Signature[];
  skipGates?: boolean; // 紧急情况跳过门禁
}

/**
 * 状态机错误
 */
export class StateMachineError extends Error {
  constructor(
    message: string,
    public code: string,
    public details?: any
  ) {
    super(message);
    this.name = 'StateMachineError';
  }
}

export class GateFailedError extends StateMachineError {
  constructor(public gates: GateResult[]) {
    super('Gate check failed', 'GATE_FAILED', { gates });
  }
}

export class InvalidTransitionError extends StateMachineError {
  constructor(from: MeetingState, to: MeetingState) {
    super(`Invalid transition: ${from} → ${to}`, 'INVALID_TRANSITION', { from, to });
  }
}

export class VersionConflictError extends StateMachineError {
  constructor(expected: number, actual: number) {
    super('Version conflict - state changed by another process', 'VERSION_CONFLICT', { expected, actual });
  }
}

/**
 * 状态转换定义
 */
const TRANSITIONS: Record<MeetingState, { to: MeetingState; trigger: TransitionTrigger; gates: string[] }[]> = {
  pending: [
    { to: 'discussing', trigger: 'user_starts_meeting', gates: [] },
  ],
  discussing: [
    { to: 'designing', trigger: 'requirements_confirmed', gates: ['requirements_doc_exists', 'all_roles_signed'] },
  ],
  designing: [
    { to: 'task_splitting', trigger: 'design_confirmed', gates: ['design_doc_exists', 'api_contract_defined', 'all_roles_signed'] },
  ],
  task_splitting: [
    { to: 'executing', trigger: 'tasks_assigned', gates: ['tasks_yml_valid', 'all_tasks_have_assignee'] },
  ],
  executing: [
    { to: 'testing', trigger: 'implementation_done', gates: ['code_compiles', 'tests_exist'] },
  ],
  testing: [
    { to: 'reviewing', trigger: 'tests_passed', gates: ['coverage_threshold', 'no_lint_errors'] },
    { to: 'executing', trigger: 'tests_failed', gates: [] },
  ],
  reviewing: [
    { to: 'completed', trigger: 'review_passed', gates: ['approval_count', 'no_merge_conflicts'] },
    { to: 'executing', trigger: 'changes_requested', gates: [] },
  ],
  completed: [],
};

/**
 * 会议室状态机
 */
export class MeetingStateMachine {
  private contextSharer: ContextSharer;
  private gateChecker?: GateChecker;
  private listeners: StateListener[];
  private eventEmitter?: { emit(event: string, data: any): void };

  constructor(config: StateMachineConfig) {
    this.contextSharer = config.contextSharer;
    this.gateChecker = config.gateChecker;
    this.listeners = config.listeners ?? [];
    this.eventEmitter = config.eventEmitter;
  }

  /**
   * 初始化状态机
   */
  async initialize(meetingId: string): Promise<MeetingStateRecord> {
    const record: MeetingStateRecord = {
      meetingId,
      currentState: 'pending',
      previousState: null,
      lastTransition: null,
      transitionHistory: [],
      version: 1,
      updatedAt: new Date().toISOString(),
    };

    await this.saveState(record);
    return record;
  }

  /**
   * 执行状态转换
   */
  async transition(
    meetingId: string,
    toState: MeetingState,
    request: TransitionRequest
  ): Promise<MeetingStateRecord> {
    // 获取当前状态（乐观锁）
    const current = await this.getState(meetingId);
    if (!current) {
      throw new StateMachineError('Meeting not initialized', 'NOT_INITIALIZED');
    }

    const fromState = current.currentState;

    // 验证转换是否有效
    if (!this.isValidTransition(fromState, toState, request.trigger)) {
      throw new InvalidTransitionError(fromState, toState);
    }

    // 检查门禁
    let gates: GateResult[] = [];
    if (!request.skipGates && this.gateChecker) {
      const gateResult = await this.gateChecker.checkGates(meetingId, toState);
      if (!gateResult.passed) {
        throw new GateFailedError(gateResult.gates);
      }
      gates = gateResult.gates;
    }

    // 更新状态（乐观锁）
    const newRecord: MeetingStateRecord = {
      ...current,
      currentState: toState,
      previousState: fromState,
      lastTransition: request.trigger,
      transitionHistory: [
        ...current.transitionHistory,
        {
          from: fromState,
          to: toState,
          trigger: request.trigger,
          timestamp: new Date().toISOString(),
          gatesPassed: gates.every(g => g.passed),
          signatures: request.signatures ?? [],
        },
      ],
      version: current.version + 1,
      updatedAt: new Date().toISOString(),
    };

    // 乐观锁保存
    await this.saveStateWithVersion(newRecord, current.version);

    // 构建事件
    const event: TransitionEvent = {
      meetingId,
      taskId: request.taskId,
      from: fromState,
      to: toState,
      trigger: request.trigger,
      timestamp: new Date().toISOString(),
      gates,
      signatures: request.signatures ?? [],
    };

    // 通知监听器
    await this.notifyListeners(event);

    // 发送事件
    this.emit('state.transitioned', event);

    return newRecord;
  }

  /**
   * 获取当前状态
   */
  async getState(meetingId: string): Promise<MeetingStateRecord | null> {
    return this.contextSharer.getValue<MeetingStateRecord>(`state:${meetingId}`);
  }

  /**
   * 获取转换历史
   */
  async getHistory(meetingId: string): Promise<TransitionEntry[]> {
    const state = await this.getState(meetingId);
    return state?.transitionHistory ?? [];
  }

  /**
   * 添加监听器
   */
  addListener(listener: StateListener): void {
    this.listeners.push(listener);
  }

  /**
   * 移除监听器
   */
  removeListener(listener: StateListener): void {
    const index = this.listeners.indexOf(listener);
    if (index > -1) {
      this.listeners.splice(index, 1);
    }
  }

  // ============================================
  // 私有方法
  // ============================================

  /**
   * 验证转换是否有效
   */
  private isValidTransition(
    from: MeetingState,
    to: MeetingState,
    trigger: TransitionTrigger
  ): boolean {
    const validTransitions = TRANSITIONS[from];
    return validTransitions.some(t => t.to === to && t.trigger === trigger);
  }

  /**
   * 保存状态
   */
  private async saveState(record: MeetingStateRecord): Promise<void> {
    await this.contextSharer.set(`state:${record.meetingId}`, record);
  }

  /**
   * 乐观锁保存
   */
  private async saveStateWithVersion(
    record: MeetingStateRecord,
    expectedVersion: number
  ): Promise<void> {
    const current = await this.getState(record.meetingId);
    
    if (current && current.version !== expectedVersion) {
      throw new VersionConflictError(expectedVersion, current.version);
    }

    await this.saveState(record);
  }

  /**
   * 通知监听器
   */
  private async notifyListeners(event: TransitionEvent): Promise<void> {
    for (const listener of this.listeners) {
      try {
        await listener.onTransition(event);
      } catch (error) {
        console.error('[StateMachine] Listener error:', error);
        // 继续通知其他监听器
      }
    }
  }

  /**
   * 发送事件
   */
  private emit(event: string, data: any): void {
    this.eventEmitter?.emit(event, data);
  }
}

/**
 * 状态监听器接口
 */
export interface StateListener {
  onTransition(event: TransitionEvent): void | Promise<void>;
  onError?(event: ErrorEvent): void | Promise<void>;
}

/**
 * 错误事件
 */
export interface ErrorEvent {
  meetingId: string;
  error: Error;
  context?: any;
  timestamp: string;
}

/**
 * 创建状态机（便捷函数）
 */
export function createMeetingStateMachine(config: StateMachineConfig): MeetingStateMachine {
  return new MeetingStateMachine(config);
}
