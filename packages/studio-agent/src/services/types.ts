/**
 * Executor 公共类型
 *
 * 原定义于 session-manager.ts（已随 AgentExecutor 删除），
 * 现由 agent-runner 门面与 runner-* 子模块共享。
 */

import type { ProviderId } from '@dommaker/studio-shared/node';
import type { ProgressReport } from './output-capture.js';

// ─── 配置类型 ───

export interface ExecutorConfig {
  worktreesDir: string;
  repoDir: string;
  taskTimeoutMinutes: number;
  sessionTimeoutMinutes: number;
  maxSessions: number;
}

// ─── 任务类型 ───

export interface AgentTask {
  id: string;
  executionId: string;
  provider: ProviderId;
  prompt: string;
  notifyTarget?: string;
  parameters?: {
    sessionId?: string;
    /** true = sessionId 指向已存在会话（续用），cli-adapter 按 provider 换 resume 语法（claude --resume） */
    sessionResume?: boolean;
    maxTurns?: number;
    knowledgeContext?: string;
    agentRole?: string;
    [key: string]: unknown;
  };
  /** 实时进度回调 — 每轮 session 后调用，用于推送到 Channel */
  onProgress?: (progress: ProgressReport, session: number) => Promise<void>;
  /**
   * 步内 stream-json 行回调（WU 过程可视化 Layer B）：CLI stdout 每个完整行到达即回调。
   * 仅 LocalExecutor 同进程有意义；RemoteExecutor 跨进程不可序列化，直接丢弃。
   */
  onStreamLine?: (line: string) => void;
  /** P3: 覆盖扁平默认超时 (ms)。提供时替代默认 30min。 */
  timeoutMs?: number;
  /** §9.6 P1: 远程节点 ID。undefined/'local' → LocalExecutor，否则 RemoteExecutor。 */
  nodeId?: string;
}

// ─── 执行结果 ───

export interface ExecutionResult {
  success: boolean;
  worktree: string;
  outputFiles: string[];
  error?: string;
  failureLog?: string; // 完整失败上下文（stdout+stderr），用于根因诊断
  logFile: string;
  sessionCount: number;
  totalDurationMs?: number;
  sessionIds?: string[]; // B9-014: collected session IDs for summary generation
  /** P9: 原始 stdout 文本（lightweight 模式产出，供调用方解析） */
  outputText?: string;
  /**
   * R2: 原始 stream-json stdout（lightweight 模式产出）。outputText 是
   * extractResult 后的纯文本（不含 stream-json 事件行），调用方需要解析
   * tool_use/usage 事件时必须使用本字段（如 agent-loop 的 tool:call 落盘）。
   */
  rawOutput?: string;
  /**
   * M2: CLI 回报的执行 token 用量（stream-json usage 聚合，extractUsage 产出）。
   * CLI 未回报 usage 时缺省 —— 调用方据此标记 executionSource='unavailable'，不编造 0。
   */
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
    model: string;
  };
}

// ─── 前置检查结果 ───

export interface PrerequisiteCheck {
  name: string;
  passed: boolean;
  message: string;
  isWarning?: boolean;
}
