/**
 * D18 事件入口统一（B5）：全系统唯一事件文件 + 唯一写入/读取入口。
 *
 * 背景（裂口）：历史上存在两条事件流 ——
 *   1. ~/.studio/logs/studio-events.jsonl（StudioEvent 流：knowledge:*、session:summary、
 *      workunit:tokens 等，{ type, source, payload(JSON string), createdAt } 形态）
 *   2. ~/.studio/events/studio.jsonl（monitor 告警、tool:call traces 等扁平形态）
 * 读方（DailyReflection、Auditor、PatternMiner …）读第 2 条，永远读不到第 1 条的会话活动。
 *
 * 本模块收敛为：一个文件（~/.studio/logs/studio-events.jsonl，测试期经
 * studio-log-path 隔离到 os.tmpdir()/studio-test-logs/）+ 一个入口（writeStudioEvent /
 * readStudioEvents）。事件形态统一为 StudioEvent：
 *   { type, source?, payload: JSON string, createdAt: ISO 8601, level?: debug|info|warning|critical }
 *
 * #172（#60 决策 Q2）：envelope 可选 level 字段（缺省 info —— 字段缺省即 info，不为
 * info 冗余落字段）。默认分级按 type：knowledge:* 与 tool:call → debug（噪声），
 * 其余 → info；调用方可经 opts.level 显式覆盖（如 workunit:failed → warning）。
 * monitor:alert 维持现有分级（payload.level），不在 envelope 重复。
 * 读取侧默认 ≥info（过滤归读取方，不在此处硬编码黑名单）。
 *
 * 写入校验：payload 为空（{} / null / undefined / 'null' / '{}' / 空串）的事件拒绝落盘
 * 并 logger.warn（调用方自查），返回 false —— 空事件不产信号只产噪音。
 */
import { FileStore, logger } from '@dommaker/studio-shared';
import { resolveStudioLogFile } from './studio-log-path.js';

const fileStore = new FileStore();

/**
 * 统一事件文件路径（~/.studio/logs/studio-events.jsonl；测试期走隔离目录）。
 * 可用 STUDIO_EVENTS_FILE 整体覆盖（测试按文件隔离 / ops 应急切换）；
 * 生产不设置该 env 时行为与 studio-log-path 约定一致。
 */
export function resolveStudioEventsFile(): string {
  return process.env.STUDIO_EVENTS_FILE || resolveStudioLogFile('studio-events.jsonl');
}
/** payload 判空：{} / null / undefined / 空串 / '{}' / 'null' / 空数组 均视为空 */
export function isEmptyEventPayload(payload: unknown): boolean {
  if (payload === null || payload === undefined) return true;
  if (typeof payload === 'string') {
    const trimmed = payload.trim();
    if (!trimmed) return true;
    try {
      return isEmptyEventPayload(JSON.parse(trimmed));
    } catch {
      return false; // 非 JSON 字符串视为有数据
    }
  }
  if (Array.isArray(payload)) return payload.length === 0;
  if (typeof payload === 'object') {
    return Object.keys(payload as Record<string, unknown>).length === 0;
  }
  return false; // number / boolean 视为有数据
}

export interface WriteStudioEventOptions {
  /** 事件来源（写入 source 字段；可选） */
  source?: string;
  /** 事件时间 ISO 8601（默认 now） */
  createdAt?: string;
  /** 覆盖目标文件（测试/特殊场景；默认统一事件文件） */
  file?: string;
  /** #172: 事件分级（缺省 = defaultStudioEventLevel(type)；info 不落字段） */
  level?: StudioEventLevel;
}

/** #172（#60 决策 Q2）：事件分级。缺省 info（envelope 无 level 字段即视为 info） */
export type StudioEventLevel = 'debug' | 'info' | 'warning' | 'critical';

/**
 * 默认分级（#60 决策 Q2）：knowledge:* 与 tool:call 为噪声 → debug；其余 → info。
 * workunit:failed 等关键事件由调用方显式 opts.level='warning'；monitor:alert 维持
 * payload.level 现有分级，不经本函数提级。
 */
export function defaultStudioEventLevel(type: string): StudioEventLevel {
  if (type.startsWith('knowledge:') || type === 'tool:call') return 'debug';
  return 'info';
}

/**
 * 唯一事件写入入口。永不抛出：写盘失败仅 logger.warn 并返回 false。
 * payload 为空 → 拒绝落盘 + logger.warn（调用方自查），返回 false。
 */
export async function writeStudioEvent(
  type: string,
  payload: unknown,
  opts?: WriteStudioEventOptions,
): Promise<boolean> {
  if (!type || typeof type !== 'string') {
    logger.warn('[StudioEvent] Reject event without type', { source: opts?.source });
    return false;
  }
  if (isEmptyEventPayload(payload)) {
    logger.warn('[StudioEvent] Reject empty-payload event (调用方自查)', { type, source: opts?.source });
    return false;
  }
  try {
    const level = opts?.level ?? defaultStudioEventLevel(type);
    await fileStore.appendJsonl(opts?.file ?? resolveStudioEventsFile(), {
      type,
      ...(opts?.source ? { source: opts.source } : {}),
      // #172: level 为可选字段，缺省 info 不落字段（读取侧缺省即 info）
      ...(level !== 'info' ? { level } : {}),
      payload: typeof payload === 'string' ? payload : JSON.stringify(payload),
      createdAt: opts?.createdAt ?? new Date().toISOString(),
    });
    return true;
  } catch (e) {
    logger.warn('[StudioEvent] write failed', { type, source: opts?.source, error: String(e) });
    return false;
  }
}

/** 统一读 API：读取事件文件全部行（损坏行跳过；文件不存在 → []，不抛出） */
export async function readStudioEvents(opts?: { file?: string }): Promise<Array<Record<string, unknown>>> {
  try {
    return await fileStore.readJsonl<Record<string, unknown>>(opts?.file ?? resolveStudioEventsFile());
  } catch {
    return [];
  }
}

/**
 * 解析事件 payload（string → object；object 原样返回；损坏 → null）。
 * 供读方统一取数，替代各处重复的 try/JSON.parse。
 */
export function parseStudioEventPayload<T = Record<string, unknown>>(event: { payload?: unknown }): T | null {
  const raw = event?.payload;
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'object') return raw as T;
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * 事件时间（epoch ms）：优先 createdAt（ISO），兼容历史扁平事件的 timestamp
 * （ISO string 或 epoch number）。非法/缺失 → NaN（调用方自行过滤）。
 */
export function getStudioEventTime(event: { createdAt?: unknown; timestamp?: unknown }): number {
  const createdAt = event?.createdAt;
  if (typeof createdAt === 'string' && createdAt) {
    const ts = new Date(createdAt).getTime();
    if (Number.isFinite(ts)) return ts;
  }
  const timestamp = event?.timestamp;
  if (typeof timestamp === 'number' && Number.isFinite(timestamp)) return timestamp;
  if (typeof timestamp === 'string' && timestamp) {
    const ts = new Date(timestamp).getTime();
    if (Number.isFinite(ts)) return ts;
  }
  return NaN;
}
