// API 工具函数 - 自动处理 API 基础 URL

/**
 * 获取 API 基础 URL
 * 优先级：window.API_BASE > 环境变量 > 默认值
 */
export function getApiBase(): string {
  if ((window as any).API_BASE) {
    return (window as any).API_BASE;
  }
  return import.meta.env.VITE_API_URL || '/api/v1';
}

/**
 * 发送 API 请求（自动添加基础 URL）
 */
export async function apiFetch(path: string, options?: RequestInit): Promise<Response> {
  const base = getApiBase();
  const url = path.startsWith('http') ? path : `${base}${path}`;
  return fetch(url, options);
}

/**
 * GET 请求
 */
export async function apiGet<T = any>(path: string): Promise<T> {
  const response = await apiFetch(path);
  if (!response.ok) throw new Error(`请求失败: ${response.status}`);
  return response.json();
}

/**
 * POST 请求
 */
export async function apiPost<T = any>(path: string, data?: any): Promise<T> {
  const response = await apiFetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  if (!response.ok) throw new Error(`请求失败: ${response.status}`);
  return response.json();
}
