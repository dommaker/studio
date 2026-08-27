/**
 * 冒烟 — SystemExecutor 写通路验证（#370，手动运行，不属于 pnpm test:e2e）。
 *
 *   npx tsx scripts/system-tokens-smoke.ts
 *
 * 直接调用 getSystemExecutor().run() 跑一句短 prompt（读真实 ~/.studio 的 studio
 * 角色 provider 配置），验证 ~/.studio/logs/studio-events.jsonl 真实落一条
 * system:tokens 事件（provider / inputTokens / outputTokens / durationMs /
 * promptSignature 字段齐全）。
 *
 * 判定逻辑抽为 findSmokeEvent 纯函数（__tests__/system-tokens-smoke.test.ts 单测）：
 * 只认同时含 "system:tokens" 与 "smoke-370" 双标记且 createdAt 晚于冒烟开始的行，
 * 防止生产 api 并发追加错位或历史残留事件造成假 PASS。
 *
 * 退出码：0 = 冒烟通过；1 = 触发失败或事件未落盘。eventSource 固定 'smoke-370'
 * 以便事后在事件文件中识别本脚本的产出。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveStudioLogFile } from '../apps/api/src/utils/studio-log-path.js';
import { getSystemExecutor, resetSystemExecutor } from '../apps/api/src/modules/agents/system-executor.js';

export const SMOKE_EVENT_SOURCE = 'smoke-370';
/** 冒烟事件 payload 必须齐全的字段（与 system:tokens 事件契约一致） */
const REQUIRED_PAYLOAD_FIELDS = ['provider', 'inputTokens', 'outputTokens', 'durationMs', 'promptSignature'];

/** 时间窗余量（ms）：createdAt 与 Date.now() 同主机时钟，留少量误差容忍 */
const TIME_WINDOW_SLACK_MS = 5_000;

export type SmokeEventFindResult =
  | { ok: true; line: string }
  | { ok: false; reason: string };

/**
 * 从冒烟前后的 events 文件行集合中找出本次冒烟落盘的 system:tokens 事件。
 * 同时满足：双标记（system:tokens + smoke-370）且 createdAt 晚于 startedAtMs -
 * TIME_WINDOW_SLACK_MS。双标记防把他源的 system:tokens 行认领为本冒烟产出；
 * 时间窗防历史残留 smoke 事件造成假 PASS。
 */
export function findSmokeEvent(
  beforeLines: string[],
  afterLines: string[],
  startedAtMs: number,
): SmokeEventFindResult {
  const candidateSet = new Set(afterLines);
  for (const line of beforeLines) candidateSet.delete(line);

  const earliestMs = startedAtMs - TIME_WINDOW_SLACK_MS;
  let sawSmokeMarker = false;
  for (const line of candidateSet) {
    if (!line.includes(`"${SMOKE_EVENT_SOURCE}"`)) continue;
    sawSmokeMarker = true;
    if (!line.includes('"system:tokens"')) continue;

    try {
      const evt = JSON.parse(line) as { type?: unknown; source?: unknown; payload?: unknown; createdAt?: unknown };
      if (evt.type !== 'system:tokens' || evt.source !== SMOKE_EVENT_SOURCE) continue;
      const createdAt = typeof evt.createdAt === 'string' ? Date.parse(evt.createdAt) : NaN;
      if (!(createdAt >= earliestMs)) continue;
      const payload = typeof evt.payload === 'string' ? JSON.parse(evt.payload) as Record<string, unknown> : null;
      if (!payload || REQUIRED_PAYLOAD_FIELDS.some(k => !(k in payload))) {
        return { ok: false, reason: `payload missing fields ${REQUIRED_PAYLOAD_FIELDS.join('/')}: ${line}` };
      }
      return { ok: true, line };
    } catch {
      return { ok: false, reason: `unparseable event line: ${line}` };
    }
  }
  return sawSmokeMarker
    ? { ok: false, reason: `smoke-370 events found but none within time window (>= ${new Date(earliestMs).toISOString()})` }
    : { ok: false, reason: 'no smoke-370 system:tokens event appended' };
}

function readEvents(eventsFile: string): string[] {
  return fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf-8').split('\n').filter(Boolean) : [];
}

async function main(): Promise<void> {
  const eventsFile = resolveStudioLogFile('studio-events.jsonl');
  const before = readEvents(eventsFile);
  console.log(`[smoke-370] events file: ${eventsFile} (current lines: ${before.length})`);

  const startedAtMs = Date.now();
  const result = await getSystemExecutor().run(`冒烟测试（#370）：请只回复一个词 OK，不要做任何其他事情。`, {
    eventSource: SMOKE_EVENT_SOURCE,
  });
  console.log(`[smoke-370] run() done: durationMs=${result.durationMs} usage=${JSON.stringify(result.usage ?? null)}`);

  const found = findSmokeEvent(before, readEvents(eventsFile), startedAtMs);
  if (!found.ok) {
    console.error(`[smoke-370] FAIL: ${found.reason}`);
    process.exitCode = 1;
    return;
  }
  console.log('[smoke-370] PASS:', found.line);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  resetSystemExecutor();
  main().catch(err => {
    console.error('[smoke-370] FAIL:', err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
