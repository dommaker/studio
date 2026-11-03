/**
 * PERF-07 规模/并发门禁：隔离 STUDIO_HOME 合成五域数据，真实本地 HTTP/SSE +
 * FileStore 写路径 + 真实 AgentLoop（仅外部 Executor 替换为确定性假实现）。
 * 不读真实数据/凭证，不调用远端服务；所有子进程命令均指向临时 no-op 工具。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { summarize } from './lib/stats.js';
import { measureScenarioAlternating, ResourceSampler, summarizeDiagnostics, type MeasurementDiagnostics } from './lib/measure.js';
import { startServer, stopServer, waitReady, removeTempHome, readServerTelemetry, type ServerTelemetry } from './lib/server.js';
import { scenarioBudgets } from './lib/thresholds.js';

export interface ScaleMatrix {
  workUnits: number;
  events: number;
  messages: number;
  notifications: number;
  knowledge: number;
  roles: number;
  httpConcurrency: number;
  sseClients: number;
}

export const DEFAULT_SCALE: ScaleMatrix = {
  workUnits: 200,
  events: 1000,
  messages: 2000,
  notifications: 200,
  knowledge: 100,
  roles: 20,
  httpConcurrency: 10,
  sseClients: 4,
};

export interface ScaleOptions {
  scale: ScaleMatrix;
  repeats: number;
  runs: number;
  out?: string;
  quiet?: boolean;
}

export interface CorrectnessResult { name: string; ok: boolean; detail?: string }
export interface BudgetMetric {
  name: string;
  /** 实际样本与最低样本数；0/缺测永远 fail-closed。 */
  n: number;
  minSamples: number;
  p50: number;
  p95: number;
  max: number;
  budgetP50Ms: number;
  budgetP95Ms: number;
  /** 新场景未形成基线前只诊断；correctness 始终硬门。 */
  hard?: boolean;
}
export interface ScaleReport {
  version: 1;
  scale: ScaleMatrix;
  correctness: CorrectnessResult[];
  latency: BudgetMetric[];
  soak: BudgetMetric[];
  diagnostics: Record<string, MeasurementDiagnostics>;
  observations: string[];
}

const SCALE_KEYS = ['workUnits', 'events', 'messages', 'notifications', 'knowledge', 'roles', 'httpConcurrency', 'sseClients'] as const;
const REQUIRED_CORRECTNESS = [
  'updateMetadata side effects', 'claim single winner', 'lease flush persisted', 'token ledger totals',
  'AgentLoop step persisted', 'knowledge injected marker', 'role observation shared', 'scale matrix visible',
  'SSE all clients received', 'action-center state items',
] as const;
const REQUIRED_LATENCY = [
  'updateMetadata', 'claim concurrent roles', 'lease flush', 'token ledger write', 'role thundering herd',
  'knowledge injection', 'action-center concurrent', 'overview concurrent', 'real AgentLoop step',
] as const;
const REQUIRED_SOAK = ['SSE sustained'] as const;

export function evaluateScaleReport(report: ScaleReport): { correctness: string[]; latency: string[]; soak: string[] } {
  for (const key of SCALE_KEYS) {
    if (!Number.isInteger(report.scale[key]) || report.scale[key] <= 0) throw new Error(`规模矩阵必须非空且为整数：${key}`);
  }
  const correctness: string[] = [];
  for (const item of [...report.latency, ...report.soak]) {
    if (!Number.isInteger(item.n) || item.n < item.minSamples || item.n <= 0) correctness.push(`samples:${item.name}`);
  }
  for (const name of REQUIRED_LATENCY) if (!report.latency.some(item => item.name === name)) correctness.push(`missing:${name}`);
  for (const name of REQUIRED_SOAK) if (!report.soak.some(item => item.name === name)) correctness.push(`missing:${name}`);
  const byName = new Map(report.correctness.map(item => [item.name, item]));
  for (const item of report.correctness.filter(item => !item.ok)) correctness.push(item.name);
  for (const name of REQUIRED_CORRECTNESS) {
    if (!byName.get(name)?.ok && !correctness.includes(name)) correctness.push(`missing:${name}`);
  }
  const overBudget = (items: BudgetMetric[]) => items
    .filter(item => item.hard !== false && item.n >= item.minSamples && item.n > 0 && (item.p50 > item.budgetP50Ms || item.p95 > item.budgetP95Ms))
    .map(item => item.name);
  return { correctness, latency: overBudget(report.latency), soak: overBudget(report.soak) };
}

function positive(raw: string | undefined, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${flag} 须为正整数`);
  return value;
}

export function parseScaleArgs(argv: string[]): ScaleOptions {
  const opts: ScaleOptions = { scale: { ...DEFAULT_SCALE }, repeats: 3, runs: 10 };
  const scaleFlags: Record<string, keyof ScaleMatrix> = {
    '--wu': 'workUnits', '--events': 'events', '--messages': 'messages', '--notifications': 'notifications',
    '--knowledge': 'knowledge', '--roles': 'roles', '--http-concurrency': 'httpConcurrency', '--sse-clients': 'sseClients',
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag in scaleFlags) opts.scale[scaleFlags[flag]] = positive(argv[++i], flag);
    else if (flag === '--repeats') opts.repeats = positive(argv[++i], flag);
    else if (flag === '--runs') opts.runs = positive(argv[++i], flag);
    else if (flag === '--out') opts.out = argv[++i];
    else if (flag === '--quiet') opts.quiet = true;
    else throw new Error(`未知参数：${flag}`);
  }
  if (opts.repeats < 2) throw new Error('--repeats 须 ≥2（baseline/current 交替）');
  return opts;
}

function metric(name: string, samples: number[], kind: 'read' | 'write' | 'sse' = 'read', minSamples = samples.length): BudgetMetric {
  const s = summarize(samples);
  return {
    name, n: s.n, minSamples, p50: s.p50, p95: s.p95, max: s.max,
    budgetP50Ms: kind === 'write' ? scenarioBudgets.writeP50Ms : kind === 'sse' ? scenarioBudgets.sseP50Ms : scenarioBudgets.readP50Ms,
    budgetP95Ms: kind === 'write' ? scenarioBudgets.writeP95Ms : kind === 'sse' ? scenarioBudgets.sseP95Ms : scenarioBudgets.readP95Ms,
  };
}

function deltaTelemetry(before: ServerTelemetry, after: ServerTelemetry): MeasurementDiagnostics {
  return {
    lockWaitMs: { p50: 0, p95: 0, max: 0 },
    eventLoopDelayMs: {
      p50: after.eventLoopDelayMs.p50,
      p95: after.eventLoopDelayMs.p95,
      max: after.eventLoopDelayMs.max,
    },
    rssBytes: { start: before.rssBytes.end, peak: after.rssBytes.peak, end: after.rssBytes.end },
    readBytes: Math.max(0, after.readBytes - before.readBytes),
    parsedLines: Math.max(0, after.parsedLines - before.parsedLines),
    cacheMisses: Math.max(0, after.cacheMisses - before.cacheMisses),
  };
}

async function timed(samples: number[], fn: () => Promise<unknown>): Promise<void> {
  const start = performance.now();
  await fn();
  samples.push(performance.now() - start);
}

async function httpJson(baseUrl: string, route: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${baseUrl}${route}`, init);
  const body = await res.json();
  if (!res.ok) throw new Error(`${init?.method ?? 'GET'} ${route} → ${res.status}: ${JSON.stringify(body)}`);
  return body;
}

export async function runWorkerPool<T>(
  concurrency: number,
  runs: number,
  task: (worker: number, iteration: number) => Promise<T>,
): Promise<T[]> {
  if (!Number.isInteger(concurrency) || concurrency <= 0 || !Number.isInteger(runs) || runs <= 0) {
    throw new Error('worker pool concurrency/runs 须为正整数');
  }
  return (await Promise.all(Array.from({ length: concurrency }, async (_, worker) => {
    const results: T[] = [];
    for (let iteration = 0; iteration < runs; iteration++) results.push(await task(worker, iteration));
    return results;
  }))).flat();
}

async function concurrentHttp(baseUrl: string, route: string, concurrency: number, runs: number): Promise<number[]> {
  return runWorkerPool(concurrency, runs, async () => {
    const start = performance.now();
    await httpJson(baseUrl, route);
    return performance.now() - start;
  });
}

function initEnvironment(home: string): void {
  const noop = path.join(home, 'noop-bin');
  fs.mkdirSync(noop, { recursive: true });
  for (const command of ['pkill', 'systemd-run']) fs.writeFileSync(path.join(noop, command), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(noop, 'claude'), '#!/bin/sh\necho perf-noop\n', { mode: 0o755 });
  process.env.STUDIO_HOME = home;
  process.env.STUDIO_DATA_DIR = path.join(home, 'data');
  process.env.STUDIO_EVENTS_FILE = path.join(home, 'logs', 'studio-events.jsonl');
  process.env.STUDIO_AGENT_LOOP_ENABLED = 'false';
  process.env.STUDIO_REQUIREMENT_GUARD = 'false';
  process.env.STUDIO_CLAIM_FITNESS = 'false';
  process.env.STUDIO_KNOWLEDGE_EXTRACTION = 'false';
  process.env.STUDIO_AUTO_REVIEW = 'false';
  process.env.PATH = `${noop}${path.delimiter}${process.env.PATH ?? ''}`;
  delete process.env.VITEST;
  delete process.env.NODE_ENV;
}

async function runScale(opts: ScaleOptions): Promise<ScaleReport> {
  const expectedDirectSamples = opts.repeats * opts.runs;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-perf-scale-'));
  const log = (message: string) => { if (!opts.quiet) console.error(`[perf-scale] ${message}`); };
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  let completed = false;
  const report: ScaleReport = {
    version: 1, scale: { ...opts.scale }, correctness: [], latency: [], soak: [], diagnostics: {}, observations: [],
  };
  try {
    initEnvironment(home);
    const dataDir = path.join(home, 'data');
    const logsDir = path.join(home, 'logs');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });
    const { FileStore, eventBus } = await import('../../packages/studio-shared/src/index.js');
    const { knowledgeService } = await import('../../apps/api/src/modules/knowledge/knowledge-service.js');
    const { sharedStore } = await import('../../apps/api/src/modules/knowledge/knowledge-singletons.js');
    const { LoopObserver } = await import('../../apps/api/src/modules/agent-loop/loop/loop-observe.js');
    const { AgentLoop } = await import('../../apps/api/src/modules/agent-loop/agent-loop.js');
    const { writeWorkunitTokenEvent } = await import('../../apps/api/src/modules/agent-loop/agent-loop-events.js');
    const { syncTokenLedger } = await import('../../apps/api/src/modules/workunit/token-ledger.js');
    const { setReadMetricsSink } = await import('../../packages/studio-shared/src/read-metrics.js');

    const store = new FileStore(dataDir, { leaseFlushIntervalMs: 0 });
    const channelId = 'perf-channel';
    const now = Date.now();
    const role = (id: string) => ({
      id, name: id, description: 'perf role', channels: '[]', status: 'active', provider: 'claude',
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    });
    await store.createChannel({
      id: channelId, name: '#perf', type: 'rnd', defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: JSON.stringify([...Array.from({ length: opts.scale.roles }, (_, i) => `role-${i}`), 'role-loop']),
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    });

    log(`合成 ${JSON.stringify(opts.scale)}`);
    const wuDir = path.join(dataDir, 'workunits');
    fs.mkdirSync(wuDir, { recursive: true });
    const snapshots: any[] = [];
    const wuEvents: any[] = [];
    for (let i = 0; i < opts.scale.workUnits; i++) {
      const status = i === 1 ? 'blocked' : i === 2 ? 'in_review' : i === 3 ? 'pending' : i % 5 === 0 ? 'done' : 'unassigned';
      const snap = {
        id: `wu-${i}`, parentId: null, type: i === 2 ? 'analysis' : 'task', scope: `perf scale ${i}`, assigneeId: null,
        status, failureType: null, retryCount: 0, timeoutAt: null,
        channelId, projectPath: null, workspaceId: null,
        metadata: i === 1 ? JSON.stringify({ count: 0, waitingForInput: true, waitingQuestion: 'perf waiting question', waitingSince: new Date(now).toISOString() }) : '{"count":0}',
        createdAt: new Date(now - (opts.scale.workUnits - i) * 1000).toISOString(),
        updatedAt: new Date(now - (opts.scale.workUnits - i) * 1000).toISOString(), claimedAt: null,
        completedAt: status === 'done' ? new Date(now).toISOString() : null,
      };
      snapshots.push(snap);
      wuEvents.push({ type: 'created', wuId: snap.id, timestamp: snap.createdAt, data: snap });
    }
    fs.writeFileSync(path.join(wuDir, 'index.json'), `${snapshots.map(row => JSON.stringify(row)).join('\n')}\n`);
    fs.writeFileSync(path.join(wuDir, 'events.jsonl'), `${wuEvents.map(row => JSON.stringify(row)).join('\n')}\n`);

    const channelDir = path.join(dataDir, 'channels', channelId);
    fs.mkdirSync(channelDir, { recursive: true });
    const messages = Array.from({ length: opts.scale.messages }, (_, i) => ({
      id: `m-${i}`, channelId, workUnitId: i === 10 ? 'wu-1' : i % 10 === 0 ? `wu-${i % opts.scale.workUnits}` : null,
      authorType: i === 10 || i % 2 ? 'agent' : 'human', agentName: i === 10 || i % 2 ? 'perf' : null,
      content: i === 10 ? 'perf waiting question' : `perf message ${i} ${'x'.repeat(200)}`, replyToId: null, meta: '{}',
      createdAt: new Date(now - (opts.scale.messages - i) * 1000).toISOString(),
    }));
    fs.writeFileSync(path.join(channelDir, 'messages.jsonl'), `${messages.map(row => JSON.stringify(row)).join('\n')}\n`);
    const notifications = Array.from({ length: opts.scale.notifications }, (_, i) => ({
      id: `n-${i}`, userId: 'local', type: 'system', title: `perf ${i}`, content: 'perf', createdAt: new Date(now - i * 1000).toISOString(),
    }));
    const eventsFile = path.join(logsDir, 'studio-events.jsonl');
    const tokenEvents = Array.from({ length: opts.scale.events }, (_, i) => ({
      type: 'workunit:tokens', source: 'perf-seed', payload: JSON.stringify({ workUnitId: `wu-${i % opts.scale.workUnits}`, injectedTokens: 1, executionTokens: 1 }),
      createdAt: new Date(now - (opts.scale.events - i) * 1000).toISOString(),
    }));
    fs.writeFileSync(eventsFile, `${tokenEvents.map(row => JSON.stringify(row)).join('\n')}\n`);
    fs.writeFileSync(path.join(logsDir, 'notifications.jsonl'), `${notifications.map(row => JSON.stringify(row)).join('\n')}\n`);
    for (let i = 0; i < opts.scale.knowledge; i++) {
      sharedStore.save({
        id: `perf-knowledge-${i}`, type: 'guideline', title: `perf unique guideline ${i}`,
        content: i === 0 ? 'PERF07-KNOWLEDGE-MARKER 真实注入结果' : `perf knowledge ${i}`,
        maturity: 'active', layer: 'project', created: new Date(now).toISOString(), lastReferenced: '',
        contributors: [], projects: [], tags: ['perf', 'signal'], applicablePhases: [],
        sourceReferences: [{ source: 'perf:seed', timestamp: new Date(now).toISOString() }], referencedBy: [],
        executionResults: [], consumptionMode: 'signal', origin: 'system',
      } as any);
    }

    // 先建立 token checkpoint，后续 100 次写入只应读新增字节。
    const initialLedger = await syncTokenLedger(eventsFile);
    const initialTotal = Object.values(initialLedger.byWorkUnit).reduce((sum, row) => sum + (row.executionTokens ?? 0), 0);
    const reads = { bytes: 0, parsedLines: 0, cacheMisses: 0 };
    const totalReads = { bytes: 0, parsedLines: 0, cacheMisses: 0 };
    const originalRead = fs.promises.readFile.bind(fs.promises);
    const originalOpen = fs.promises.open.bind(fs.promises);
    const originalParse = JSON.parse;
    const readSpy = async (file: fs.PathLike | fs.promises.FileHandle, ...args: any[]) => {
      const result = await (originalRead as any)(file, ...args);
      const bytes = Buffer.isBuffer(result) ? result.byteLength : Buffer.byteLength(String(result));
      totalReads.bytes += bytes;
      totalReads.cacheMisses++;
      if (String(file) === eventsFile) {
        reads.bytes += bytes;
        reads.cacheMisses++;
      }
      return result;
    };
    fs.promises.readFile = readSpy as typeof fs.promises.readFile;
    fs.promises.open = (async (file: fs.PathLike, ...args: any[]) => {
      const handle = await (originalOpen as any)(file, ...args);
      const read = handle.read.bind(handle);
      Object.defineProperty(handle, 'read', { value: async (...readArgs: any[]) => {
        const result = await read(...readArgs);
        totalReads.bytes += result.bytesRead;
        if (result.bytesRead > 0) totalReads.cacheMisses++;
        if (String(file) === eventsFile) {
          reads.bytes += result.bytesRead;
          if (result.bytesRead > 0) reads.cacheMisses++;
        }
        return result;
      } });
      return handle;
    }) as typeof fs.promises.open;
    JSON.parse = ((text: string, ...args: any[]) => {
      totalReads.parsedLines++;
      if (text.startsWith('{"type":"workunit:tokens"')) reads.parsedLines++;
      return (originalParse as any)(text, ...args);
    }) as typeof JSON.parse;

    const sampler = new ResourceSampler();
    const lockWaits: number[] = [];
    const withLock = store.withLock.bind(store);
    store.withLock = (async (lockDir: string, fn: () => Promise<unknown>, timeoutMs?: number) => {
      const started = performance.now();
      return withLock(lockDir, async () => { lockWaits.push(performance.now() - started); return fn(); }, timeoutMs);
    }) as typeof store.withLock;

    const writeSamples: number[] = [];
    const writeIds = snapshots.filter(row => row.status === 'unassigned').slice(0, expectedDirectSamples);
    if (writeIds.length < expectedDirectSamples) throw new Error(`可写 WU 不足：${writeIds.length}/${expectedDirectSamples}`);
    for (const id of writeIds.map(row => row.id)) {
      await timed(writeSamples, () => store.updateMetadata(id, current => ({ ...current, count: (current.count as number) + 1 })));
    }
    const updated = await store.getIndex({ id: writeIds[0].id });
    report.correctness.push({ name: 'updateMetadata side effects', ok: JSON.parse(updated[0].metadata!).count === 1 });

    const claimSamples: number[] = [];
    for (const target of writeIds) {
      const start = performance.now();
      const results = await Promise.all(Array.from({ length: opts.scale.roles }, (_, i) => store.claimWorkUnit(target.id, `inst-${i}`)));
      claimSamples.push(performance.now() - start);
      const winners = results.filter(Boolean);
      const claimed = (await store.getIndex({ id: target.id }))[0];
      report.correctness.push({ name: 'claim single winner', ok: winners.length === 1 && claimed.status === 'active' && claimed.assigneeId === `inst-${results.findIndex(Boolean)}` });
    }
    // 汇总同名 correctness：任一失败即失败，避免重复项被 Map 掩盖。
    const claimOk = report.correctness.filter(row => row.name === 'claim single winner').every(row => row.ok);
    report.correctness = report.correctness.filter(row => row.name !== 'claim single winner');
    report.correctness.push({ name: 'claim single winner', ok: claimOk });

    const leaseTarget = (await store.getIndex({ id: writeIds[0].id }))[0];
    const leaseSamples: number[] = [];
    const finalLease = new Date(Date.now() + 600_000);
    const leaseRefreshes: string[] = [];
    for (let i = 0; i < expectedDirectSamples; i++) {
      leaseRefreshes.push(await store.refreshWorkUnitLease(leaseTarget.id, leaseTarget.assigneeId, leaseTarget.claimedAt, finalLease));
      await timed(leaseSamples, () => store.flushWorkUnitLeases());
    }
    const leaseAfter = (await store.getIndex({ id: leaseTarget.id }))[0];
    report.correctness.push({ name: 'lease flush persisted', ok: leaseRefreshes.every(result => result === 'ok') && leaseAfter.timeoutAt === finalLease.toISOString(),
      detail: `refresh=${leaseRefreshes.join(',')} actual=${leaseAfter.timeoutAt} expected=${finalLease.toISOString()}` });

    let appendedBytes = 0;
    const tokenSamples: number[] = [];
    for (let i = 0; i < expectedDirectSamples; i++) {
      const before = fs.statSync(eventsFile).size;
      await timed(tokenSamples, () => writeWorkunitTokenEvent(eventsFile, {
        workUnitId: 'wu-1', executionId: `perf-token-${i}`, injectedTokens: 2, executionTokens: i + 1,
      }));
      appendedBytes += fs.statSync(eventsFile).size - before;
    }
    const finalLedger = await syncTokenLedger(eventsFile);
    const finalTotal = Object.values(finalLedger.byWorkUnit).reduce((sum, row) => sum + (row.executionTokens ?? 0), 0);
    // 精确逐写 read<=append 硬断言留在 PERF-01 complexity 测试；本场景只硬判账本副作用，读量作诊断。
    const expectedTokenDelta = expectedDirectSamples * (expectedDirectSamples + 1) / 2;
    report.correctness.push({ name: 'token ledger totals', ok: finalTotal === initialTotal + expectedTokenDelta,
      detail: `initial=${initialTotal} final=${finalTotal} expectedDelta=${expectedTokenDelta}` });
    report.observations.push(`token ledger: appended=${appendedBytes}B read=${reads.bytes}B parsed=${reads.parsedLines}`);
    const directResource = sampler.finish();
    report.diagnostics['WU writes + token ledger'] = summarizeDiagnostics({
      lockWaitMs: lockWaits, eventLoopDelayMs: directResource.eventLoopDelayMs, rssBytes: directResource.rssBytes,
      readBytes: reads.bytes, parsedLines: reads.parsedLines, cacheMisses: reads.cacheMisses,
    });
    report.latency.push(metric('updateMetadata', writeSamples, 'write', expectedDirectSamples));
    report.latency.push(metric('claim concurrent roles', claimSamples, 'write', expectedDirectSamples));
    report.latency.push(metric('lease flush', leaseSamples, 'write', expectedDirectSamples));
    report.latency.push(metric('token ledger write', tokenSamples, 'write', expectedDirectSamples));

    // 角色惊群：同一版本观察只读一次；真实共享协调器，不重写业务实现。
    let indexReads = 0;
    const getIndex = store.getIndex.bind(store);
    store.getIndex = (async (...args: any[]) => { indexReads++; return (getIndex as any)(...args); }) as typeof store.getIndex;
    const observers = Array.from({ length: opts.scale.roles }, (_, i) => new LoopObserver({
      role: role(`role-${i}`), fileStore: store, getInstance: () => null, isAlive: () => true,
    }));
    const roleSamples: number[] = [];
    const roleReadStart = { ...totalReads };
    const roleSampler = new ResourceSampler();
    for (let round = 0; round < expectedDirectSamples; round++) {
      await timed(roleSamples, () => Promise.all(observers.map(observer => observer.observe())));
    }
    const roleResource = roleSampler.finish();
    report.correctness.push({ name: 'role observation shared', ok: indexReads <= 2 });
    report.diagnostics['role thundering herd'] = summarizeDiagnostics({
      lockWaitMs: lockWaits, eventLoopDelayMs: roleResource.eventLoopDelayMs, rssBytes: roleResource.rssBytes,
      readBytes: totalReads.bytes - roleReadStart.bytes,
      parsedLines: totalReads.parsedLines - roleReadStart.parsedLines,
      cacheMisses: totalReads.cacheMisses - roleReadStart.cacheMisses,
    });
    report.latency.push({ ...metric('role thundering herd', roleSamples, 'read', expectedDirectSamples), hard: false });
    report.observations.push(`role observations=${opts.scale.roles}×${expectedDirectSamples}, indexReads=${indexReads}`);

    const knowledgeSamples: number[] = [];
    let knowledgeMarker = false;
    for (let i = 0; i < expectedDirectSamples; i++) {
      await timed(knowledgeSamples, async () => {
        const injected = await knowledgeService.injectContext('implement');
        knowledgeMarker = injected.prompt.includes('PERF07-KNOWLEDGE-MARKER');
      });
    }
    report.correctness.push({ name: 'knowledge injected marker', ok: knowledgeMarker });
    report.latency.push(metric('knowledge injection', knowledgeSamples, 'read', expectedDirectSamples));

    log('启动隔离 HTTP/SSE 服务');
    server = await startServer({ studioHome: home, telemetry: true, extraEnv: {
      STUDIO_AGENT_LOOP_ENABLED: 'false', PATH: process.env.PATH!, STUDIO_REQUIREMENT_GUARD: 'false',
    } });
    await waitReady(server);
    const baseUrl = server.baseUrl;
    log('校验五域规模数据');
    const [wuPage, messagePage, notificationPage, knowledgePage, actionCenterPage] = await Promise.all([
      httpJson(baseUrl, '/api/v1/workunits?limit=1'),
      httpJson(baseUrl, `/api/v1/channels/${channelId}/messages?limit=1&includeTotal=true`),
      httpJson(baseUrl, '/api/v1/notifications'),
      httpJson(baseUrl, '/api/v1/knowledge/unified?limit=1'),
      httpJson(baseUrl, '/api/v1/action-center'),
    ]);
    report.correctness.push({ name: 'scale matrix visible', ok:
      wuPage.pagination.total >= opts.scale.workUnits && messagePage.data.total >= opts.scale.messages &&
      notificationPage.data.length > 0 && knowledgePage.data.total >= opts.scale.knowledge,
    });
    const stateItems = actionCenterPage.data.stateItems as Array<{ kind: string; wuId: string; scope: string; waitingQuestion?: string; messageId?: string }>;
    const stateKey = (kind: string, wuId: string) => stateItems.some(item => item.kind === kind && item.wuId === wuId && item.scope === `perf scale ${wuId.slice(3)}`);
    const reply = stateItems.find(item => item.kind === 'reply' && item.wuId === 'wu-1');
    report.correctness.push({ name: 'action-center state items', ok:
      stateItems.length === 3 && stateKey('reply', 'wu-1') && stateKey('review', 'wu-2') && stateKey('confirm', 'wu-3') &&
      reply?.waitingQuestion === 'perf waiting question' && reply.messageId === 'm-10',
      detail: JSON.stringify(stateItems),
    });

    log('同端点同冻结快照交替测量 action-center / overview');
    const telemetryBefore = readServerTelemetry(home);
    const expectedHttpSamples = opts.repeats * opts.scale.httpConcurrency * opts.runs;
    const frozenSnapshot = `scale-v1:${JSON.stringify(opts.scale)}`;
    for (const [name, endpoint] of [['action-center concurrent', '/api/v1/action-center'], ['overview concurrent', '/api/v1/monitoring/overview']] as const) {
      const alternating = await measureScenarioAlternating({
        scenario: endpoint, snapshot: frozenSnapshot, repeats: opts.repeats,
        measure: (scenario) => concurrentHttp(baseUrl, scenario, opts.scale.httpConcurrency, opts.runs),
      });
      report.latency.push({
        ...metric(name, [], 'read', expectedHttpSamples), n: alternating.current.n,
        p50: alternating.current.p50, p95: alternating.current.p95, max: alternating.current.max,
      });
      report.observations.push(`${name} same-endpoint B/C order=${alternating.order.join(',')}; p95 B=${alternating.baseline.p95} C=${alternating.current.p95}`);
    }
    const telemetryAfter = readServerTelemetry(home);
    report.diagnostics['HTTP action-center + overview'] = deltaTelemetry(telemetryBefore, telemetryAfter);
    report.observations.push(`cold/warm cacheMisses=${report.diagnostics['HTTP action-center + overview'].cacheMisses}`);

    log(`持续 SSE：${opts.scale.sseClients} 客户端`);
    const sse = await measureSse(baseUrl, opts.scale.sseClients, expectedDirectSamples, channelId);
    report.soak.push(metric('SSE sustained', sse.samples, 'sse', expectedDirectSamples));
    report.correctness.push({ name: 'SSE all clients received', ok: sse.allReceived });
    report.diagnostics['SSE sustained'] = deltaTelemetry(telemetryAfter, readServerTelemetry(home));
    await stopServer(server);
    server = null;

    log('真实 AgentLoop（假 Executor）');
    const loopRole = role('role-loop');
    const wu = await store.createSnapshotGuarded({
      id: 'wu-agent-loop', parentId: null, type: 'task', scope: 'perf real AgentLoop', assigneeId: null,
      status: 'unassigned', failureType: null, retryCount: 0, timeoutAt: null, channelId: null,
      projectPath: null, workspaceId: null, metadata: '{}', createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: new Date().toISOString(), claimedAt: null, completedAt: null,
    }, () => true);
    if (!wu) throw new Error('无法创建 AgentLoop WU');
    const { WorkUnitService } = await import('../../apps/api/src/modules/workunit/index.js');
    const workUnits = new WorkUnitService(store);
    const executor = {
      execute: async () => ({
        success: true, worktree: '', outputFiles: [], logFile: '', sessionCount: 1, totalDurationMs: 1,
        outputText: 'ACTION: PROGRESS: PERF-07 完成真实 Loop 步', rawOutput: '',
        usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 0, cacheCreationTokens: 0, model: 'perf-fake' },
      }),
      stopProcessGroup: async () => {},
    };
    const loop = new AgentLoop(loopRole, store, { executor, instance: {
      id: 'inst-loop', roleId: loopRole.id, sessionId: null, status: 'idle', currentWorkUnitId: null,
      startedAt: new Date().toISOString(), terminatedAt: null, metadata: null, lastHeartbeat: null,
    } });
    const loopSamples: number[] = [];
    let loopStepCount = 0;
    await timed(loopSamples, async () => {
      loop.onWorkUnitClaimable({ workunit: { id: 'wu-agent-loop', claimable: true } });
      const observed = await loop.observe();
      const target = observed.unassigned.find(row => row.id === 'wu-agent-loop');
      if (!target) throw new Error(`AgentLoop 未观察到目标 WU；unassigned=${observed.unassigned.map(row => row.id).join(',')}`);
      const claimed = await workUnits.claim(target.id, 'inst-loop');
      const result = await loop.agentStep({ workUnit: claimed! });
      await loop.recordResult({ workUnit: claimed! }, result);
      loopStepCount = JSON.parse((await workUnits.getById(target.id))!.metadata ?? '{}').stepCount ?? 0;
    });
    report.correctness.push({ name: 'AgentLoop step persisted', ok: loopStepCount === 1 });
    report.latency.push({ ...metric('real AgentLoop step', loopSamples, 'write', 1), hard: false });
    loop.stopLease();
    eventBus.unsubscribeAll('channel.message_sent');
    eventBus.unsubscribeAll('workunit.created');
    eventBus.unsubscribeAll('workunit.status_changed');
    setReadMetricsSink(null);
    fs.promises.readFile = originalRead;
    fs.promises.open = originalOpen;
    JSON.parse = originalParse;
    report.observations.push('所有 max、读取字节、parse 行数、RSS/event-loop 均为诊断；硬门仅 p50/p95/绝对预算/correctness。');
    completed = true;
    return report;
  } finally {
    if (server) await stopServer(server);
    if (completed) removeTempHome(home);
    else console.error(`[perf-scale] 失败现场保留：${home}`);
  }
}

async function measureSse(baseUrl: string, clientCount: number, rounds: number, channelId: string): Promise<{ samples: number[]; allReceived: boolean }> {
  const clients = await Promise.all(Array.from({ length: clientCount }, async () => {
    const controller = new AbortController();
    const res = await fetch(`${baseUrl}/api/v1/events/stream?topics=workunits`, { signal: controller.signal });
    if (!res.ok || !res.body) throw new Error(`SSE 连接失败 ${res.status}`);
    const seen = new Set<string>();
    const pump = (async () => {
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = frame.split('\n').find(line => line.startsWith('data: '));
          if (!data) continue;
          try {
            const event = JSON.parse(data.slice(6));
            const id = event.data?.workunit?.id ?? event.data?.id;
            if (event.event_type === 'workunit.created' && id) seen.add(id);
          } catch { /* heartbeat */ }
        }
      }
    })();
    return { controller, seen, pump };
  }));
  await new Promise(resolve => setTimeout(resolve, 300));
  const samples: number[] = [];
  let allReceived = true;
  try {
    for (let i = 0; i < rounds; i++) {
      const started = performance.now();
      const body = await httpJson(baseUrl, '/api/v1/workunits', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ scope: `perf-sse-${Date.now()}-${i}`, type: 'task', channelId }),
      });
      const id = body.data.id;
      const deadline = Date.now() + 15_000;
      while (!clients.every(client => client.seen.has(id)) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      const received = clients.every(client => client.seen.has(id));
      allReceived &&= received;
      if (!received) throw new Error(`SSE 客户端未全部收到 ${id}`);
      samples.push(performance.now() - started);
    }
  } finally {
    for (const client of clients) {
      client.controller.abort();
      await client.pump.catch(() => {});
    }
  }
  return { samples, allReceived };
}

export function renderScaleMarkdown(report: ScaleReport): string {
  const lines = ['## PERF-07 规模/并发门禁', '', `规模：${JSON.stringify(report.scale)}`, '', '| 场景 | p50 | p95 | max（诊断） |', '|---|---:|---:|---:|'];
  for (const row of [...report.latency, ...report.soak]) lines.push(`| ${row.name} | ${row.p50.toFixed(1)} ms | ${row.p95.toFixed(1)} ms | ${row.max.toFixed(1)} ms |`);
  lines.push('', `correctness：${report.correctness.filter(row => row.ok).length}/${report.correctness.length} 通过`);
  for (const failure of report.correctness.filter(row => !row.ok)) lines.push(`- FAIL ${failure.name}${failure.detail ? `：${failure.detail}` : ''}`);
  for (const observation of report.observations) lines.push(`- ${observation}`);
  return lines.join('\n');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const opts = parseScaleArgs(process.argv.slice(2));
  runScale(opts).then(report => {
    const failures = evaluateScaleReport(report);
    console.log(renderScaleMarkdown(report));
    const out = opts.out ?? path.join(os.tmpdir(), `studio-scale-report-${Date.now()}.json`);
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    console.error(`[perf-scale] JSON 报告：${out}`);
    process.exit(Object.values(failures).some(rows => rows.length > 0) ? 1 : 0);
  }).catch(error => { console.error(`[perf-scale] 失败：${error instanceof Error ? error.stack ?? error.message : error}`); process.exit(1); });
}

export { runScale };
