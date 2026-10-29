/**
 * PERF-02：WorkUnit per-WU 当前态投影的落盘格式与代际校验。
 * events.jsonl 是唯一真源；本模块只做纯编解码，不写盘、不持锁。
 */

import { createHash } from 'node:crypto';
import type { WorkUnitSnapshot } from './file-store-types';

export interface WorkUnitLogPosition {
  dev: number;
  ino: number;
  offset: number;
}

export interface WorkUnitProjectionHead {
  version: 1;
  /** 该 WU projection 的完整提交 head；其他 WU 的后续 append 不使其失效。 */
  log: WorkUnitLogPosition;
}

export interface WorkUnitCurrentManifest extends WorkUnitProjectionHead {
  /** 已完成 events → index → 全部 current projection 提交的全局 log head。 */
  log: WorkUnitLogPosition;
  /** 当前 projection 文件数；全量枚举据此检测缺文件，不读历史 index。 */
  count: number;
}

export interface WorkUnitCurrentProjection {
  version: 1;
  /** 必须与 current/heads/<id>.json 的完整提交 head 精确一致。 */
  log: WorkUnitLogPosition;
  snapshot: WorkUnitSnapshot;
}

/** 防止 WU id 中的路径字符逃逸 current/；id 本体留在 snapshot 内。 */
export function workUnitProjectionFileName(wuId: string): string {
  return `${createHash('sha256').update(wuId).digest('hex')}.json`;
}

export function sameWorkUnitLogPosition(a: WorkUnitLogPosition, b: WorkUnitLogPosition): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.offset === b.offset;
}

export function parseWorkUnitCurrentManifest(content: string, sourcePath: string): WorkUnitCurrentManifest {
  const value = parseObject(content, sourcePath);
  if (value.version !== 1) throw new Error(`WorkUnit current manifest version unsupported: ${sourcePath}`);
  if (typeof value.count !== 'number' || !Number.isSafeInteger(value.count) || value.count < 0) {
    throw new Error(`WorkUnit current manifest count invalid: ${sourcePath}`);
  }
  return { version: 1, log: parseLogPosition(value.log, sourcePath), count: value.count };
}

export function parseWorkUnitProjectionHead(content: string, sourcePath: string): WorkUnitProjectionHead {
  const value = parseObject(content, sourcePath);
  if (value.version !== 1) throw new Error(`WorkUnit projection head version unsupported: ${sourcePath}`);
  return { version: 1, log: parseLogPosition(value.log, sourcePath) };
}

export function parseWorkUnitCurrentProjection(
  content: string,
  expectedWuId: string,
  manifest: WorkUnitProjectionHead,
  sourcePath: string,
): WorkUnitCurrentProjection {
  const value = parseObject(content, sourcePath);
  if (value.version !== 1) throw new Error(`WorkUnit current projection version unsupported: ${sourcePath}`);
  const log = parseLogPosition(value.log, sourcePath);
  if (log.dev !== manifest.log.dev || log.ino !== manifest.log.ino) {
    throw new Error(`WorkUnit current projection log generation mismatch: ${sourcePath}`);
  }
  if (!sameWorkUnitLogPosition(log, manifest.log)) {
    throw new Error(`WorkUnit current projection does not match committed head: ${sourcePath}`);
  }
  const snapshot = value.snapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
    || (snapshot as { id?: unknown }).id !== expectedWuId) {
    throw new Error(`WorkUnit current projection snapshot id mismatch (expected ${expectedWuId}): ${sourcePath}`);
  }
  return { version: 1, log, snapshot: snapshot as WorkUnitSnapshot };
}

function parseObject(content: string, sourcePath: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    throw new Error(`WorkUnit current projection corrupted: ${sourcePath}`, { cause: error });
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`WorkUnit current projection corrupted (not an object): ${sourcePath}`);
  }
  return value as Record<string, unknown>;
}

function parseLogPosition(value: unknown, sourcePath: string): WorkUnitLogPosition {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`WorkUnit current projection log position missing: ${sourcePath}`);
  }
  const position = value as Partial<WorkUnitLogPosition>;
  for (const key of ['dev', 'ino', 'offset'] as const) {
    if (typeof position[key] !== 'number' || !Number.isSafeInteger(position[key]) || position[key]! < 0) {
      throw new Error(`WorkUnit current projection log ${key} invalid: ${sourcePath}`);
    }
  }
  return position as WorkUnitLogPosition;
}
