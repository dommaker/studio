/**
 * #323 阶段一 bench：单规模档循环驱动 worker（由 loop-read-metrics.ts 以子进程方式调用）。
 *
 * 环境输入（父进程注入，必须在任何 app 模块 import 前生效——多处模块级常量在
 * import 期冻结 studioPath/STUDIO_HOME）：
 *   STUDIO_HOME          本档合成数据根（含 data/ 与 logs/）
 *   STUDIO_DATA_DIR      = STUDIO_HOME/data（FileStore 无参构造锚点）
 *   STUDIO_BENCH_OUT     worker JSON 输出路径
 *   STUDIO_BENCH_ROUNDS  每循环轮数（默认 21 = 1 冷 + 20 暖）
 *   STUDIO_BENCH_OPS_PORT ops getStatus 探活的本地 stub HTTP 端口
 *   WORKTREES_DIR/REPO_DIR 空 tmp 目录（monitor worktree GC 不碰宿主机真实目录）
 *
 * 输出 JSON（read-metrics-aggregate.WorkerResult）：逐轮（loop, round, wallMs, events[]）。
 * 事件在 sink 处即按存储源分桶并丢弃具体路径（50x 档单轮事件量数万级，控内存）。
 *
 * 安全闸：triageService.handleAlert 被替换为记录桩——bench 数据设计上不触发 Triage
 * 升级，但升级路径会拉 systemExecutor 跑 LLM 诊断，必须物理隔离；触发次数记入输出。
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { FileStore } from '@dommaker/studio-shared';
// 与 file-store.ts 的 './read-metrics' 解析到同一绝对路径 → 同一模块实例（sink 生效前提）
import { setReadMetricsSink, runWithLoopLabel } from '../../../packages/studio-shared/src/read-metrics.js';
import { scanTimedOutWorkUnits } from '../src/modules/workunit/timeout-release.js';
import { scanStaleAgentInstances } from '../src/modules/agents/instance-timeout-scan.js';
import { scanWaitingForInputReminders } from '../src/modules/workunit/waiting-input.js';
import { reconcileDispatchBreaks } from '../src/modules/agents/dispatch-reconciliation.js';
import { MonitorService } from '../src/modules/agents/monitor/monitor.service.js';
import { OpsService } from '../src/modules/agents/ops/ops.service.js';
import { AuditorService } from '../src/modules/agents/auditor/auditor.service.js';
import { loadWindowSignals, resolveEvolutionPaths } from '../src/modules/evolution/signals.js';
import { triageService } from '../src/modules/agents/triage/triage.service.js';
import type { BenchReadEvent, BenchRound, WorkerResult } from './read-metrics-aggregate.js';

// ── 向量库同步桩（第二道）──
// knowledge 任何写入（recordPattern/ingest/resolution 等）都会 scheduleVectorDbSync →
// execFile('systemd-run', …) 起 mcp-local-rag ingest（写共享生产 lancedb + 30min 子进程
// 吊住事件 loop）。第一道隔离在父进程（PATH 前置假 systemd-run，模块内部直线调用也能拦住）；
// 此处再桩 exports（覆盖模块间调用点），双保险。bench 绝不触碰共享向量库。
import * as knowledgeSingletons from '../src/modules/knowledge/knowledge-singletons.js';
import * as knowledgeBus from '../src/modules/knowledge/knowledge-bus.service.js';
// tsx(CJS interop) 下 exports 可变、桩生效；vitest(ESM) 下 namespace 只读 → 跳过
// （bench 测试只测 bucketOfFor 纯函数；运行期隔离由父进程假 systemd-run 保证）
try { (knowledgeSingletons as any).scheduleVectorDbSync = () => {}; } catch { /* ESM readonly */ }
try { (knowledgeBus as any).scheduleVectorDbSync = () => {}; } catch { /* ESM readonly */ }

const HOME = process.env.STUDIO_HOME!;
const OUT = process.env.STUDIO_BENCH_OUT!;
const ROUNDS = Number(process.env.STUDIO_BENCH_ROUNDS ?? 21);
const OPS_PORT = Number(process.env.STUDIO_BENCH_OPS_PORT ?? 0);

// ── 存储源分桶（sink 处即归约，防 50x 档事件量撑爆内存）──
export function bucketOfFor(home: string, file: string): string {
  const rel = path.relative(home, file);
  if (rel === path.join('data', 'workunits', 'index.json')) return 'wu-index';
  if (rel === path.join('logs', 'studio-events.jsonl')) return 'studio-events';
  if (rel === path.join('data', 'agents')) return 'agents-dir';
  if (rel.startsWith(path.join('data', 'agents') + path.sep)) {
    if (file.endsWith('state.json')) return 'agent-state';
    if (file.endsWith('profile.json')) return 'agent-profile';
    return 'agent-other';
  }
  if (rel.startsWith(path.join('data', 'workunits') + path.sep)) return 'wu-other';
  if (rel.startsWith(path.join('data', 'channels'))) return 'channels';
  if (rel.startsWith('knowledge')) return 'knowledge';
  return 'other';
}

const bucketOf = (file: string): string => bucketOfFor(HOME, file);

let currentRound: BenchRound | null = null;
setReadMetricsSink(e => {
  currentRound?.events.push({
    op: e.op,
    bucket: bucketOf(e.file),
    hit: e.cacheHit,
    statMs: e.statMs,
    readParseMs: e.readParseMs,
    cloneMs: e.cloneMs,
  });
});

// ── Triage 安全闸（见文件头注释）──
const triageCalls: unknown[] = [];
(triageService as any).handleAlert = async (input: unknown) => {
  triageCalls.push(input);
  return { incidentId: 'bench-stub', actions: [], findings: [] };
};

async function main(): Promise<void> {
  const dataDir = path.join(HOME, 'data');
  const fileStore = new FileStore(dataDir);

  // ops getStatus 探活 stub：/api/v1/channels → 200（apiResponding=true，避开重启/退出分支）
  const stub = http.createServer((_req, res) => { res.statusCode = 200; res.end('[]'); });
  await new Promise<void>(resolve => stub.listen(OPS_PORT, '127.0.0.1', resolve));

  // monitor：把日级/小时级周期项预置为「刚跑过」，测常态 5 分钟轮
  // （dailyReflection/dataLifecycle/knowledge decay/user-model 更新 = 1/288 轮，不属于常态轮）
  const monitor = new MonitorService(fileStore);
  const today = new Date().toISOString().split('T')[0];
  (monitor as any).knowledgeCycleState.lastDecayRun = Date.now();
  (monitor as any).knowledgeCycleState.lastUserModelRun = Date.now();
  (monitor as any).reportState.lastDailyReflectionTs = Date.now();
  (monitor as any).lifecycleState.lastPrecipitateRun = today;
  (monitor as any).lifecycleState.lastDataLifecycleRun = today;

  const ops = new OpsService(OPS_PORT, fileStore);
  (ops as any)._lastGc = Date.now(); // worktree GC 为小时级，同非常态轮

  const auditor = new AuditorService(fileStore);
  const evolutionPaths = resolveEvolutionPaths({ repoRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'bench-repo-')) });

  const loops: Array<{ label: string; run: () => Promise<unknown> }> = [
    { label: 'wu-timeout', run: () => scanTimedOutWorkUnits(fileStore) },
    { label: 'agent-timeout', run: () => scanStaleAgentInstances(fileStore) },
    { label: 'workunit-input-reminder', run: () => scanWaitingForInputReminders(fileStore) },
    { label: 'dispatch-reconciliation', run: () => reconcileDispatchBreaks(fileStore) },
    { label: 'monitor-round', run: () => (monitor as any).check() },
    { label: 'ops-round', run: () => (ops as any).healthCheck() },
    { label: 'auditor-round', run: () => (auditor as any).dailyAudit() },
    { label: 'evolution-scan', run: () => loadWindowSignals(evolutionPaths, 24, fileStore) },
  ];

  const rounds: BenchRound[] = [];
  for (const loop of loops) {
    for (let r = 0; r < ROUNDS; r++) {
      const round: BenchRound = { loop: loop.label, round: r, wallMs: 0, events: [] };
      currentRound = round;
      const t0 = performance.now();
      await runWithLoopLabel(loop.label, () => loop.run());
      round.wallMs = performance.now() - t0;
      currentRound = null;
      rounds.push(round);
    }
  }

  const stat = (p: string) => (fs.existsSync(p) ? fs.readdirSync(p).length : 0);
  const result: WorkerResult = {
    scale: process.env.STUDIO_BENCH_SCALE ?? 'unknown',
    meta: {
      rounds: ROUNDS,
      templateWorkUnits: JSON.parse(fs.readFileSync(path.join(dataDir, 'workunits', 'index.json'), 'utf-8')).length,
      eventLines: fs.readFileSync(path.join(HOME, 'logs', 'studio-events.jsonl'), 'utf-8').split('\n').filter(l => l.trim()).length,
      agentDirs: stat(path.join(dataDir, 'agents')),
      triageStubCalls: triageCalls.length,
    } as WorkerResult['meta'],
    rounds,
  };

  fs.writeFileSync(OUT, JSON.stringify(result));
  stub.close();
  // 给 fire-and-forget 写入（事件落盘等）一个排干窗口
  await new Promise(r => setTimeout(r, 200));
  if (process.env.STUDIO_BENCH_DEBUG_HANDLES) {
    const handles = (process as any)._getActiveHandles() as unknown[];
    console.error('[bench-worker] active handles:', handles.map(h => h?.constructor?.name));
    const reqs = (process as any)._getActiveRequests() as unknown[];
    console.error('[bench-worker] active requests:', reqs.map(h => h?.constructor?.name));
  }
}

// 仅作为脚本直跑时执行（vitest import 不触发，供 __tests__ 测纯函数）
if (require.main === module) {
  main().catch(err => {
    console.error('[bench-worker] failed:', err);
    process.exit(1);
  });
}
