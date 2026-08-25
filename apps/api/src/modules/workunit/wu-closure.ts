/**
 * #176（决策 #57 D4 + #62 §3「系统自作主张」双出声原则）：系统把 WU 推向终态（closed）
 * 的统一关闭出口。
 *
 * 双出声 = 落结构化事件（workunit:closed，带 reason/closedBy/blockedAt；schema 归 #60，
 * 本票只定「要有」）+ 频道说明（复用 #57 CTA 文案模板，经 wu-messenger 里程碑形态）。
 * 没有例外——autoAbandonStaleBlocked 与 checkTotalExecutionTime 2.5h 强杀均走这里；
 * 此原则即未来同类代码的验收标准。
 *
 * 快照写入沿用 #170 锁内成对原语（completed 事件 + 索引快照同锁，消除分叉窗口）。
 * 三步各自 best-effort：任一步失败只记日志，不阻断其余（出声尽力而为，关闭不回头）。
 */
import { logger, type FileStore, type WorkUnitSnapshot, type WorkUnitEvent } from '@dommaker/studio-shared';
import { postWuSystemMessage } from './wu-messenger.js';
import { parseWuMetadata } from './wu-metadata.js';
import { snapshotToData } from './workunit.mappers.js';
import { writeStudioEvent } from '../../utils/studio-events.js';

/** 结构化关闭事件类型（REST 回放：GET /api/v1/events?type=workunit:closed） */
export const WORKUNIT_CLOSED_EVENT_TYPE = 'workunit:closed';

/** 关闭来源：24h 死信 / 2.5h 总时长强杀 / 人类「关闭」指令 */
export type WorkUnitClosedBy = 'auto-abandon-stale-blocked' | 'total-time-kill' | 'human-command';

export interface CloseWorkUnitWithNoticeOptions {
  /** 关闭原因（事件 payload 与缺省频道文案共用） */
  reason: string;
  closedBy: WorkUnitClosedBy;
  /** 频道说明全文（缺省 = reason；死信场景传 buildDeadLetterNotice 产物） */
  message?: string;
}

/**
 * 系统侧关闭 WorkUnit：completed 事件 + closed 快照（锁内成对）→ workunit:closed
 * 结构化事件 → 频道里程碑说明。
 * @returns 快照关闭是否成功（事件/频道失败不影响返回值，只记日志）
 */
export async function closeWorkUnitWithNotice(
  fileStore: FileStore,
  snapshot: WorkUnitSnapshot,
  opts: CloseWorkUnitWithNoticeOptions,
): Promise<boolean> {
  const closedAt = new Date().toISOString();
  // #327：closedAt 归档计龄锚点与 completedAt 同刻落盘
  const closed: WorkUnitSnapshot = { ...snapshot, status: 'closed', completedAt: closedAt, closedAt, updatedAt: closedAt };

  try {
    await fileStore.commitSnapshot({
      type: 'completed',
      wuId: snapshot.id,
      timestamp: closedAt,
      data: closed as unknown as Record<string, unknown>,
    } as WorkUnitEvent, closed);
  } catch (err) {
    logger.error('[WuClosure] Failed to close workUnit snapshot', { workUnitId: snapshot.id, error: String(err) });
    return false;
  }

  await emitWorkUnitClosedEvent(snapshot, opts, closedAt);

  if (snapshot.channelId) {
    await postWuSystemMessage(snapshotToData(closed), opts.message ?? opts.reason, {
      milestone: true,
      fileStore,
    }).catch(err =>
      logger.warn('[WuClosure] Channel notice failed (non-blocking)', { workUnitId: snapshot.id, error: String(err) })
    );
  }
  return true;
}

/** workunit:closed 结构化事件（level=warning，对齐 workunit:failed 分级；fire-and-forget） */
async function emitWorkUnitClosedEvent(
  snapshot: WorkUnitSnapshot,
  opts: CloseWorkUnitWithNoticeOptions,
  closedAt: string,
): Promise<void> {
  try {
    const blockedAt = parseWuMetadata(snapshot.metadata).blockedAt;
    await writeStudioEvent(WORKUNIT_CLOSED_EVENT_TYPE, {
      workUnitId: snapshot.id,
      reason: opts.reason,
      closedBy: opts.closedBy,
      ...(typeof blockedAt === 'string' ? { blockedAt } : {}),
      closedAt,
    }, { source: 'wu-closure', level: 'warning' });
  } catch (err) {
    logger.warn('[WuClosure] Closed event emit failed (non-blocking)', { workUnitId: snapshot.id, error: String(err) });
  }
}
