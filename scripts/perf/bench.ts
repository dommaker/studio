/**
 * perf bench CLI（#673）——一条命令复现 performance-baseline.md 同口径测量：
 * 冷启动 3 轮（run1 全新数据区含首启 seed，run2/3 同区重启）→ 读 8 端点 +
 * 写 2 端点（各 3 warmup + 50 串行）→ SSE 20 轮。`--seed N` 先经 API 预置
 * N 条 workunit 再测（FileStore 全量扫描端点的数据量画像）。
 *
 * 用法：pnpm perf:bench -- [--seed N] [--runs 50] [--sse-rounds 20]
 *        [--cold-runs 3] [--out report.json] [--quiet]
 * stdout 恒输出 markdown 报告；JSON 写 --out（缺省 tmp 文件并打印路径）。
 */

import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { summarize } from './lib/stats.js';
import { renderMarkdown, type BenchReport, type EndpointMetric } from './lib/report.js';
import { makeTempHome, removeTempHome, startServer, stopServer, waitReady, type ServerHandle } from './lib/server.js';

const READ_ENDPOINTS: Array<{ name: string; path: string }> = [
  { name: 'health', path: '/api/v1/health' },
  { name: 'agents 列表', path: '/api/v1/agents' },
  { name: 'channels 列表', path: '/api/v1/channels' },
  { name: 'workunits 列表', path: '/api/v1/workunits' },
  { name: 'pmo 项目列表', path: '/api/v1/pmo/project' },
  { name: 'skills 列表', path: '/api/v1/skills' },
  { name: 'monitoring 汇总', path: '/api/v1/monitoring/stats' },
  { name: 'notifications', path: '/api/v1/notifications' },
];

export interface BenchOptions {
  seed?: number;
  runs?: number;
  sseRounds?: number;
  coldRuns?: number;
  out?: string;
  quiet?: boolean;
}

export function parseBenchArgs(argv: string[]): BenchOptions {
  const opts: BenchOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case '--seed': opts.seed = Number(next()); break;
      case '--runs': opts.runs = Number(next()); break;
      case '--sse-rounds': opts.sseRounds = Number(next()); break;
      case '--cold-runs': opts.coldRuns = Number(next()); break;
      case '--out': opts.out = next(); break;
      case '--quiet': opts.quiet = true; break;
      default: throw new Error(`未知参数：${argv[i]}`);
    }
  }
  return opts;
}

function currentCommit(): string {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

interface TimedResult {
  samples: number[];
  statusCounts: Record<string, number>;
}

/** 3 warmup + runs 串行，记录每发耗时与状态码（baseline §2 同口径） */
async function measureEndpoint(
  baseUrl: string,
  method: string,
  path: string,
  runs: number,
  body?: (i: number) => unknown,
): Promise<TimedResult> {
  const fire = async (i: number) => {
    const start = performance.now();
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body(i)) : undefined,
    });
    await res.arrayBuffer(); // 读尽响应体，计时含传输
    return { ms: performance.now() - start, status: res.status };
  };
  for (let i = 0; i < 3; i++) await fire(-1);
  const samples: number[] = [];
  const statusCounts: Record<string, number> = {};
  for (let i = 0; i < runs; i++) {
    const { ms, status } = await fire(i);
    samples.push(ms);
    statusCounts[String(status)] = (statusCounts[String(status)] ?? 0) + 1;
  }
  return { samples, statusCounts };
}

export function toMetric(name: string, method: string, path: string, r: TimedResult): EndpointMetric {
  const s = summarize(r.samples);
  return { name, method, path, statusCounts: r.statusCounts, p50: s.p50, p95: s.p95, max: s.max };
}

async function seedWorkunits(baseUrl: string, n: number, log: (m: string) => void): Promise<void> {
  log(`预置 ${n} 条 workunit…`);
  for (let i = 0; i < n; i++) {
    const res = await fetch(`${baseUrl}/api/v1/workunits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: `perf-seed-${i}`, type: 'task' }),
    });
    if (res.status !== 201) throw new Error(`seed 第 ${i} 条失败：HTTP ${res.status}`);
  }
}

interface SseSample {
  endToEnd: number;
  postToSse: number;
}

/** SSE 延迟：POST /workunits → workunit.created → events 桥 → /events/stream（baseline §7.1 同口径） */
async function measureSse(baseUrl: string, rounds: number, log: (m: string) => void): Promise<SseSample[]> {
  log(`SSE ${rounds} 轮…`);
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/v1/events/stream?topics=workunits`, { signal: controller.signal });
  if (!res.body) throw new Error('SSE 无响应体');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // 事件可能先于 POST 应答返回后的登记到达（同一事件循环交错），两侧都要兜底
  const pending = new Map<string, () => void>();
  const early = new Set<string>();

  const pump = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
        if (!dataLine) continue;
        try {
          const event = JSON.parse(dataLine.slice(6));
          // workunit.created 负载 = { workunit }（workunit-crud.ts 发布形状）
          const workunitId = event.data?.workunit?.id ?? event.data?.id;
          if (event.event_type === 'workunit.created' && workunitId) {
            const resolve = pending.get(workunitId);
            if (resolve) {
              pending.delete(workunitId);
              resolve();
            } else {
              early.add(workunitId);
            }
          }
        } catch {
          // 心跳/连接帧，忽略
        }
      }
    }
  })();

  // 连接帧就位（读到 connection.established 前不发起 POST）——简单等一拍
  await new Promise((r) => setTimeout(r, 300));

  const samples: SseSample[] = [];
  for (let i = 0; i < rounds; i++) {
    const postStart = performance.now();
    const postRes = await fetch(`${baseUrl}/api/v1/workunits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: `perf-sse-${Date.now()}-${i}`, type: 'task' }),
    });
    const postEnd = performance.now();
    const created = (await postRes.json()) as { data: { id: string } };
    const id = created.data.id;
    if (early.has(id)) {
      early.delete(id);
    } else {
      const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`SSE 第 ${i} 轮等 workunit.created(${id}) 超时（15s）`)), 15_000));
      await Promise.race([new Promise<void>((resolve) => pending.set(id, resolve)), timeout]);
    }
    const sseAt = performance.now();
    samples.push({ endToEnd: sseAt - postStart, postToSse: sseAt - postEnd });
  }

  controller.abort();
  await pump.catch(() => {});
  return samples;
}

export async function runBench(opts: BenchOptions = {}): Promise<{ report: BenchReport; markdown: string; jsonPath: string }> {
  const seed = opts.seed ?? 0;
  const runs = opts.runs ?? 50;
  const sseRounds = opts.sseRounds ?? 20;
  const coldRuns = opts.coldRuns ?? 3;
  const log = (m: string) => {
    if (!opts.quiet) console.error(`[perf] ${m}`);
  };

  const home = makeTempHome();
  let server: ServerHandle | null = null;
  try {
    log(`隔离数据区 ${home}`);
    const coldStartRuns: number[] = [];
    for (let i = 0; i < coldRuns; i++) {
      log(`冷启动 run${i + 1}…`);
      server = await startServer({ studioHome: home });
      coldStartRuns.push(Math.round(server.coldStartMs));
      await stopServer(server);
      server = null;
    }

    log('测量用启动…');
    server = await startServer({ studioHome: home });
    await waitReady(server);
    const baseUrl = server.baseUrl;

    if (seed > 0) await seedWorkunits(baseUrl, seed, log);

    const endpoints: EndpointMetric[] = [];
    for (const e of READ_ENDPOINTS) {
      log(`${e.name} ${runs} 发…`);
      endpoints.push(toMetric(e.name, 'GET', e.path, await measureEndpoint(baseUrl, 'GET', e.path, runs)));
    }

    log(`写 create ${runs} 发…`);
    endpoints.push(
      toMetric('workunits create', 'POST', '/api/v1/workunits', await measureEndpoint(baseUrl, 'POST', '/api/v1/workunits', runs, (i) => ({ scope: `perf-write-${i}`, type: 'task' }))),
    );
    log(`写 update ${runs} 发…`);
    const probe = await fetch(`${baseUrl}/api/v1/workunits`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'perf-update-target', type: 'task' }),
    });
    const updateId = ((await probe.json()) as { data: { id: string } }).data.id;
    endpoints.push(
      toMetric('workunits update', 'PUT', '/api/v1/workunits/:id', await measureEndpoint(baseUrl, 'PUT', `/api/v1/workunits/${updateId}`, runs, (i) => ({ scope: `perf-write-updated-${i}` }))),
    );

    const sseSamples = await measureSse(baseUrl, sseRounds, log);
    const e2e = summarize(sseSamples.map((s) => s.endToEnd));
    const p2s = summarize(sseSamples.map((s) => s.postToSse));

    const report: BenchReport = {
      version: 1,
      meta: {
        commit: currentCommit(),
        node: process.version,
        date: new Date().toISOString().slice(0, 10),
        seed,
        runs,
      },
      coldStart: { runs: coldStartRuns },
      endpoints,
      sse: { rounds: sseRounds, postToSse: { p50: p2s.p50, p95: p2s.p95 }, endToEnd: { p50: e2e.p50, p95: e2e.p95 } },
    };
    const markdown = renderMarkdown(report);
    const jsonPath = opts.out ?? join(tmpdir(), `studio-perf-report-${Date.now()}.json`);
    writeFileSync(jsonPath, JSON.stringify(report, null, 2));
    return { report, markdown, jsonPath };
  } finally {
    if (server) await stopServer(server);
    removeTempHome(home);
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const opts = parseBenchArgs(process.argv.slice(2));
  runBench(opts)
    .then(({ markdown, jsonPath }) => {
      console.log(markdown);
      console.error(`[perf] JSON 报告：${jsonPath}`);
    })
    .catch((err) => {
      console.error(`[perf] bench 失败：${err instanceof Error ? err.message : err}`);
      process.exit(1);
    });
}
