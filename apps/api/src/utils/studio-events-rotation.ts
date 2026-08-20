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
import {
  resolveStudioEventsFile,
  defaultStudioEventLevel,
} from './studio-events.js';
import { rotateJsonlLog } from './studio-log-rotation.js';

/** 噪声（level=debug）热保留天数，超期滚动删除（#60：噪声 7 天滚） */
export const NOISE_RETENTION_DAYS = 7;
/** 信号热保留天数，超期切月度 gzip 冷包（#60：信号热 30 天） */
export const SIGNAL_HOT_DAYS = 30;

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
 *
 * 实现：#213 起委托 rotateJsonlLog（./studio-log-rotation.ts）——同构机制
 * 泛化为配置驱动，本函数仅保留 #173 的策略配置与对外结果形态。
 */
export async function rotateStudioEvents(opts?: RotateStudioEventsOptions): Promise<StudioEventsRotationResult> {
  const r = await rotateJsonlLog({
    file: opts?.file ?? resolveStudioEventsFile(),
    archiveDir: opts?.archiveDir,
    now: opts?.now,
    policies: {
      signal: { hotDays: SIGNAL_HOT_DAYS, action: 'archive' },
      noise: { hotDays: NOISE_RETENTION_DAYS, action: 'drop' },
    },
    classify: classifyStudioEventForRetention,
    tag: '(#173)',
  });
  return {
    rotated: r.rotated,
    keptHot: r.keptHot,
    noiseDropped: r.dropped,
    signalArchived: r.archived,
    archiveFiles: r.archiveFiles,
  };
}
