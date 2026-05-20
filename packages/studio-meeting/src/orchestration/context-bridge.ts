/**
 * 上下文桥接器
 * 
 * 功能：
 * 1. 从会议室提取任务上下文（extract）
 * 2. 转换共享上下文为角色上下文（transform）
 * 3. Token 裁剪保持在预算内（prune）
 * 4. 调用 Skill Agent 执行（invokeSkillAgent）
 * 5. 执行结果回传（reportBack）
 * 
 * 使用示例：
 * ```typescript
 * import { createContextBridge } from './context-bridge';
 * 
 * const bridge = createContextBridge({
 *   contextSharer,
 *   skillExecutor,
 * });
 * 
 * // 执行角色任务
 * const result = await bridge.execute({
 *   meetingId: 'meeting-123',
 *   taskId: 'task-456',
 *   roleId: 'frontend-dev',
 *   skillId: 'implement-ui',
 *   tokenBudget: 8000,
 * });
 * ```
 */

import type { ContextSharer, MeetingMeta, MeetingDecision, MeetingContextProgressive } from './context-sharer';

/**
 * 桥接器配置
 */
export interface ContextBridgeConfig {
  contextSharer: ContextSharer;
  skillExecutor: BridgeSkillExecutor;
  eventEmitter?: {
    emit(event: string, data: any): void;
  };
  defaultTokenBudget?: number;
}

/**
 * Skill 执行器接口（ContextBridge 专用）
 * 
 * 注意：此接口用于 ContextBridge 依赖注入
 * 实际实现在 skill-executor.ts 的 SkillExecutor 类
 */
export interface BridgeSkillExecutor {
  execute(config: BridgeSkillConfig): Promise<BridgeSkillResult>;
}

/**
 * Skill 执行配置（ContextBridge 专用）
 */
export interface BridgeSkillConfig {
  skillId: string;
  input: Record<string, any>;
  context: string;
  roleId: string;
  workdir?: string;
  timeout?: number;
}

/**
 * Skill 执行结果（ContextBridge 专用）
 */
export interface BridgeSkillResult {
  success: boolean;
  output?: any;
  error?: string;
  duration?: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
}

/**
 * 桥接执行请求
 */
export interface BridgeExecutionRequest {
  meetingId: string;
  taskId: string;
  roleId: string;
  skillId: string;
  tokenBudget?: number;
  workdir?: string;
  timeout?: number;
  /**
   * 渐进式披露阶段（1-4）
   * 1: 仅元数据
   * 2: 元数据 + 决策
   * 3: 元数据 + 决策 + 摘要
   * 4: 完整上下文
   */
  disclosureStage?: 1 | 2 | 3 | 4;
}

/**
 * 桥接执行结果
 */
export interface BridgeExecutionResult {
  success: boolean;
  roleId: string;
  skillId: string;
  output?: any;
  error?: string;
  tokenUsage: {
    context: number;
    execution: number;
    total: number;
  };
  duration: number;
  contextSummary: {
    stage: number;
    entriesLoaded: number;
    entriesPruned: number;
  };
}

/**
 * 角色上下文
 */
export interface RoleContext {
  roleId: string;
  taskId: string;
  meetingMeta: MeetingMeta | null;
  decisions: MeetingDecision[] | null;
  summary: string | null;
  /**
   * 角色特定的上下文
   * 如：前端角色需要的 API 契约
   */
  roleSpecific: Record<string, any>;
  /**
   * 任务规格
   */
  taskSpec?: TaskSpec;
}

/**
 * 任务规格
 */
export interface TaskSpec {
  id: string;
  title: string;
  description: string;
  inputs: string[];
  outputs: string[];
  constraints: string[];
  dependencies: string[];
}

/**
 * Token 预算配置
 */
export const TOKEN_BUDGET = {
  LAYER1_SUMMARY: 500,
  LAYER2_DOCUMENTS: 2000,
  LAYER3_FULL: 10000,
  MESSAGE_SUMMARY: 100,
  MESSAGE_DETAIL: 500,
} as const;

/**
 * 上下文桥接器
 */
export class ContextBridge {
  private contextSharer: ContextSharer;
  private skillExecutor: BridgeSkillExecutor;
  private eventEmitter?: { emit(event: string, data: any): void };
  private defaultTokenBudget: number;

  constructor(config: ContextBridgeConfig) {
    this.contextSharer = config.contextSharer;
    this.skillExecutor = config.skillExecutor;
    this.eventEmitter = config.eventEmitter;
    this.defaultTokenBudget = config.defaultTokenBudget ?? TOKEN_BUDGET.LAYER3_FULL;
  }

  /**
   * 执行角色任务（主入口）
   */
  async execute(request: BridgeExecutionRequest): Promise<BridgeExecutionResult> {
    const startTime = Date.now();
    const { meetingId, taskId, roleId, skillId, disclosureStage = 2 } = request;
    const tokenBudget = request.tokenBudget ?? this.defaultTokenBudget;

    this.emit('bridge.started', { meetingId, taskId, roleId, skillId, tokenBudget });

    try {
      // Step 1: 提取共享上下文
      const rawContext = await this.extract(meetingId, disclosureStage);

      // Step 2: 转换为角色上下文
      const roleContext = await this.transform(rawContext, roleId, taskId);

      // Step 3: Token 裁剪
      const prunedContext = await this.prune(roleContext, tokenBudget);

      // Step 4: 调用 Skill Agent
      const skillResult = await this.invokeSkillAgent(
        skillId,
        prunedContext,
        roleId,
        request.workdir,
        request.timeout
      );

      // Step 5: 结果回传
      await this.reportBack(meetingId, taskId, roleId, skillResult);

      const duration = Date.now() - startTime;

      const result: BridgeExecutionResult = {
        success: skillResult.success,
        roleId,
        skillId,
        output: skillResult.output,
        error: skillResult.error,
        tokenUsage: {
          context: prunedContext.tokenCount,
          execution: skillResult.tokenUsage?.total ?? 0,
          total: prunedContext.tokenCount + (skillResult.tokenUsage?.total ?? 0),
        },
        duration,
        contextSummary: {
          stage: disclosureStage,
          entriesLoaded: rawContext.entriesCount,
          entriesPruned: prunedContext.prunedCount,
        },
      };

      this.emit('bridge.completed', result);
      return result;

    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      this.emit('bridge.failed', { meetingId, taskId, roleId, error: errorMessage });

      return {
        success: false,
        roleId,
        skillId,
        error: errorMessage,
        tokenUsage: { context: 0, execution: 0, total: 0 },
        duration,
        contextSummary: { stage: disclosureStage, entriesLoaded: 0, entriesPruned: 0 },
      };
    }
  }

  /**
   * Step 1: 从会议室提取共享上下文
   */
  async extract(
    meetingId: string,
    stage: 1 | 2 | 3 | 4 = 2
  ): Promise<ExtractedContext> {
    // 使用渐进式披露加载会议上下文
    const progressiveContext = await this.contextSharer.getMeetingContext(meetingId, stage);

    // 计算条目数
    let entriesCount = 0;
    if (progressiveContext.meta) entriesCount++;
    if (progressiveContext.decisions) entriesCount += progressiveContext.decisions.length;
    if (progressiveContext.summary) entriesCount++;
    if (progressiveContext.messages) entriesCount += progressiveContext.messages.length;

    return {
      meetingId,
      stage,
      progressiveContext,
      entriesCount,
      extractedAt: new Date().toISOString(),
    };
  }

  /**
   * Step 2: 将共享上下文转换为角色上下文
   */
  async transform(
    rawContext: ExtractedContext,
    roleId: string,
    taskId: string
  ): Promise<RoleContext> {
    const { progressiveContext } = rawContext;

    // 基础角色上下文
    const roleContext: RoleContext = {
      roleId,
      taskId,
      meetingMeta: progressiveContext.meta,
      decisions: progressiveContext.decisions,
      summary: progressiveContext.summary,
      roleSpecific: {},
    };

    // 提取角色特定的上下文
    // 例如：前端角色需要提取 API 契约
    if (progressiveContext.decisions) {
      roleContext.roleSpecific.apiContracts = this.extractApiContracts(
        progressiveContext.decisions,
        roleId
      );
    }

    // 提取任务规格（如果有）
    const taskSpec = await this.contextSharer.getValue<TaskSpec>(`task:${taskId}:spec`);
    if (taskSpec) {
      roleContext.taskSpec = taskSpec;
    }

    return roleContext;
  }

  /**
   * Step 3: Token 裁剪
   */
  async prune(
    roleContext: RoleContext,
    tokenBudget: number
  ): Promise<PrunedContext> {
    // 估算当前 token 数
    let tokenCount = this.estimateTokens(roleContext);
    let prunedCount = 0;

    // 如果在预算内，直接返回
    if (tokenCount <= tokenBudget) {
      return {
        context: roleContext,
        tokenCount,
        prunedCount: 0,
        pruned: false,
      };
    }

    // 需要裁剪
    const prunedContext = { ...roleContext };

    // 裁剪策略：
    // 1. 先裁剪摘要（保留最关键信息）
    if (prunedContext.summary && tokenCount > tokenBudget) {
      const originalLength = prunedContext.summary.length;
      prunedContext.summary = this.truncateSummary(prunedContext.summary, tokenBudget * 0.3);
      tokenCount = this.estimateTokens(prunedContext);
      prunedCount++;
    }

    // 2. 裁剪决策（保留同意的决策）
    if (prunedContext.decisions && tokenCount > tokenBudget) {
      prunedContext.decisions = prunedContext.decisions.filter(d => d.agreed);
      tokenCount = this.estimateTokens(prunedContext);
      prunedCount++;
    }

    // 3. 裁剪角色特定上下文
    if (prunedContext.roleSpecific && Object.keys(prunedContext.roleSpecific).length > 0 && tokenCount > tokenBudget) {
      // 只保留最关键的
      const keys = Object.keys(prunedContext.roleSpecific);
      const keepKeys = keys.slice(0, Math.ceil(keys.length / 2));
      const filtered: Record<string, any> = {};
      for (const key of keepKeys) {
        filtered[key] = prunedContext.roleSpecific[key];
      }
      prunedContext.roleSpecific = filtered;
      tokenCount = this.estimateTokens(prunedContext);
      prunedCount++;
    }

    return {
      context: prunedContext,
      tokenCount,
      prunedCount,
      pruned: true,
    };
  }

  /**
   * Step 4: 调用 Skill Agent 执行
   */
  async invokeSkillAgent(
    skillId: string,
    prunedContext: PrunedContext,
    roleId: string,
    workdir?: string,
    timeout?: number
  ): Promise<BridgeSkillResult> {
    // 构建上下文字符串
    const contextString = this.buildContextString(prunedContext.context);

    // 构建输入
    const input: Record<string, any> = {
      taskId: prunedContext.context.taskId,
      meetingId: prunedContext.context.meetingMeta?.meetingId,
      taskSpec: prunedContext.context.taskSpec,
    };

    // 调用 Skill 执行器
    return this.skillExecutor.execute({
      skillId,
      input,
      context: contextString,
      roleId,
      workdir,
      timeout,
    });
  }

  /**
   * Step 5: 执行结果回传
   */
  async reportBack(
    meetingId: string,
    taskId: string,
    roleId: string,
    result: BridgeSkillResult
  ): Promise<void> {
    // 存储执行结果
    const executionRecord: ExecutionRecord = {
      meetingId,
      taskId,
      roleId,
      success: result.success,
      output: result.output,
      error: result.error,
      duration: result.duration,
      tokenUsage: result.tokenUsage,
      completedAt: new Date().toISOString(),
    };

    await this.contextSharer.set(`execution:${taskId}:${roleId}`, executionRecord);

    // 更新任务状态
    if (result.success) {
      await this.contextSharer.set(`task:${taskId}:status`, 'completed');
    } else {
      await this.contextSharer.set(`task:${taskId}:status`, 'failed');
      await this.contextSharer.set(`task:${taskId}:error`, result.error);
    }

    this.emit('bridge.reported', { meetingId, taskId, roleId, success: result.success });
  }

  // ============================================
  // 私有方法
  // ============================================

  /**
   * 提取 API 契约
   */
  private extractApiContracts(
    decisions: MeetingDecision[],
    roleId: string
  ): ApiContract[] {
    const contracts: ApiContract[] = [];

    for (const decision of decisions) {
      // 查找 API 相关的决策
      if (decision.content.includes('API') || decision.content.includes('接口')) {
        contracts.push({
          description: decision.content,
          roles: decision.roles,
        });
      }
    }

    return contracts;
  }

  /**
   * 估算 token 数
   * 简单估算：1 token ≈ 4 字符（中文）或 0.75 词（英文）
   */
  private estimateTokens(context: RoleContext): number {
    let total = 0;

    // 元数据
    if (context.meetingMeta) {
      total += Math.ceil(JSON.stringify(context.meetingMeta).length / 4);
    }

    // 决策
    if (context.decisions) {
      for (const decision of context.decisions) {
        total += Math.ceil(decision.content.length / 4);
      }
    }

    // 摘要
    if (context.summary) {
      total += Math.ceil(context.summary.length / 4);
    }

    // 任务规格
    if (context.taskSpec) {
      total += Math.ceil(JSON.stringify(context.taskSpec).length / 4);
    }

    // 角色特定
    if (context.roleSpecific) {
      total += Math.ceil(JSON.stringify(context.roleSpecific).length / 4);
    }

    return total;
  }

  /**
   * 截断摘要
   */
  private truncateSummary(summary: string, maxTokens: number): string {
    const maxChars = maxTokens * 4; // 估算
    if (summary.length <= maxChars) {
      return summary;
    }

    // 截断并保留关键信息
    const truncated = summary.substring(0, maxChars);
    const lastSentence = truncated.lastIndexOf('。');
    const lastPeriod = truncated.lastIndexOf('.');

    const cutPoint = Math.max(lastSentence, lastPeriod);
    if (cutPoint > maxChars * 0.8) {
      return truncated.substring(0, cutPoint + 1);
    }

    return truncated + '...';
  }

  /**
   * 构建上下文字符串
   */
  private buildContextString(context: RoleContext): string {
    const parts: string[] = [];

    // 任务信息
    if (context.taskSpec) {
      parts.push(`# 任务：${context.taskSpec.title}`);
      parts.push(context.taskSpec.description);
      parts.push('');
    }

    // 会议决策
    if (context.decisions && context.decisions.length > 0) {
      parts.push('## 会议决策');
      for (const decision of context.decisions) {
        const status = decision.agreed ? '✅' : '❌';
        parts.push(`${status} ${decision.content}`);
      }
      parts.push('');
    }

    // API 契约
    if (context.roleSpecific.apiContracts) {
      parts.push('## API 契约');
      for (const contract of context.roleSpecific.apiContracts as ApiContract[]) {
        parts.push(`- ${contract.description}`);
      }
      parts.push('');
    }

    // 约束
    if (context.taskSpec?.constraints) {
      parts.push('## 约束条件');
      for (const constraint of context.taskSpec.constraints) {
        parts.push(`- ${constraint}`);
      }
      parts.push('');
    }

    return parts.join('\n');
  }

  /**
   * 发送事件
   */
  private emit(event: string, data: any): void {
    this.eventEmitter?.emit(event, data);
  }
}

// ============================================
// 类型定义
// ============================================

/**
 * 提取的上下文
 */
export interface ExtractedContext {
  meetingId: string;
  stage: number;
  progressiveContext: MeetingContextProgressive;
  entriesCount: number;
  extractedAt: string;
}

/**
 * 裁剪后的上下文
 */
export interface PrunedContext {
  context: RoleContext;
  tokenCount: number;
  prunedCount: number;
  pruned: boolean;
}

/**
 * API 契约
 */
export interface ApiContract {
  description: string;
  roles?: string[];
}

/**
 * 执行记录
 */
export interface ExecutionRecord {
  meetingId: string;
  taskId: string;
  roleId: string;
  success: boolean;
  output?: any;
  error?: string;
  duration?: number;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
  };
  completedAt: string;
}

/**
 * 创建上下文桥接器（便捷函数）
 */
export function createContextBridge(config: ContextBridgeConfig): ContextBridge {
  return new ContextBridge(config);
}
