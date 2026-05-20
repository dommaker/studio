/**
 * 性能基准测试 - AT-002
 * 
 * 测试范围：
 * - API 响应时间
 * - 数据库查询性能
 * - 前端渲染性能
 * - WebSocket 延迟
 */

import { performance } from 'perf_hooks';

// 类型定义
export interface PerformanceResult {
  name: string;
  category: 'api' | 'db' | 'render' | 'websocket';
  durationMs: number;
  success: boolean;
  metrics?: Record<string, number>;
}

export interface PerformanceBaseline {
  recordedAt: string;
  commit: string;
  results: PerformanceResult[];
  summary: {
    avgDuration: number;
    p50: number;
    p90: number;
    p99: number;
    passRate: number;
  };
}

// 测试配置
const THRESHOLDS = {
  api: { avg: 100, p99: 500 },      // API 平均 100ms, P99 500ms
  db: { avg: 50, p99: 200 },        // 数据库平均 50ms, P99 200ms
  render: { avg: 16, p99: 100 },    // 渲染平均 16ms (60fps), P99 100ms
  websocket: { avg: 10, p99: 50 },  // WebSocket 平均 10ms, P99 50ms
};

/**
 * API 响应时间测试
 */
export async function testApiResponseTime(
  endpoint: string,
  method: string = 'GET',
  body?: any
): Promise<PerformanceResult> {
  const start = performance.now();
  
  try {
    const response = await fetch(endpoint, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    
    const duration = performance.now() - start;
    const success = response.ok;
    
    return {
      name: `${method} ${endpoint}`,
      category: 'api',
      durationMs: duration,
      success,
      metrics: {
        status: response.status,
        size: parseInt(response.headers.get('content-length') || '0'),
      },
    };
  } catch (error) {
    const duration = performance.now() - start;
    return {
      name: `${method} ${endpoint}`,
      category: 'api',
      durationMs: duration,
      success: false,
    };
  }
}

/**
 * 数据库查询性能测试
 */
export async function testDbQueryPerformance(
  queryFn: () => Promise<any>,
  queryName: string
): Promise<PerformanceResult> {
  const start = performance.now();
  
  try {
    const result = await queryFn();
    const duration = performance.now() - start;
    
    return {
      name: queryName,
      category: 'db',
      durationMs: duration,
      success: true,
      metrics: {
        rowCount: Array.isArray(result) ? result.length : 1,
      },
    };
  } catch (error) {
    const duration = performance.now() - start;
    return {
      name: queryName,
      category: 'db',
      durationMs: duration,
      success: false,
    };
  }
}

/**
 * 运行多次测试并统计结果
 */
export async function runMultipleTests(
  testFn: () => Promise<PerformanceResult>,
  iterations: number = 10
): Promise<PerformanceResult[]> {
  const results: PerformanceResult[] = [];
  
  for (let i = 0; i < iterations; i++) {
    const result = await testFn();
    results.push(result);
  }
  
  return results;
}

/**
 * 计算性能统计
 */
export function calculateStats(results: PerformanceResult[]): {
  avg: number;
  p50: number;
  p90: number;
  p99: number;
  passRate: number;
} {
  const durations = results.map(r => r.durationMs).sort((a, b) => a - b);
  const successes = results.filter(r => r.success).length;
  
  return {
    avg: durations.reduce((a, b) => a + b, 0) / durations.length,
    p50: durations[Math.floor(durations.length * 0.5)] || durations[0],
    p90: durations[Math.floor(durations.length * 0.9)] || durations[durations.length - 1],
    p99: durations[Math.floor(durations.length * 0.99)] || durations[durations.length - 1],
    passRate: successes / results.length,
  };
}

/**
 * 检查性能是否达标
 */
export function checkPerformanceThreshold(
  category: 'api' | 'db' | 'render' | 'websocket',
  stats: { avg: number; p99: number }
): { passed: boolean; message: string } {
  const threshold = THRESHOLDS[category];
  
  const avgPassed = stats.avg <= threshold.avg;
  const p99Passed = stats.p99 <= threshold.p99;
  
  if (avgPassed && p99Passed) {
    return { passed: true, message: `✅ 性能达标: avg=${stats.avg}ms, p99=${stats.p99}ms` };
  } else {
    const issues = [];
    if (!avgPassed) issues.push(`avg(${stats.avg}ms) > threshold(${threshold.avg}ms)`);
    if (!p99Passed) issues.push(`p99(${stats.p99}ms) > threshold(${threshold.p99}ms)`);
    return { passed: false, message: `❌ 性能超标: ${issues.join(', ')}` };
  }
}

/**
 * 保存性能基准
 */
export function saveBaseline(baseline: PerformanceBaseline, filePath: string): void {
  // 由调用方实现文件保存
  console.log('[Performance] 基准已记录:', {
    recordedAt: baseline.recordedAt,
    commit: baseline.commit,
    avgDuration: baseline.summary.avgDuration,
    passRate: baseline.summary.passRate,
  });
}

// 默认测试配置
export const DEFAULT_TEST_CONFIG = {
  iterations: 10,
  endpoints: [
    { path: '/api/v1/roles', method: 'GET' },
    { path: '/api/v1/capabilities', method: 'GET' },
  ],
};