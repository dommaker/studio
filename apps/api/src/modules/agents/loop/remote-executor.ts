/**
 * RemoteExecutor — §9.6 P2: 远程节点执行器
 *
 * 当 profile.nodeId !== 'local' (且非 undefined) 时，AgentLoop 构造时选 RemoteExecutor。
 * 通过 WebSocket 将 AgentTask 路由到对应节点的 daemon task-executor 执行，30s 超时。
 *
 * P2: WS 通道通过 WsGateway.sendAgentTask() 接通。
 *   - server → daemon: { type: 'agent-task', requestId, task: AgentTask }
 *   - daemon → server: { type: 'agent-task-result', requestId, result: ExecutionResult }
 */
import type { AgentTask, ExecutionResult } from '@dommaker/studio-agent';
import type { Executor } from './executor.js';
import { sendAgentTask } from '../../workspaces/ws-gateway.js';

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
 * 通过 WsGateway.sendAgentTask() 经 WS 发送 agent-task 消息，
 * 等待 daemon 回复 agent-task-result，30s 默认超时。
 * 无活跃连接或超时 → 抛 RemoteNodeUnreachableError，
 * 由调用方（AgentLoop）catch 并 fallback 到 NEED_INPUT。
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
   * 将 sendAgentTask 的通用 Error 包装为 RemoteNodeUnreachableError，
   * 供 AgentLoop 统一 catch 处理。
   */
  async execute(task: AgentTask): Promise<ExecutionResult> {
    try {
      return await sendAgentTask(this.nodeId, task, this.timeoutMs);
    } catch (err) {
      throw new RemoteNodeUnreachableError(
        this.nodeId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
