/**
 * agent-studio Prometheus 指标
 * 
 * 提供 studio 自身的系统指标
 * 工作流/步骤指标由 agent-runtime 提供
 */

import client from 'prom-client';

// ===== 注册表 =====

const register = client.register;
register.setDefaultLabels({ app: 'agent-studio' });

// ===== 自动采集 Node.js 默认指标 =====

client.collectDefaultMetrics({ register });

// ===== 导出 =====

/**
 * 获取所有指标
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}