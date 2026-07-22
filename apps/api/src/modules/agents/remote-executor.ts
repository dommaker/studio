/**
 * RemoteExecutor — §9.6 P1: 远程节点执行器
 *
 * 当 profile.nodeId !== 'local' (且非 undefined) 时，AgentLoop 构造时选 RemoteExecutor。
 * 通过 WebSocket 将 AgentTask 路由到对应节点的 daemon task-executor 执行，30s 超时。
 *
 * P1: WS 通道基于现有 WsGateway 的 daemon 连接。
 *   - server → daemon: { type: 'agent-task', task: AgentTask }
 *   - daemon → server: { type: 'agent-task-result', executionId, result: ExecutionResult }
 */
import { agentRunner } from '@dommaker/studio-agent';
import type { AgentTask, ExecutionResult } from '@dommaker/studio-agent';
import type { Executor } from './executor.js';

/** 节点不可达时抛出的错误 */
export class RemoteNodeUnreachableError extends Error {
  constructor(nodeId: string, cause?: string) {
    super(`Remote node unreachable: ${nodeId}${cause ? ` (${cause})` : ''}`);
    this.name = 'RemoteNodeUnreachableError';
  }
}

/**
 * RemoteExecutor — 将 AgentTask 发送到远程节点的 daemon 执行。
 *
 * P1 impl: 如果在 WsGateway 中找不到 nodeId 对应的活跃连接 → 抛 RemoteNodeUnreachableError。
 * WS 消息发送 → Promise 等待 agent-task-result 响应 → 超时 30s。
 */
export class RemoteExecutor implements Executor {
  private nodeId: string;
  /** WS 消息超时 ms（默认 30s） */
  private timeoutMs: number;

  constructor(nodeId: string, timeoutMs = 30_000) {
    this.nodeId = nodeId;
    this.timeoutMs = timeoutMs;
  }

  /**
   * 通过 WsGateway 将任务发送到远程节点并等待结果。
   *
   * P1: WsGateway 的 sendAndWait 尚未实现 → 抛 RemoteNodeUnreachableError，
   * 由调用方（AgentLoop）catch 并 fallback 到 NEED_INPUT。
   */
  async execute(task: AgentTask): Promise<ExecutionResult> {
    // P1: WS 通道留桩 — 等待 WsGateway 暴露 sendAgentTask(nodeId, task): Promise<ExecutionResult>
    // 当前直接抛不可达错误，调用方 catch 并进入 need_input。
    throw new RemoteNodeUnreachableError(this.nodeId, 'WS agent-task channel not yet wired (P2)');
  }
}
