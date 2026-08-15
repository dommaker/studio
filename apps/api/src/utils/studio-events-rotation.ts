/**
 * #173（#60 决策 Q3b / spec 批次 C4）：事件保留轮转。
 *
 * 口诀：信号永久留（热 30 天 → 月度 gzip 冷包不删），噪声 7 天滚。
 *
 * - 分类口径 = #172 落地的 envelope level：level=debug（knowledge:*、tool:call 默认分级）
 *   为噪声；其余（缺省 info / warning / critical）为信号。显式 level 字段优先于 type 默认分级。
 * - 噪声：热文件内超过 7 天（NOISE_RETENTION_DAYS）即滚动删除，不进归档。
 * - 信号：热文件保留 30 天（SIGNAL_HOT_DAYS，趋势探测/复盘直读纯文本），超期按事件月份
 *   切 `archive/studio-events-YYYY-MM.jsonl.gz`（相对热文件目录）永久保留——冷包只增不删；
 *   磁盘紧张由 systemHealthCheck 磁盘探测告警后人工清理（#60 决议）。
 *
 * 并发安全：先 rename 热文件 → 暂存（新写入由 appendJsonl 在新热文件重建，轮转窗口不丢行），
 * 再把幸存者 append 回热文件（与并发追加安全交错），超期信号进 gz，最后删暂存。
 * 损坏行与无时间事件无法分类计龄 → 保守保留在热文件（宁可留，不静默丢数据）。
 *
 * 调度：apps/api/src/index.ts 启动后跑一次 + 每 24h（见该文件 #173 挂载点）。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { logger } from '@dommaker/studio-shared';
import {
  resolveStudioEventsFile,
  defaultStudioEventLevel,
  getStudioEventTime,
} from './studio-events.js';

/** 噪声（level=debug）热保留天数，超期滚动删除（#60：噪声 7 天滚） */
export const NOISE_RETENTION_DAYS = 7;
/** 信号热保留天数，超期切月度 gzip 冷包（#60：信号热 30 天） */
export const SIGNAL_HOT_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

export type StudioEventRetentionClass = 'signal' | 'noise';

/**
 * 信号/噪声分类（#60 决议口径）：envelope level=debug → 噪声；其余 → 信号。
 * level 字段缺省 = info（studio-events.ts 约定），type 默认分级经 defaultStudioEventLevel。
 */
export function classifyStudioEventForRetention(event: { type?: unknown; level?: unknown }): StudioEventRetentionClass {
  const level = (typeof event.level === 'string' ? event.level : undefined)
    ?? defaultStudioEventLevel(typeof event.type === 'string' ? event.type : '');
  return level === 'debug' ? 'noise' : 'signal';
}

export interface RotateStudioEventsOptions {
  /** 热文件路径（默认 resolveStudioEventsFile()；测试按文件隔离） */
  file?: string;
  /** 冷包目录（默认 <热文件目录>/archive） */
  archiveDir?: string;
  /** 判定基准时间（默认 now；测试注入固定时间） */
  now?: Date;
}

export interface StudioEventsRotationResult {
  /** 是否有热文件参与本轮轮转 */
  rotated: boolean;
  /** 回写热文件的幸存行数 */
  keptHot: number;
  /** 滚动删除的噪声行数 */
  noiseDropped: number;
  /** 归档进月度 gz 的信号行数 */
  signalArchived: number;
  /** 本轮触碰的 gz 冷包文件 */
  archiveFiles: string[];
}

/**
 * 跑一轮事件保留轮转。热文件不存在 → no-op。永不抛出到调度层以外的语义：
 * 单轮失败由调用方 catch + logger.warn（index.ts 挂载点已包）。
 */
export async function rotateStudioEvents(opts?: RotateStudioEventsOptions): Promise<StudioEventsRotationResult> {
  const file = opts?.file ?? resolveStudioEventsFile();
  const archiveDir = opts?.archiveDir ?? path.join(path.dirname(file), 'archive');
  const now = opts?.now ?? new Date();
  const result: StudioEventsRotationResult = {
    rotated: false,
    keptHot: 0,
    noiseDropped: 0,
    signalArchived: 0,
    archiveFiles: [],
  };
  if (!fs.existsSync(file)) return result;

  // 1. rename 热文件 → 暂存：rename 原子，此后新写入在新热文件重建，轮转窗口不丢行
  const rotating = `${file}.rotating-${process.pid}-${randomUUID()}`;
  await fs.promises.rename(file, rotating);
  result.rotated = true;

  try {
    const lines = (await fs.promises.readFile(rotating, 'utf-8'))
      .split('\n')
      .filter(l => l.trim().length > 0);

    const noiseCutoff = now.getTime() - NOISE_RETENTION_DAYS * DAY_MS;
    const signalCutoff = now.getTime() - SIGNAL_HOT_DAYS * DAY_MS;
    const kept: string[] = [];
    const archivedByMonth = new Map<string, string[]>();

    for (const line of lines) {
      let event: Record<string, unknown> | null = null;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        event = null;
      }
      // 损坏行 / 无时间：无法分类计龄 → 保守保留
      const t = event ? getStudioEventTime(event) : NaN;
      if (!event || !Number.isFinite(t)) {
        kept.push(line);
        continue;
      }
      if (classifyStudioEventForRetention(event) === 'noise') {
        if (t < noiseCutoff) {
          result.noiseDropped++;
          continue;
        }
        kept.push(line);
      } else if (t < signalCutoff) {
        const month = new Date(t).toISOString().slice(0, 7); // UTC YYYY-MM
        const bucket = archivedByMonth.get(month);
        if (bucket) bucket.push(line);
        else archivedByMonth.set(month, [line]);
        result.signalArchived++;
      } else {
        kept.push(line);
      }
    }

    // 2. 幸存者 append 回热文件（保留原始行文本不重序列化；与并发追加安全交错）
    if (kept.length > 0) {
      await fs.promises.appendFile(file, kept.join('\n') + '\n', 'utf-8');
    }
    result.keptHot = kept.length;

    // 3. 超期信号 → 月度 gzip 冷包（永久保留）：已有 gz 解压追加再压回，tmp+rename 原子写
    if (archivedByMonth.size > 0) {
      await fs.promises.mkdir(archiveDir, { recursive: true });
      for (const month of [...archivedByMonth.keys()].sort()) {
        const gzFile = path.join(archiveDir, `studio-events-${month}.jsonl.gz`);
        let existing = '';
        if (fs.existsSync(gzFile)) {
          existing = zlib.gunzipSync(await fs.promises.readFile(gzFile)).toString('utf-8');
          if (existing && !existing.endsWith('\n')) existing += '\n';
        }
        const content = existing + archivedByMonth.get(month)!.join('\n') + '\n';
        const tmp = `${gzFile}.tmp-${process.pid}-${randomUUID()}`;
        try {
          await fs.promises.writeFile(tmp, zlib.gzipSync(content));
          await fs.promises.rename(tmp, gzFile);
        } catch (err) {
          await fs.promises.unlink(tmp).catch(() => {});
          throw err;
        }
        result.archiveFiles.push(gzFile);
      }
    }
  } finally {
    await fs.promises.unlink(rotating).catch(() => {});
  }

  logger.info('[StudioEvents] Retention rotation done (#173)', { file, ...result });
  return result;
}
