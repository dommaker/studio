/**
 * MCP Tools 注册门面
 *
 * 将 Studio 模块暴露为 MCP tools，供 Agent 和 UI 共享调用。
 * FL-026: 使用 MCPToolRegistry 动态注册，替代静态数组。
 * T3 拆分：工具定义按域迁至 *.tools.ts（共享 FileStore 助手在 tool-store.ts），
 * 本文件保留注册顺序、风险级别标注、权限种子与执行门面。
 */

import { logger } from '@dommaker/studio-shared';
import { toolRegistry, type RegisteredTool } from './tool-registry.js';
import { mcpPermissionService } from './permission.service.js';
import { pmoTools } from './pmo.tools.js';
import { taskTools } from './task.tools.js';
import { knowledgeTools } from './knowledge.tools.js';
import { economyTools } from './economy.tools.js';
import { specTools } from './spec.tools.js';
import { safetyTools } from './safety.tools.js';
import { systemTools } from './system.tools.js';
import { devopsTools } from './devops.tools.js';
import { skillTools } from './skill.tools.js';
import { workunitTools } from './workunit.tools.js';

// ─── 类型（向后兼容） ───

export type MCPTool = RegisteredTool;

// ─── 注册所有 tools ───

const allTools: RegisteredTool[] = [
  // PMO 项目
  ...pmoTools,
  // 任务
  ...taskTools,
  // 知识库
  ...knowledgeTools,
  // 经济
  ...economyTools,
  // 规格审查
  ...specTools,
  // 安全
  ...safetyTools,
  // Agent-First 系统
  ...systemTools,
  // DevOps
  ...devopsTools,
  // Skill 按需加载
  ...skillTools,
  // WorkUnit
  ...workunitTools,
];

// FL-026: Register all tools into the registry on module load
// G2: assign risk levels based on operation type
for (const tool of allTools) {
  if (/^(create|store|extract|settle|spawn|approve|send|end|assign|update)/.test(tool.name)) {
    tool.riskLevel = 'medium';
  } else if (/^delete|^drop|^truncate/.test(tool.name)) {
    tool.riskLevel = 'high';
  } else {
    tool.riskLevel = 'low';
  }
}
toolRegistry.registerAll(allTools);

// BP3: 种子 default-deny 权限 — 系统角色默认允许所有工具
import('./permission.service.js').then(({ seedDefaultPermissions }) => {
  seedDefaultPermissions(allTools.map(t => t.name)).catch((e) => {
    logger.warn('[MCP] seedDefaultPermissions failed — tools may lack default permissions', { error: String(e) });
  });
});

/**
 * 获取所有 tool 的 schema（不含 handler）— 向后兼容
 */
export function getToolSchemas() {
  return toolRegistry.getSchemas();
}

/**
 * 按名称查找并执行 tool（FL-026: 带权限检查 + 限流 + 审计）
 */
export async function executeTool(
  name: string,
  input: Record<string, any>,
  roleId?: string,
  traceCtx?: { executionId?: string; goalId?: string },
) {
  const tool = toolRegistry.get(name);
  if (!tool || !tool.enabled) {
    throw new Error(`Unknown or disabled tool: ${name}`);
  }

  // Rate limit check
  const rateCheck = toolRegistry.checkRateLimit(name);
  if (!rateCheck.allowed) {
    throw new Error(`Rate limit exceeded for tool "${name}". Retry after ${rateCheck.retryAfterMs}ms`);
  }

  // Permission check — default to 'executor' for local agents (Claude CLI)
  const effectiveRoleId = roleId || 'executor';
  const allowed = await mcpPermissionService.isAllowed(effectiveRoleId, name);
  if (!allowed) {
    throw new Error(`Permission denied: role ${effectiveRoleId} is not allowed to call tool "${name}"`);
  }

  logger.info('MCP tool execution', { tool: name, roleId: effectiveRoleId, ...traceCtx, input });
  const start = Date.now();
  let success = false;
  let result: any;
  let error: string | undefined;

  try {
    result = await tool.handler(input);
    success = true;
    return { success: true, result, duration: Date.now() - start };
  } catch (e) {
    error = String(e);
    throw e;
  } finally {
    const duration = Date.now() - start;
    const caller = traceCtx?.executionId || effectiveRoleId;
    toolRegistry.recordCall(name, success, duration, caller);
    // Async audit logging (don't block response)
    mcpPermissionService.logAudit({
      toolName: name,
      roleId: effectiveRoleId,
      input,
      output: success ? result : undefined,
      duration,
      success,
      error,
    }).catch(err => logger.warn('[MCP] Audit log failed', { error: String(err) }));
  }
}
