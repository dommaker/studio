/**
 * Constraint Prompt Injection — 约束前置声明路由层（A3 删薄后）
 *
 * 只做 role → trigger 路由；生效集过滤、层级分组与文案渲染统一走
 * harness `renderConstraintsByTrigger`（H6/G6，与 init 注入/check 同一
 * getEffectiveConstraints 数据源）。此模块原在 harness 中
 * （@dommaker/harness），迁至 studio-shared 以解耦管道拓扑；A3 起渲染
 * 层回收到 harness，本文件不再手写过滤/分组。
 */

import { renderConstraintsByTrigger } from '@dommaker/harness';
import type { ConstraintTrigger } from '@dommaker/harness';

export type AgentRole = 'analyst' | 'executor' | 'integration' | 'reviewer' | 'deploy' | 'monitor' | 'triage';

export const ROLE_TRIGGERS: Record<AgentRole, ConstraintTrigger[]> = {
  analyst: ['design_request', 'api_change', 'code_implementation'],
  executor: ['code_implementation', 'task_completion_claim', 'test_creation', 'api_change', 'file_modification', 'module_modification', 'module_creation'],
  integration: ['code_implementation'],
  reviewer: ['code_implementation'],
  deploy: ['diagnosis'],
  monitor: ['monitoring', 'diagnosis'],
  triage: ['triage', 'diagnosis'],
};

export interface FormatConstraintsOptions {
  /** 项目根路径（决定 renderConstraintsByTrigger 的 config.yml 生效集），缺省 process.cwd() */
  projectRoot?: string;
}

/**
 * 按 agent role 路由生成注入 Agent system prompt 的约束段文本。
 * 渲染委托 harness renderConstraintsByTrigger（trigger 参数化分组渲染 API）。
 */
export function formatConstraintsForPrompt(role: AgentRole, options?: FormatConstraintsOptions): string {
  const triggers = ROLE_TRIGGERS[role];
  if (!triggers || triggers.length === 0) return '';
  return renderConstraintsByTrigger(triggers, options);
}
