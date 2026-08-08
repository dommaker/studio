/**
 * §9.6 Executor 接口 — AgentLoop 执行面抽象（P0）
 *
 * 任务生命周期只有一份（claim、状态机、token 度量、会话管理…全部留在 AgentLoop），
 * Executor 只负责「执行 AgentTask 并返回结果」。当前仅有 LocalExecutor（P0）——
 * 远程节点执行方向已放弃，RemoteExecutor 于 2026-08 删除。
 */
import { agentRunner } from '@dommaker/studio-agent';
import type { AgentTask, ExecutionResult } from '@dommaker/studio-agent';

/** 执行器接口：输入 AgentTask（agent-loop 已构建的形状），输出 ExecutionResult。 */
export interface Executor {
  execute(task: AgentTask): Promise<ExecutionResult>;
}

/**
 * P0: 本地执行器 — 原样委托现有 agentRunner.executeLightweight 路径（纯重构，零行为变化）。
 */
export class LocalExecutor implements Executor {
  execute(task: AgentTask): Promise<ExecutionResult> {
    return agentRunner.executeLightweight(task);
  }
}
