/**
 * 压力测试 - AT-003
 * 
 * 测试范围：
 * - 高并发 API 请求
 * - 数据库连接池极限
 * - 内存泄漏检测
 * - 响应时间退化
 */

import { performance } from 'perf_hooks';

// 类型定义
export interface StressTestResult {
  name: string;
  concurrency: number;
  totalRequests: number;
  successfulRequests: number;
  failedRequests: number;
  durationMs: number;
  requestsPerSecond: number;
  avgLatencyMs: number;
  p50LatencyMs: number;
  p99LatencyMs: number;
  errors: string[];
}

export interface StressTestConfig {
  endpoint: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: any;
  concurrency: number;
  totalRequests: number;
  rampUpMs?: number;
}

/**
 * 并发请求测试
 */
export async function stressTestHttp(config: StressTestConfig): Promise<StressTestResult> {
  const { endpoint, method, body, concurrency, totalRequests, rampUpMs = 0 } = config;
  
  const latencies: number[] = [];
  const errors: string[] = [];
  let successfulRequests = 0;
  let failedRequests = 0;
  
  const startTime = performance.now();
  
  // 分批执行请求
  const batches = Math.ceil(totalRequests / concurrency);
  const requestsPerBatch = Math.ceil(totalRequests / batches);
  
  for (let batch = 0; batch < batches; batch++) {
    // Ramp-up 延迟
    if (rampUpMs > 0 && batch > 0) {
      await sleep(rampUpMs / batches);
    }
    
    // 并发请求
    const batchPromises = Array.from({ length: requestsPerBatch }, async () => {
      const requestStart = performance.now();
      
      try {
        const response = await fetch(endpoint, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
        
        const latency = performance.now() - requestStart;
        latencies.push(latency);
        
        if (response.ok) {
          successfulRequests++;
        } else {
          failedRequests++;
          errors.push(`HTTP ${response.status}`);
        }
      } catch (error) {
        const latency = performance.now() - requestStart;
        latencies.push(latency);
        failedRequests++;
        errors.push(error instanceof Error ? error.message : 'Unknown error');
      }
    });
    
    await Promise.all(batchPromises);
  }
  
  const durationMs = performance.now() - startTime;
  
  // 计算统计
  latencies.sort((a, b) => a - b);
  const avgLatencyMs = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p50Index = Math.floor(latencies.length * 0.5);
  const p99Index = Math.floor(latencies.length * 0.99);
  
  return {
    name: `${method} ${endpoint}`,
    concurrency,
    totalRequests,
    successfulRequests,
    failedRequests,
    durationMs,
    requestsPerSecond: (totalRequests / durationMs) * 1000,
    avgLatencyMs,
    p50LatencyMs: latencies[p50Index] || 0,
    p99LatencyMs: latencies[p99Index] || 0,
    errors: [...new Set(errors)].slice(0, 10),
  };
}

/**
 * 渐进式压力测试
 */
export async function progressiveStressTest(
  endpoint: string,
  options: {
    startConcurrency?: number;
    maxConcurrency?: number;
    step?: number;
    requestsPerStep?: number;
  } = {}
): Promise<StressTestResult[]> {
  const {
    startConcurrency = 10,
    maxConcurrency = 100,
    step = 10,
    requestsPerStep = 100,
  } = options;
  
  const results: StressTestResult[] = [];
  
  for (let concurrency = startConcurrency; concurrency <= maxConcurrency; concurrency += step) {
    console.log(`[Stress Test] Testing concurrency: ${concurrency}`);
    
    const result = await stressTestHttp({
      endpoint,
      method: 'GET',
      concurrency,
      totalRequests: requestsPerStep,
    });
    
    results.push(result);
    
    // 如果失败率超过 50%，停止测试
    const failureRate = result.failedRequests / result.totalRequests;
    if (failureRate > 0.5) {
      console.log(`[Stress Test] Stopping: failure rate ${(failureRate * 100).toFixed(1)}% > 50%`);
      break;
    }
    
    // 如果 P99 延迟超过 10s，停止测试
    if (result.p99LatencyMs > 10000) {
      console.log(`[Stress Test] Stopping: P99 latency ${result.p99LatencyMs}ms > 10s`);
      break;
    }
  }
  
  return results;
}

/**
 * 内存泄漏检测
 */
export async function detectMemoryLeak(
  testFn: () => Promise<void>,
  iterations: number = 100
): Promise<{
  hasLeak: boolean;
  initialMemory: number;
  finalMemory: number;
  growth: number;
  growthPercent: number;
}> {
  // 强制 GC（如果可用）
  if (global.gc) {
    global.gc();
  }
  
  const initialMemory = process.memoryUsage().heapUsed;
  
  for (let i = 0; i < iterations; i++) {
    await testFn();
  }
  
  // 再次强制 GC
  if (global.gc) {
    global.gc();
  }
  
  const finalMemory = process.memoryUsage().heapUsed;
  const growth = finalMemory - initialMemory;
  const growthPercent = (growth / initialMemory) * 100;
  
  // 如果内存增长超过 50%，可能存在泄漏
  const hasLeak = growthPercent > 50;
  
  return {
    hasLeak,
    initialMemory,
    finalMemory,
    growth,
    growthPercent,
  };
}

/**
 * 打印测试报告
 */
export function printStressTestReport(result: StressTestResult): void {
  console.log('\n=== 压力测试报告 ===');
  console.log(`名称: ${result.name}`);
  console.log(`并发数: ${result.concurrency}`);
  console.log(`总请求: ${result.totalRequests}`);
  console.log(`成功: ${result.successfulRequests} (${((result.successfulRequests / result.totalRequests) * 100).toFixed(1)}%)`);
  console.log(`失败: ${result.failedRequests}`);
  console.log(`持续时间: ${(result.durationMs / 1000).toFixed(2)}s`);
  console.log(`QPS: ${result.requestsPerSecond.toFixed(1)}`);
  console.log(`延迟: avg=${result.avgLatencyMs.toFixed(1)}ms, P50=${result.p50LatencyMs.toFixed(1)}ms, P99=${result.p99LatencyMs.toFixed(1)}ms`);
  if (result.errors.length > 0) {
    console.log(`错误: ${result.errors.join(', ')}`);
  }
  console.log('===================\n');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}