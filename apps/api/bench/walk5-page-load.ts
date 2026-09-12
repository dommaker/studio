/**
 * #510 走查⑤ bench：GET /:id/messages 分页读路径 + monitoring 读端点成本量化。
 *
 * 运行：cd apps/api && node_modules/.bin/tsx bench/walk5-page-load.ts
 *
 * 纪律：
 * - ~/.studio 全程只读（FileStore 读口 / 窗口事件读 / 目录列举，零写入）；
 * - 合成规模数据全部在 os.tmpdir() 下新建，跑完保留路径打印，手工清理；
 * - monitoring /agents 的 listProjects 用等价轻量 stub（直接读 ~/.studio/projects/*.json），
 *   避免 lazy import project.service 拉入 channels/workunit 模块链的装载副作用；
 * - /flywheel 不测 knowledgeService 单例（knowledge-singletons 装载期 pkill 副作用），
 *   改为分别实测其两个成本组件：memo 包 knowledge store list({}) + 窗口事件扫描×2。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { FileStore } from '@dommaker/studio-shared';
import { setReadMetricsSink, runWithLoopLabel, type ReadMetricEvent } from '@dommaker/studio-shared/read-metrics';
import { FileKnowledgeStore } from '@dommaker/harness';
import { MonitoringService } from '../src/modules/monitoring/monitoring.service.js';
import { MtimeMemoKnowledgeStore } from '../src/modules/knowledge/knowledge-store-memo.js';
import { scanKnowledgeEvents, computeOutcomeMetrics } from '../src/modules/knowledge/knowledge-metrics.js';

const REAL_DATA = '/root/.studio/data';
const REAL_EVENTS = '/root/.studio/logs/studio-events.jsonl';
const REAL_KNOWLEDGE = '/root/.studio/knowledge';
const REAL_PROJECTS = '/root/.studio/projects';
const SYS_CHANNEL = 'sys-1785722554417-mnre'; // 492 行 / 272KB 热 + 1 冷月 79 行（实测最大频道）

// ── 计时与统计 ──
export interface Stat { n: number; mean: number; p50: number; p95: number; max: number }
export function statOf(xs: number[]): Stat {
  const s = [...xs].sort((a, b) => a - b);
  const pick = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, mean: s.reduce((a, b) => a + b, 0) / s.length, p50: pick(0.5), p95: pick(0.95), max: s[s.length - 1] };
}
const fmt = (s: Stat) => `n=${s.n} mean=${s.mean.toFixed(2)}ms p50=${s.p50.toFixed(2)}ms p95=${s.p95.toFixed(2)}ms max=${s.max.toFixed(2)}ms`;

// ── read-metrics 收集 ──
const events: ReadMetricEvent[] = [];
setReadMetricsSink(e => events.push(e));
function drainEvents(label: string): ReadMetricEvent[] {
  return events.filter(e => e.loop === label);
}
function sumEvents(evs: ReadMetricEvent[]): { stat: number; parse: number; clone: number; hits: number; misses: number } {
  return {
    stat: evs.reduce((a, e) => a + e.statMs, 0),
    parse: evs.reduce((a, e) => a + e.readParseMs, 0),
    clone: evs.reduce((a, e) => a + e.cloneMs, 0),
    hits: evs.filter(e => e.cacheHit).length,
    misses: evs.filter(e => !e.cacheHit).length,
  };
}

// ── 合成频道数据 ──
const CONTENT = 'x'.repeat(420); // 真实样本行均 ~550B/行（272KB/492 行）
export function synthChannel(base: string, channelId: string, hotLines: number, coldMonths: number, coldLinesPerMonth: number): void {
  const dir = path.join(base, 'channels', channelId);
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.now() - (hotLines + coldMonths * coldLinesPerMonth) * 60_000;
  const row = (i: number) => JSON.stringify({
    id: `m-${channelId}-${i}`, channelId, authorType: 'agent', agentName: 'Bench',
    content: `${CONTENT} ${i}`, replyToId: null, meta: '{"cardType":"bench"}', workUnitId: null,
    createdAt: new Date(t0 + i * 60_000).toISOString(),
  });
  const hot: string[] = [];
  for (let i = 0; i < hotLines; i++) hot.push(row(i));
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), hot.join('\n') + '\n');
  if (coldMonths > 0) {
    fs.mkdirSync(path.join(dir, 'archive'), { recursive: true });
    for (let m = 0; m < coldMonths; m++) {
      const month = `2024-${String(m + 1).padStart(2, '0')}`;
      const rows: string[] = [];
      for (let i = 0; i < coldLinesPerMonth; i++) rows.push(row(hotLines + m * coldLinesPerMonth + i));
      fs.writeFileSync(path.join(dir, 'archive', `messages-${month}.jsonl`), rows.join('\n') + '\n');
    }
  }
}

async function benchMessagesPage(label: string, store: FileStore, channelId: string, warmCalls: number, opts?: { before?: string }): Promise<void> {
  const walls: number[] = [];
  events.length = 0;
  for (let i = 0; i < warmCalls + 1; i++) {
    const tag = `${label}#${i === 0 ? 'cold' : 'warm'}`;
    const t0 = performance.now();
    await runWithLoopLabel(tag, () => store.queryMessagesPage(channelId, { limit: 50, before: opts?.before }));
    const ms = performance.now() - t0;
    if (i > 0) walls.push(ms);
    else console.log(`  [${label}] cold(首调,缓存全空): ${ms.toFixed(2)}ms  events=${JSON.stringify(sumEvents(drainEvents(tag)))}`);
  }
  const warmEvs = drainEvents(`${label}#warm`);
  const per = warmEvs.length / warmCalls;
  const sum = sumEvents(warmEvs);
  console.log(`  [${label}] warm: ${fmt(statOf(walls))}`);
  console.log(`  [${label}] warm读口/次: events=${per.toFixed(1)} stat=${(sum.stat / warmCalls).toFixed(2)}ms parse=${(sum.parse / warmCalls).toFixed(2)}ms clone=${(sum.clone / warmCalls).toFixed(2)}ms hits=${sum.hits / warmCalls} misses=${sum.misses / warmCalls}`);
}

async function benchFn(label: string, fn: () => Promise<unknown>, warmCalls = 25): Promise<void> {
  const walls: number[] = [];
  const t0 = performance.now();
  await fn();
  console.log(`  [${label}] cold(首调): ${(performance.now() - t0).toFixed(2)}ms`);
  for (let i = 0; i < warmCalls; i++) {
    const t = performance.now();
    await fn();
    walls.push(performance.now() - t);
  }
  console.log(`  [${label}] warm: ${fmt(statOf(walls))}`);
}

async function main(): Promise<void> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walk5-bench-'));
  console.log(`[bench] tmp root: ${tmp}`);

  // ── Part A1：真实 1x（只读 ~/.studio/data）──
  console.log('\n== A1 queryMessagesPage 真实 1x（sys 频道：热 492 行/272KB + 冷 1 月 79 行） ==');
  await benchMessagesPage('A1-real', new FileStore(REAL_DATA), SYS_CHANNEL, 30);

  // ── Part A2：合成规模扫描 ──
  for (const [hot, coldM, coldL] of [[5000, 0, 0], [5000, 12, 1000], [20000, 0, 0], [20000, 12, 1000], [50000, 0, 0]] as const) {
    const base = path.join(tmp, `h${hot}-c${coldM}x${coldL}`);
    synthChannel(base, 'ch', hot, coldM, coldL);
    console.log(`\n== A2 queryMessagesPage 合成：热 ${hot} 行 + 冷 ${coldM} 月×${coldL} 行 ==`);
    await benchMessagesPage(`A2-h${hot}-c${coldM}`, new FileStore(base), 'ch', 25);
  }

  // ── Part A3：深冷页（锚在最老冷月，iterateColdMessages 全月扫）──
  {
    const base = path.join(tmp, 'deep-cold');
    synthChannel(base, 'ch', 1000, 12, 1000);
    const oldestId = 'm-ch-1000'; // 最老冷月（2024-01）首行 id
    console.log('\n== A3 深冷页：热 1000 + 冷 12 月×1000，锚在最老冷月（遍历全 12 月） ==');
    await benchMessagesPage('A3-deepcold', new FileStore(base), 'ch', 15, { before: oldestId });
  }

  // ── Part B：monitoring 聚合（只读真实数据）──
  console.log('\n== B monitoring 聚合（真实 1x：19 agents/8 profiles、WU index、events 250KB、knowledge 18MB） ==');
  const fileStore = new FileStore(REAL_DATA);
  const listProjects = async () => {
    // 等价 projectService.list 的读量：逐文件读 ~/.studio/projects/*.json
    const dir = REAL_PROJECTS;
    const out: unknown[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try { out.push(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8'))); } catch { /* 坏文件跳过 */ }
    }
    return out as never[];
  };
  const svc = new MonitoringService(fileStore, null, { listProjects });
  await benchFn('B1-/agents getAgentSummary', () => svc.getAgentSummary());
  await benchFn('B2-/stats getStats', () => svc.getStats());
  await benchFn('B3-/overhead getOverheadStats', () => svc.getOverheadStats({ eventsFile: REAL_EVENTS }));

  // /flywheel 组件：memo knowledge store（tmp 副本，防污染）+ 窗口事件扫描 ×2
  const kbCopy = path.join(tmp, 'knowledge');
  fs.cpSync(REAL_KNOWLEDGE, kbCopy, { recursive: true });
  const memoStore = new MtimeMemoKnowledgeStore(new FileKnowledgeStore({ baseDir: kbCopy }));
  await benchFn('B4-/flywheel 组件a store.list({})（memo 指纹校验）', async () => { memoStore.list({}); });
  await benchFn('B5-/flywheel 组件b scanKnowledgeEvents（30d 窗口尾读）', () => scanKnowledgeEvents({ eventsFile: REAL_EVENTS }));
  await benchFn('B6-/flywheel 组件c computeOutcomeMetrics（30d 窗口尾读）', () => computeOutcomeMetrics({ eventsFile: REAL_EVENTS }));

  console.log(`\n[bench] done. tmp root kept: ${tmp}`);
}

// 仅作为脚本直跑时执行（vitest import 不触发，供 __tests__ 测 statOf/synthChannel）
if (require.main === module) {
  main().catch(err => { console.error('[bench] failed:', err); process.exit(1); });
}
