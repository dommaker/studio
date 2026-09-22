/**
 * Runner Output — 输出解析（agent-runner.ts 拆分模块）
 *
 * 从 agent-runner.ts 按职责拆出的执行输出/状态解析逻辑：
 *   - processSessionOutput: spawn 尾部管线（写 .agent.log → stream-json 解析 →
 *     tool/file 事件 → session 指标 → session:end），runner-lightweight 消费
 *     （Wave-4 抽取时原为两处近乎逐字的副本，#562 删多 session 循环后只剩一处）
 *
 * isError 的告警/分支语义由调用方决定（lightweight 返回失败），故不收敛进本模块。
 * 本文件曾另有 worktree mtime 探测与 RKB 解法查询两个 helper，唯一调用方随 #562 的
 * 多 session 循环删除（#587 摘除）。RKB 匹配核心在 studio-shared/resolutions.ts，
 * 活消费方是 apps/api knowledge/resolution.service.ts。
 */

import * as fsSync from 'fs';
import {
  parseStreamEvents,
  extractToolCalls,
  extractFilePath as extractFilePathShared,
  extractResult,
  extractUsage,
  extractProviderUsage,
} from '@dommaker/studio-shared';
import type { StreamEvent } from '@dommaker/studio-shared';
import {
  recordSessionMetrics,
  emitSessionEnd,
  emitToolCall,
  emitFileChange,
  getConstraintMeta,
  type SessionEventExtras,
} from './output-capture.js';

/** extractUsage 的聚合 token 用量类型（CLI 未回报时各项为 0）。 */
export type StreamUsage = ReturnType<typeof extractUsage>;

/** processSessionOutput 的调用上下文（两个执行路径的差异项全部由 ctx 传入）。 */
export interface ProcessSessionOutputContext {
  logFile: string;
  sessionId: string;
  executionId: string;
  sessionCount: number;
  isFirstSession: boolean;
  /** 调用方算好的 session 耗时（Date.now() - sessionStart）。 */
  sessionMs: number;
  agentRole: string;
  stage?: string;
  promptSize: number;
  /** #134: 执行 CLI 的 provider——usage 提取按 provider 分流（缺省 claude，行为不变）。 */
  provider?: string;
  /**
   * #361: session:start 的 extras 原样透传给本路径发射的 session:end —— 此前成功
   * 路径的 end 丢失 workUnitId/transcriptPath，同一事件两种 payload 形态。
   */
  sessionExtras?: SessionEventExtras;
}

export interface ProcessedSessionOutput {
  text: string;
  isError: boolean;
  streamUsage: StreamUsage;
  events: StreamEvent[];
}

/**
 * Spawn 尾部管线：落盘原始 stdout → 解析 stream-json → 发射 tool:call/file:change →
 * 记录 session 指标 → 发射 session:end。
 *
 * 返回解析结果供调用方分支：execution 路径据此累计跨 session token 并续接循环，
 * lightweight 路径据此组装 ExecutionResult。isError 的告警/失败分支留在调用方
 * （两处语义不同，见模块头注释）。
 */
export async function processSessionOutput(
  stdout: string,
  ctx: ProcessSessionOutputContext,
): Promise<ProcessedSessionOutput> {
  fsSync.writeFileSync(ctx.logFile, stdout, 'utf-8');

  // AC1.1 + AC1.3: Parse stream-json line by line
  const events = parseStreamEvents(stdout);
  const { text, isError } = extractResult(events);
  // #134: usage 提取按 provider 分流——claude/缺省走既有 extractUsage（行为不变），
  // opencode/codex 走 per-provider 提取器（事件形态不同，extractUsage 恒产 0）。
  const providerUsage = ctx.provider && ctx.provider !== 'claude'
    ? extractProviderUsage(ctx.provider, stdout)
    : null;
  const streamUsage: StreamUsage = providerUsage
    ? {
        inputTokens: providerUsage.inputTokens,
        outputTokens: providerUsage.outputTokens,
        cacheReadTokens: providerUsage.cacheReadTokens,
        cacheCreationTokens: providerUsage.cacheCreationTokens,
        model: providerUsage.model ?? '',
      }
    : extractUsage(events);

  // AC1.3: Emit tool:call and file:change events
  // #602 D4: 透传真实 success（tool_result 配对）与 caller（agentRole）
  const tools = extractToolCalls(events);
  for (const tool of tools) {
    await emitToolCall(tool.name, tool.input, ctx.sessionId, ctx.executionId, { success: tool.success, caller: ctx.agentRole });
    const filePath = extractFilePathShared(tool.name, tool.input);
    if (filePath) {
      await emitFileChange(filePath, ctx.sessionId, ctx.executionId);
    }
  }

  // Record session metrics
  const { hash, size } = await getConstraintMeta();
  await recordSessionMetrics({
    stdout,
    executionId: ctx.executionId,
    agentRole: ctx.agentRole,
    stage: ctx.stage,
    sessionCount: ctx.sessionCount,
    isFirstSession: ctx.isFirstSession,
    sessionMs: ctx.sessionMs,
    promptSize: ctx.promptSize,
    constraintHash: hash,
    constraintSize: size,
    streamUsage,
  });

  await emitSessionEnd(ctx.sessionId, ctx.executionId, ctx.sessionCount, ctx.sessionExtras);

  return { text, isError, streamUsage, events };
}
