/**
 * Constraint Prompt Injection — 将 harness 约束的前置声明注入 Agent prompt
 *
 * 从 harness 读取约束定义，按 agent role 路由，生成注入 Agent system prompt 的文本。
 * 此模块原在 harness 中（@dommaker/harness），迁至 studio-shared 以解耦管道拓扑。
 */
import type { ConstraintTrigger } from '@dommaker/harness';
export type AgentRole = 'analyst' | 'executor' | 'integration' | 'reviewer' | 'deploy' | 'monitor' | 'triage';
export declare const ROLE_TRIGGERS: Record<AgentRole, ConstraintTrigger[]>;
/**
 * Format all applicable constraints as a prompt injection section for a given agent role.
 * Uses the existing promptInjection field from each constraint definition.
 */
export declare function formatConstraintsForPrompt(role: AgentRole): string;
//# sourceMappingURL=prompt-injection.d.ts.map