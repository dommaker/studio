/**
 * #342 微基准：studio-events 残余全量读 6 处收进 readStudioEventsSince 窗口读口后，
 * 复测「读成本随窗口行数而非文件总量」（与 #335 微基准同方法：合成 50x 数据集、N 轮取 P50）。
 *
 * 用法：pnpm tsx bench/read-since-windows-342.ts [--runs 10] [--scale 50]
 *
 * 口径：
 *   - 全量读 = FileStore.readJsonl（旧读方路径），每轮前 utimes 强制 mtime 失效——
     对应生产 append 高频文件 mtime 校验恒 miss 的真·全量 parse 最坏路径。
 *   - 窗口读 = readStudioEventsSince（裸 fs 倒扫、无缓存、窗口外早停），
 *     测 24h / 7d / 30d 三档（30d = 本票各读方落地的窗口）。
 *   - 事件文件 = synthesizeDataset 产物（真实 ~/.studio 模板 ×scale，-k*12h 保序偏移）。
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileStore } from '@dommaker/studio-shared';
import { readStudioEventsSince } from '../src/utils/studio-events-tail.js';
import { synthesizeDataset } from './synthesize-dataset.js';

export function parseArgs(argv: string[]): { runs: number; scale: number } {
  const get = (k: string): string | undefined => {
    const i = argv.indexOf(k);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return { runs: Number(get('--runs') ?? 10), scale: Number(get('--scale') ?? 50) };
}

export function p50(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

async function timeOf(fn: () => Promise<unknown>): Promise<number> {
  const t0 = process.hrtime.bigint();
  await fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

async function main(): Promise<void> {
  const { runs, scale } = parseArgs(process.argv.slice(2));
  const templateHome = path.join(os.homedir(), '.studio');
  const outHome = fs.mkdtempSync(path.join(os.tmpdir(), 'read-sites-342-'));
  try {
    const stats = synthesizeDataset({ templateHome, outHome, scale });
    const eventsFile = path.join(outHome, 'logs', 'studio-events.jsonl');
    const totalRows = fs.readFileSync(eventsFile, 'utf-8').split('\n').filter(l => l.trim().length > 0).length;
    const sizeMb = fs.statSync(eventsFile).size / 1024 / 1024;
    console.log(`[bench] template=${templateHome} scale=${scale}x rows=${totalRows} size=${sizeMb.toFixed(1)}MB (wus=${stats.workUnits})`);

    const fileStore = new FileStore(outHome);
    const DAY = 86_400_000;

    // 全量读：每轮 utimes 触发 mtime 失效（生产 append 高频最坏路径）。
    // 顺序测量（并发会互相争抢导致 P50 虚高）。
    const warmup = await timeOf(async () => {
      const now = new Date();
      fs.utimesSync(eventsFile, now, now);
      await fileStore.readJsonl(eventsFile);
    });
    void warmup;
    const fullSamples: number[] = [];
    for (let i = 0; i < runs; i++) {
      fullSamples.push(await timeOf(async () => {
        const now = new Date();
        fs.utimesSync(eventsFile, now, now);
        await fileStore.readJsonl(eventsFile);
      }));
    }
    const fullP50 = p50(fullSamples);

    const windows: Array<{ label: string; sinceMs: number }> = [
      { label: '24h', sinceMs: Date.now() - 1 * DAY },
      { label: '7d', sinceMs: Date.now() - 7 * DAY },
      { label: '30d', sinceMs: Date.now() - 30 * DAY },
    ];
    const windowRows: Record<string, number> = {};
    const windowP50: Record<string, number> = {};
    for (const w of windows) {
      const rows: number[] = [];
      const samples: number[] = [];
      for (let i = 0; i < runs; i++) {
        samples.push(await timeOf(async () => {
          const out = await readStudioEventsSince({ file: eventsFile, sinceMs: w.sinceMs });
          rows.push(out.length);
        }));
      }
      windowP50[w.label] = p50(samples);
      windowRows[w.label] = Math.round(rows.reduce((a, b) => a + b, 0) / rows.length);
    }

    console.log();
    console.log('| 读法 | 窗口行数 | P50 (ms) |');
    console.log('|---|---|---|');
    console.log(`| readJsonl 全量（mtime 恒 miss） | ${totalRows}（全量 parse） | ${fullP50.toFixed(1)} |`);
    for (const w of windows) {
      console.log(`| readStudioEventsSince ${w.label} | ${windowRows[w.label]} | ${windowP50[w.label].toFixed(1)} |`);
    }
  } finally {
    fs.rmSync(outHome, { recursive: true, force: true });
  }
}

// 仅直接执行时运行（vitest 导入本模块测纯函数时不触发合成与测量）
if (process.argv[1]?.includes('read-since-windows-342')) {
  main().catch((e: unknown) => {
    console.error('[bench] failed:', e);
    process.exit(1);
  });
}