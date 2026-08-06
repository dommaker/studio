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

// ===== Studio 专用指标 =====

// API 请求计数
const apiRequests = new client.Counter({
  name: 'studio_api_requests_total',
  help: 'Total API requests',
  labelNames: ['method', 'path', 'status'],
});

// 任务处理计数
const taskProcessed = new client.Counter({
  name: 'studio_tasks_processed_total',
  help: 'Total tasks processed',
  labelNames: ['status'], // success | failed
});

// LLM Proxy 请求计数
const llmProxyRequests = new client.Counter({
  name: 'studio_llm_proxy_requests_total',
  help: 'Total LLM proxy requests',
  labelNames: ['provider', 'model', 'status'],
});

// ===== 指标更新函数 =====

/**
 * 记录 API 请求
 */
export function recordApiRequest(method: string, path: string, status: number): void {
  apiRequests.inc({ method, path, status: status.toString() });
}

/**
 * 记录任务处理
 */
export function recordTaskProcessed(status: 'success' | 'failed'): void {
  taskProcessed.inc({ status });
}

/**
 * 记录 LLM Proxy 请求
 */
export function recordLlmProxyRequest(provider: string, model: string, status: 'success' | 'failed'): void {
  llmProxyRequests.inc({ provider, model, status });
}

// ===== 导出 =====

export { register };

/**
 * 获取所有指标
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

/**
 * 获取注册表
 */
export function getRegister(): client.Registry {
  return register;
}