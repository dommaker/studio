/**
 * #521 频道主链路离线对齐工具（spec .studio/specs/2026-09-12-channel-mainline-measurement §2）。
 *
 * 用法：npx tsx bench/mainline-align.ts [--since 24h|7d|ISO] [--until ISO] [--traceId <id>]
 *   [--studio-home <dir>] [--events-file <path>]
 *   --since/--until  时间窗（按 WU 建成时间过滤；缺省 = 全量）
 *   --traceId        只输出该 traceId 的单链明细（含四段 + 步级分解 + 关联消息）
 *   --studio-home    数据根（默认 $STUDIO_HOME 或 ~/.studio）
 *   --events-file    studio-events.jsonl 覆盖（默认 <studio-home>/logs/studio-events.jsonl）
 *
 * 只读三家数据源：频道消息热文件、WU 快照/事件、studio-events 事件流；
 * 零新服务端埋点，不碰生产写路径。四段口径与跳过标注见 mainline-align-core.ts 头注。
 * 命令行壳不测（spec Testing Decisions），纯函数测试见 __tests__/mainline-align-core.test.ts。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  buildChains,
  filterChainsByWindow,
  summarizeChains,
  findChainsByTraceId,
  CLIENT_PERF_TYPES,
  type AlignInput,
  type ChannelMessageRow,
  type WorkUnitSnapshotRow,
  type StudioEventRow,
  type MainlineChain,
  type SegmentStats,
} from './mainline-align-core.js';

export interface CliArgs {
  sinceMs: number | null;
  untilMs: number | null;
  traceId: string | null;
  studioHome: string;
  eventsFile: string | null;
}

/** --since 取值：相对时长（24h/7d/30m）或 ISO 时间 */
function parseTimeArg(v: string, now: number): number | null {
  const rel = /^(\d+)([mhd])$/.exec(v);
  if (rel) {
    const n = Number(rel[1]);
    const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as 'm' | 'h' | 'd'];
    return now - n * unit;
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

export function parseArgs(argv: string[] = process.argv.slice(2), now: number = Date.now()): CliArgs {
  const get = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    sinceMs: get('--since') ? parseTimeArg(get('--since')!, now) : null,
    untilMs: get('--until') ? parseTimeArg(get('--until')!, now) : null,
    traceId: get('--traceId') ?? null,
    studioHome: get('--studio-home') ?? process.env.STUDIO_HOME ?? path.join(os.homedir(), '.studio'),
    eventsFile: get('--events-file') ?? null,
  };
}

function readJsonl<T>(file: string): T[] {
  try {
    return fs.readFileSync(file, 'utf8')
      .split('\n')
      .filter(line => line.trim())
      .flatMap(line => {
        try {
          return [JSON.parse(line) as T];
        } catch {
          return []; // 损坏行跳过（同 readJsonl 口径）
        }
      });
  } catch {
    return []; // 文件不存在/不可读 → 空数据源，跳过标注由汇总层如实呈现
  }
}

export function loadInput(args: CliArgs): AlignInput & { dataNotes: string[] } {
  const dataNotes: string[] = [];
  const channelsDir = path.join(args.studioHome, 'data', 'channels');
  const messages: ChannelMessageRow[] = [];
  let channelDirs: string[] = [];
  try {
    channelDirs = fs.readdirSync(channelsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
  } catch {
    dataNotes.push(`频道目录不可读：${channelsDir}（消息数据源为空）`);
  }
  for (const ch of channelDirs) {
    messages.push(...readJsonl<ChannelMessageRow>(path.join(channelsDir, ch, 'messages.jsonl')));
  }

  let workunits: WorkUnitSnapshotRow[] = [];
  const wuIndex = path.join(args.studioHome, 'data', 'workunits', 'index.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(wuIndex, 'utf8'));
    workunits = Array.isArray(parsed) ? parsed : [];
  } catch {
    dataNotes.push(`WU 快照不可读：${wuIndex}（WU 数据源为空）`);
  }

  const eventsFile = args.eventsFile ?? path.join(args.studioHome, 'logs', 'studio-events.jsonl');
  const events = readJsonl<StudioEventRow>(eventsFile);
  if (events.length === 0) dataNotes.push(`事件流为空或不可读：${eventsFile}`);

  return { messages, workunits, events, dataNotes };
}

const fmtMs = (v: number | null) => (v === null ? '—' : v >= 10_000 ? `${(v / 1000).toFixed(1)}s` : `${Math.round(v)}ms`);

function fmtSegment(name: string, s: SegmentStats): string {
  const lines = [`### ${name}（n=${s.n}）`, ''];
  if (s.n > 0) {
    lines.push(`p50 ${fmtMs(s.p50Ms)} ・ p95 ${fmtMs(s.p95Ms)} ・ min ${fmtMs(s.minMs)} ・ max ${fmtMs(s.maxMs)}`);
  } else {
    lines.push('无样本。');
  }
  const skips = Object.entries(s.skipped);
  if (skips.length > 0) {
    lines.push(`跳过标注：${skips.map(([k, n]) => `${k} ×${n}`).join('，')}`);
  }
  return lines.join('\n');
}

function fmtChainDetail(c: MainlineChain): string {
  const isoAt = (t: number | null) => (t === null ? '—' : new Date(t).toISOString());
  const lines = [
    `- WU \`${c.workUnitId}\`（频道 ${c.channelId ?? '—'}，traceId ${c.traceId ?? '—'}，建成 ${isoAt(c.wuCreatedAt)}）`,
    `  - 派单：${fmtMs(c.dispatchMs)}（派发消息 ${c.dispatchMessageId ?? '—'}）`,
    `  - 等认领：${fmtMs(c.waitClaimMs)}`,
    `  - 执行总时长：${fmtMs(c.executionMs)}`,
  ];
  if (c.steps.length > 0) {
    lines.push('  - 步级分解：');
    for (const s of c.steps) {
      lines.push(`    - step ${s.step} @ ${isoAt(s.at)}（+${fmtMs(s.deltaMs)}${s.status ? `，${s.status}` : ''}）`);
    }
  }
  lines.push(`  - 回执落库：${fmtMs(c.receiptMs)}（回执消息 ${c.receiptMessageId ?? '—'}）`);
  if (c.skips.length > 0) lines.push(`  - 跳过标注：${c.skips.join('，')}`);
  return lines.join('\n');
}

function main(): void {
  const args = parseArgs();
  const { messages, workunits, events, dataNotes } = loadInput(args);
  const allChains = buildChains({ messages, workunits, events });
  const chains = filterChainsByWindow(allChains, { sinceMs: args.sinceMs, untilMs: args.untilMs });

  const out: string[] = ['# 频道主链路离线对齐报告', ''];
  out.push(`数据源：${args.studioHome}（消息 ${messages.length} 行 / WU ${workunits.length} 条 / 事件 ${events.length} 行）`);
  const winDesc = [
    args.sinceMs !== null ? `since ${new Date(args.sinceMs).toISOString()}` : null,
    args.untilMs !== null ? `until ${new Date(args.untilMs).toISOString()}` : null,
  ].filter(Boolean).join(' ');
  out.push(`时间窗：${winDesc || '全量'}；链路样本 ${chains.length} / ${allChains.length}（窗内/全部）`);
  for (const note of dataNotes) out.push(`> 数据提示：${note}`);
  out.push('');

  if (args.traceId) {
    const hits = findChainsByTraceId(chains, args.traceId);
    out.push(`## 单链明细（traceId = ${args.traceId}，命中 ${hits.length} 条）`, '');
    if (hits.length === 0) out.push('未命中（时间窗内无该 traceId 的 WU）。');
    for (const c of hits) out.push(fmtChainDetail(c));
  } else {
    const report = summarizeChains(chains, events);
    out.push('## 四段分布', '');
    out.push(fmtSegment('派单（消息落库 → WU 建成）', report.segments.dispatch), '');
    out.push(fmtSegment('等认领（WU 建成 → claimedAt）', report.segments.waitClaim), '');
    out.push(fmtSegment('执行总时长（认领 → 完成）', report.segments.execution), '');
    out.push(fmtSegment('回执落库（执行产出 → 频道消息落库）', report.segments.receipt), '');
    out.push('## 前端埋点段（client.perf.*，source web-client）', '');
    for (const type of CLIENT_PERF_TYPES) {
      const s = report.clientPerf[type];
      out.push(s.n === 0
        ? `- ${type}：跳过（no_samples——前端埋点数据未产生）`
        : `- ${type}：n=${s.n}${s.p50Ms !== null ? `，ms p50 ${fmtMs(s.p50Ms)} ・ p95 ${fmtMs(s.p95Ms)}` : '（点事件无 ms）'}`);
    }
  }
  console.log(out.join('\n'));
}

// 仅作为脚本直跑时执行（vitest import 不触发，供 __tests__ 测 parseArgs/loadInput；同 loop-read-metrics 先例）
if (require.main === module) {
  main();
}
