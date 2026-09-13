/**
 * #507 走查②路由派单 bench：routeMessage 链路各读/写口成本量化。
 *
 * 用法（只读 ~/.studio，合成数据全在 tmp）：
 *   VITEST=1 STUDIO_HOME=<tmp> node_modules/.bin/tsx <本脚本> [--rounds N] [--scales 1,10,50]
 *
 * 测什么（对应 routeMessage 各环节的真实读口）：
 *   A. appendMessage              —— 每条落库消息的写成本（含 per-channel flock）
 *   B. readMessagesTail(human,20) —— #524 P1-1 后 findMergeTargetWorkUnit 的查询（尾部倒扫）
 *   B0. queryMessages(after write)—— 对照：#524 前旧路径（缓存失效后全热文件读+parse+clone）
 *   C. queryMessages(warm hit)    —— 对照：无写入间隙时 mtime 命中路径（stat + structuredClone）
 *   D. tailScan20Human            —— 候选替代：iterateJsonlLinesBackward 倒扫凑满 20 条人类消息即停
 *   E. getMessageById(channelId)  —— #524 P1-1 后 replyTo/linkWorkUnit 的父消息查找（本频道直查）
 *   E0. getMessageById(fanout)    —— 对照：#524 前全频道扇出
 *   F. getMessageById(channelId, warm hit) —— 对照
 *   G. getIndex({id})             —— WU 点读（findMergeTargetWorkUnit 第二步 / resumeWaitingWorkUnit）
 *   H. commitSnapshot             —— 建 WU 持久化成本（#524 P1-2 后 = 锁内 appendEvent + 索引 append 一行）
 *
 * 数据：1x = 真实 ~/.studio/data 只读复制；10x/50x = 最大频道消息行复制放大
 * （id 重生成防 mergeActiveRows 归并塌缩，行内分布/大小保持真实）。WU 索引各档同为真实 1x（49 条）。
 * --wuscales：WU 写侧扫档（#524 P1-2 验收：commitSnapshot 耗时不随 WU 数线性增长），
 * 独立合成 index.json = 49×wuScale 条（新 JSONL 格式），其余最小化。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { FileStore, parseWorkUnitIndexContent } from '/root/projects/studio/packages/studio-shared/src/file-store.ts';
import { iterateJsonlLinesBackward } from '/root/projects/studio/packages/studio-shared/src/jsonl-tail.ts';

const REAL_DATA = path.join(os.homedir(), '.studio', 'data');
const ROUNDS = Number(process.argv[process.argv.indexOf('--rounds') + 1] || 20);
const SCALES = (process.argv[process.argv.indexOf('--scales') + 1] || '1,10,50').split(',').map(Number);
/** WU 写侧扫档（#524 P1-2 验收）：--wuscales 1,100,500 → index 条目 = 49×档；空 = 不跑 */
const WUSCALES = process.argv.includes('--wuscales')
  ? (process.argv[process.argv.indexOf('--wuscales') + 1] || '').split(',').filter(Boolean).map(Number)
  : [];
/** 只跑指定测量项（逗号分隔 key 字母，如 BENCH_ONLY=B,D）——隔离大克隆 GC 噪声时用 */
const ONLY = process.env.BENCH_ONLY ? new Set(process.env.BENCH_ONLY.split(',')) : null;
const enabled = (key: string) => !ONLY || ONLY.has(key[0]);
/** 指定放大的频道（缺省 = 行数最多频道）；706…为人类消息频道时观察近尾命中场景 */
const BIG_CID = process.env.BENCH_BIG_CID || null;

interface Row { id: string; authorType?: string; createdAt?: string; workUnitId?: string | null; [k: string]: unknown }

function readLines(file: string): string[] {
  return fs.readFileSync(file, 'utf-8').split('\n').filter(l => l.trim().length > 0);
}

/** 复制真实 channels 到 out；largestCid 的消息行按 scale 放大（id 加后缀防归并塌缩） */
function synthesize(outRoot: string, scale: number): { channelIds: string[]; largestCid: string; largestLines: number; largestBytes: number } {
  const srcChannels = path.join(REAL_DATA, 'channels');
  const outChannels = path.join(outRoot, 'channels');
  fs.mkdirSync(outChannels, { recursive: true });
  const cids = fs.readdirSync(srcChannels).filter(d => fs.existsSync(path.join(srcChannels, d, 'messages.jsonl')));
  // 找放大目标频道（BENCH_BIG_CID 指定；缺省取行数最多者）
  let largestCid = '';
  let largestRows: Row[] = [];
  for (const cid of cids) {
    const rows = readLines(path.join(srcChannels, cid, 'messages.jsonl')).map(l => JSON.parse(l) as Row);
    if (rows.length > largestRows.length) { largestRows = rows; largestCid = cid; }
  }
  if (BIG_CID && cids.includes(BIG_CID)) {
    largestCid = BIG_CID;
    largestRows = readLines(path.join(srcChannels, BIG_CID, 'messages.jsonl')).map(l => JSON.parse(l) as Row);
  }
  for (const cid of cids) {
    fs.mkdirSync(path.join(outChannels, cid), { recursive: true });
    const srcFile = path.join(srcChannels, cid, 'messages.jsonl');
    const outFile = path.join(outChannels, cid, 'messages.jsonl');
    if (cid !== largestCid || scale === 1) {
      fs.copyFileSync(srcFile, outFile);
    } else {
      const lines: string[] = [];
      for (let r = 0; r < scale; r++) {
        for (const row of largestRows) lines.push(JSON.stringify({ ...row, id: `${row.id}__r${r}` }));
      }
      fs.writeFileSync(outFile, lines.join('\n') + '\n');
    }
  }
  // WU 索引/事件：各档同为真实 1x 复制（commitSnapshot 与 getIndex 的真实底数）
  const srcWu = path.join(REAL_DATA, 'workunits');
  const outWu = path.join(outRoot, 'workunits');
  fs.mkdirSync(outWu, { recursive: true });
  for (const f of ['index.json', 'events.jsonl']) {
    const p = path.join(srcWu, f);
    if (fs.existsSync(p)) fs.copyFileSync(p, path.join(outWu, f));
  }
  const outBig = path.join(outChannels, largestCid, 'messages.jsonl');
  return {
    channelIds: cids,
    largestCid,
    largestLines: readLines(outBig).length,
    largestBytes: fs.statSync(outBig).size,
  };
}

/** 候选替代：尾部倒扫，凑满 need 条去重后的人类消息即停；返回扫描行数供成本对照 */
export async function tailScanHuman(filePath: string, need = 20): Promise<{ count: number; scanned: number }> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const seen = new Set<string>();
    let found = 0;
    let scanned = 0;
    for await (const { text } of iterateJsonlLinesBackward(handle, stat.size)) {
      scanned++;
      let row: Row;
      try { row = JSON.parse(text) as Row; } catch { continue; }
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      if (row.authorType !== 'human') continue;
      found++;
      if (found >= need) break;
    }
    return { count: found, scanned };
  } finally {
    await handle.close();
  }
}

/** 候选替代 v2：倒扫遇第一条（去重后）human+workUnitId 即停——合并目标语义本身只要这一条 */
export async function tailScanFirstHumanWu(filePath: string): Promise<{ found: boolean; scanned: number }> {
  const handle = await fsp.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const seen = new Set<string>();
    let scanned = 0;
    for await (const { text } of iterateJsonlLinesBackward(handle, stat.size)) {
      scanned++;
      let row: Row;
      try { row = JSON.parse(text) as Row; } catch { continue; }
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      if (row.authorType === 'human' && row.workUnitId) return { found: true, scanned };
    }
    return { found: false, scanned };
  } finally {
    await handle.close();
  }
}

export function stats(samples: number[]): { min: number; median: number; p95: number; mean: number } {
  const s = [...samples].sort((a, b) => a - b);
  const pick = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { min: s[0], median: pick(0.5), p95: pick(0.95), mean: s.reduce((a, b) => a + b, 0) / s.length };
}

type Samples = Record<string, number[]>;

async function time(samples: Samples, key: string, fn: () => Promise<unknown>): Promise<void> {
  const t0 = performance.now();
  await fn();
  const dt = performance.now() - t0;
  (samples[key] ??= []).push(dt);
}

async function main(): Promise<void> {
  const benchRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'route-dispatch-bench-'));
  console.log(`[bench] root: ${benchRoot}`);
  console.log(`[bench] source (read-only): ${REAL_DATA}`);
  console.log(`[bench] rounds=${ROUNDS} scales=${SCALES.join(',')}`);

  const report: Record<string, unknown> = { benchRoot, rounds: ROUNDS, scales: {} };

  for (const scale of SCALES) {
    const label = `${scale}x`;
    const root = path.join(benchRoot, label);
    const info = synthesize(root, scale);
    const store = new FileStore(root);
    const bigFile = path.join(root, 'channels', info.largestCid, 'messages.jsonl');
    // getMessageById 目标：取最小频道（非最大频道）的首条消息 id —— 模拟 replyTo 父消息在普通频道
    const smallCid = info.channelIds.find(c => c !== info.largestCid)!;
    const smallFirst = JSON.parse(readLines(path.join(root, 'channels', smallCid, 'messages.jsonl'))[0]) as Row;
    // #524 P1-2：index.json 改 append-only JSONL（旧格式兼容），统一走 fold 读口
    const wuIndex = parseWorkUnitIndexContent(fs.readFileSync(path.join(root, 'workunits', 'index.json'), 'utf-8')) as Row[];
    const wuTemplate = wuIndex[0];

    const samples: Samples = {};
    let tailScanned = 0;
    let tailScanned2 = 0;

    for (let r = 0; r < ROUNDS; r++) {
      const msg: Row = {
        id: randomUUID(),
        channelId: info.largestCid,
        authorType: 'human',
        agentName: null,
        content: `bench ping ${r}`,
        replyToId: null,
        meta: '{}',
        workUnitId: null,
        createdAt: new Date().toISOString(),
      };
      // A: 消息写（B/E 的失效前置：ONLY 不含 A 时也要先写一发保持「写后」语义）
      if (enabled('A')) await time(samples, 'A.appendMessage', () => store.appendMessage(info.largestCid, msg as never));
      else if (enabled('B') || enabled('E')) await store.appendMessage(info.largestCid, msg as never);
      // B: #524 P1-1 后合并窗口查询 = readMessagesTail 倒扫（写后 = 生产逐消息一致）
      if (enabled('B')) await time(samples, 'B.readMessagesTail.human20', () =>
        store.readMessagesTail(info.largestCid, { limit: 20, match: m => (m as Row).authorType === 'human' }));
      // B0: 对照——#524 前旧路径（写后 = 稳态缓存失效全热读）
      if (enabled('B')) await time(samples, 'B0.queryMessages.afterWrite', () =>
        store.queryMessages(info.largestCid, { authorType: 'human', limit: 20 }));
      // C: 对照暖命中
      if (enabled('C')) await time(samples, 'C.queryMessages.warmHit', () =>
        store.queryMessages(info.largestCid, { authorType: 'human', limit: 20 }));
      // D: 尾部倒扫候选（凑满 20 条 human 即停，与现 limit:20 同口径）
      if (enabled('D')) await time(samples, 'D.tailScan20Human', async () => {
        const res = await tailScanHuman(bigFile, 20);
        tailScanned = res.scanned;
      });
      // D2: 尾部倒扫 v2（首条 human+workUnitId 即停）
      if (enabled('D')) await time(samples, 'D2.tailScanFirstHumanWu', async () => {
        const res = await tailScanFirstHumanWu(bigFile);
        tailScanned2 = res.scanned;
      });
      // E: #524 P1-1 后父消息查找 = 本频道直查（写后）
      if (enabled('E')) await time(samples, 'E.getMessageById.inChannel', () => store.getMessageById(smallFirst.id, smallCid));
      // E0: 对照——#524 前全频道扇出（被写频道 miss + 其余 hit）
      if (enabled('E')) await time(samples, 'E0.getMessageById.fanout', () => store.getMessageById(smallFirst.id));
      // F: 对照暖命中
      if (enabled('F')) await time(samples, 'F.getMessageById.inChannel.warm', () => store.getMessageById(smallFirst.id, smallCid));
      // G: WU 点读
      if (enabled('G')) await time(samples, 'G.getIndex.pointRead', () => store.getIndex({ id: String(wuTemplate.id) }));
      // H: 建 WU 持久化（锁内 appendEvent + 索引全量重写）
      if (enabled('H')) {
        const wu = { ...wuTemplate, id: randomUUID(), updatedAt: new Date().toISOString() };
        await time(samples, 'H.commitSnapshot', () =>
          store.commitSnapshot(
            { type: 'created', wuId: String(wu.id), timestamp: new Date().toISOString(), data: wu as Record<string, unknown> },
            wu as never,
          ));
      }
    }

    const table: Record<string, unknown> = {
      largestChannel: info.largestCid,
      largestLines: info.largestLines,
      largestKB: Math.round(info.largestBytes / 1024),
      channelCount: info.channelIds.length,
      wuIndexEntries: wuIndex.length,
      tailScanRowsScanned: tailScanned,
      tailScan2RowsScanned: tailScanned2,
      measurements: Object.fromEntries(
        Object.entries(samples).map(([k, v]) => [k, Object.fromEntries(
          Object.entries(stats(v)).map(([sk, sv]) => [sk, Number(sv.toFixed(3))]),
        )]),
      ),
    };
    (report.scales as Record<string, unknown>)[label] = table;
    console.log(`\n[bench] === ${label} (largest ${info.largestLines} lines / ${Math.round(info.largestBytes / 1024)}KB, ${info.channelIds.length} channels, ${wuIndex.length} WUs) ===`);
    for (const [k, v] of Object.entries(table.measurements as Record<string, Record<string, number>>)) {
      console.log(`  ${k.padEnd(28)} min=${v.min}ms median=${v.median}ms p95=${v.p95}ms mean=${v.mean}ms`);
    }
    console.log(`  tailScan rows scanned (last round): D=${tailScanned} D2=${tailScanned2}`);
  }

  // ── #524 P1-2 验收：commitSnapshot 写侧耗时随 WU 数扫档（不应线性增长）──
  if (WUSCALES.length > 0) {
    const srcWu = path.join(REAL_DATA, 'workunits');
    const template = (parseWorkUnitIndexContent(
      fs.readFileSync(path.join(srcWu, 'index.json'), 'utf-8')) as Row[])[0];
    const wuReport: Record<string, unknown> = {};
    for (const wuScale of WUSCALES) {
      const root = path.join(benchRoot, `wu-${wuScale}x`);
      const wuDir = path.join(root, 'workunits');
      fs.mkdirSync(wuDir, { recursive: true });
      // 合成 index.json（新 JSONL 格式）：49×wuScale 条，id 唯一
      const base = parseWorkUnitIndexContent(fs.readFileSync(path.join(srcWu, 'index.json'), 'utf-8')) as Row[];
      const lines: string[] = [];
      for (let k = 0; k < wuScale; k++) {
        for (const wu of base) lines.push(JSON.stringify({ ...wu, id: `${wu.id}__w${k}` }));
      }
      fs.writeFileSync(path.join(wuDir, 'index.json'), lines.join('\n') + '\n');
      if (fs.existsSync(path.join(srcWu, 'events.jsonl'))) {
        fs.copyFileSync(path.join(srcWu, 'events.jsonl'), path.join(wuDir, 'events.jsonl'));
      }
      const store = new FileStore(root);
      const samples: Samples = {};
      for (let r = 0; r < ROUNDS; r++) {
        const wu = { ...template, id: randomUUID(), updatedAt: new Date().toISOString() };
        await time(samples, 'H.commitSnapshot', () =>
          store.commitSnapshot(
            { type: 'created', wuId: String(wu.id), timestamp: new Date().toISOString(), data: wu as Record<string, unknown> },
            wu as never,
          ));
      }
      const m = Object.fromEntries(Object.entries(stats(samples['H.commitSnapshot'])).map(([k, v]) => [k, Number(v.toFixed(3))]));
      wuReport[`${wuScale}x`] = { wuIndexEntries: base.length * wuScale, 'H.commitSnapshot': m };
      console.log(`\n[bench] === wu ${wuScale}x (${base.length * wuScale} WUs) === H.commitSnapshot min=${m.min}ms median=${m.median}ms p95=${m.p95}ms mean=${m.mean}ms`);
    }
    report.wuScales = wuReport;
  }

  const outPath = path.join(benchRoot, 'route-dispatch-bench-results.json');
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`\n[bench] results: ${outPath}`);
  console.log(`[bench] done. bench root kept at ${benchRoot}`);
}

// 仅作为脚本直跑时执行（vitest import 不触发）
if (require.main === module) {
  main().catch(err => {
    console.error('[bench] failed:', err);
    process.exit(1);
  });
}
