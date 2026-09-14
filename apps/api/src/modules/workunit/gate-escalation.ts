/**
 * #523 P0-3 人闸催办与认领滞留（#516 决议③④，2026-09-12 定案）。
 *
 * 复用 waiting-input 超时提醒同款机制（SCHEDULE 扫描超龄单，一次性标记）：
 * - 人闸催办：status=in_review 且 type ∈ MANUAL_GATE_TYPES（与行动中心 review 项同口径），
 *   计时锚 = updatedAt（in_review 态无簿记写入，锚定转入时刻——dispatch-reconciliation 同款口径）。
 * - 认领滞留：status=unassigned，计时锚 = updatedAt（回池释放推进 updatedAt，
 *   最接近「进入 unassigned」时刻；正常认领秒级，15min 没人接即真没人）。
 *
 * 外推通道三层按序（每层一次性标记，tier 标记互相独立——tier2 到点即发，
 * 不要求 tier1 前置状态，补发 tier1 也不重复 tier2）：
 *   tier1（in_review 30min / unassigned 15min）→ Web 铃铛（NotificationService 持久通知，
 *     全用户，带 wuId 直链）+ SSE `notification.created` 信封（前端铃铛即时失效 +
 *     触发浏览器原生通知，channel-message.service publishSSE 同款直发 eventBus）；
 *   tier2（两者均 4h）→ notifyAlert('warning')（notifier.ts 既有通路：企微 webhook
 *     未配置自动跳过 + 告警频道 + 行动中心通知）。
 * 行动中心常驻兜底（#468 stateItems）不被动；不自动确认、不改状态机，人闸语义不动。
 *
 * 注意：标记写走 updateMetadata(touchUpdatedAt:false)——催办标记是簿记不是状态迁移，
 * 推进 updatedAt 会重置计时锚让 tier2 永远迟到（#221 认领陈旧守卫同款纪律）。
 */
import { logger, eventBus, FileStore } from '@dommaker/studio-shared';
import { v4 as uuidv4 } from 'uuid';
import { NotificationService } from '@dommaker/studio-notification';
import { WorkUnitService, type WorkUnitData } from './workunit.service.js';
import { MANUAL_GATE_TYPES } from './workunit.types.js';
import { parseWuMetadata } from './wu-metadata.js';
import { notifyAlert } from '../../utils/notifier.js';

/** tier1 人闸催办阈值：in_review 超 30 分钟 → Web 铃铛提醒 */
const GATE_REMINDER_THRESHOLD_MS = 30 * 60_000;

/** tier1 认领滞留阈值：unassigned 超 15 分钟 → Web 铃铛提醒 */
const UNASSIGNED_REMINDER_THRESHOLD_MS = 15 * 60_000;

/** tier2 升级阈值（两类共用）：超 4 小时 → notifyAlert 外推 */
const GATE_ESCALATION_THRESHOLD_MS = 4 * 3_600_000;

export interface GateEscalationScanResult {
  /** 本次 tier1（Web 铃铛 + SSE）发送数 */
  tier1: number;
  /** 本次 tier2（notifyAlert 告警通路）发送数 */
  tier2: number;
}

/** 滞留类别文案参数（人闸待确认 / 认领滞留，阈值与动作指引不同） */
interface StagnationKind {
  /** tier1 标题谓语：「待确认超过」/「无人认领超过」 */
  tier1Verb: string;
  /** tier1 正文动作指引 */
  tier1Hint: string;
}

const GATE_KIND: StagnationKind = {
  tier1Verb: '待确认超过',
  tier1Hint: '人闸待你确认，系统不会自动确认——请在行动中心或任务详情页处理。',
};

const UNASSIGNED_KIND: StagnationKind = {
  tier1Verb: '无人认领超过',
  tier1Hint: '派发后一直无人认领，请在任务详情页手动指派或调整派发。',
};

/**
 * SCHEDULE trigger（workunit-gate-escalation）的 handler：扫描超龄人闸/滞留单并分层催办。
 * @returns 本次各层发送数
 */
export async function scanGateEscalationReminders(
  fs?: FileStore,
  now: Date = new Date(),
): Promise<GateEscalationScanResult> {
  const fileStore = fs ?? new FileStore();
  const wuService = new WorkUnitService(fileStore);
  const gateTier1Ms = GATE_REMINDER_THRESHOLD_MS;
  const unassignedTier1Ms = UNASSIGNED_REMINDER_THRESHOLD_MS;
  const tier2Ms = GATE_ESCALATION_THRESHOLD_MS;
  const result: GateEscalationScanResult = { tier1: 0, tier2: 0 };

  const [inReview, unassigned] = await Promise.all([
    wuService.list({ status: 'in_review', limit: 1000 }),
    wuService.list({ status: 'unassigned', limit: 1000 }),
  ]);

  for (const wu of inReview.data) {
    // 与行动中心 review 项同口径：in_review ∩ MANUAL_GATE_TYPES（人工 L3 验收类）
    if (!MANUAL_GATE_TYPES.has(wu.type)) continue;
    await escalateOne(wu, GATE_KIND, gateTier1Ms, tier2Ms, fileStore, now, result);
  }
  for (const wu of unassigned.data) {
    await escalateOne(wu, UNASSIGNED_KIND, unassignedTier1Ms, tier2Ms, fileStore, now, result);
  }

  if (result.tier1 + result.tier2 > 0) {
    logger.info('[GateEscalation] Reminders sent', result);
  }
  return result;
}

/** 单 WU 分层判定：tier2 先到点先升（标记独立），tier1 后判可同扫补发 */
async function escalateOne(
  wu: WorkUnitData,
  kind: StagnationKind,
  tier1Ms: number,
  tier2Ms: number,
  fileStore: FileStore,
  now: Date,
  result: GateEscalationScanResult,
): Promise<void> {
  const metadata = parseWuMetadata(wu.metadata);
  const since = new Date(wu.updatedAt);
  if (!Number.isFinite(since.getTime())) return;
  const ageMs = now.getTime() - since.getTime();

  const title = (metadata.title ?? wu.scope).slice(0, 50);

  // tier2：超 4h → notifyAlert 既有通路（企微 webhook 未配置自动跳过 + 告警频道 + 行动中心）
  if (!metadata.gateReminderTier2At && ageMs >= tier2Ms) {
    const hours = Math.round(tier2Ms / 3_600_000);
    await notifyAlert(
      'warning',
      `任务「${title}」${kind.tier1Verb} ${hours} 小时`,
      `${kind.tier1Hint}（#523 人闸催办升级层）`,
      { wuId: wu.id },
    );
    await markTier(fileStore, wu.id, 'gateReminderTier2At', now);
    result.tier2++;
  }

  // tier1：Web 铃铛持久通知（全用户，wuId 直链）+ SSE 信封（铃铛即时失效 + 浏览器原生通知）
  if (!metadata.gateReminderTier1At && ageMs >= tier1Ms) {
    const minutes = Math.round(tier1Ms / 60_000);
    const tier1Title = `任务「${title}」${kind.tier1Verb} ${minutes} 分钟`;
    const link = `/workunits/${wu.id}`;
    await new NotificationService(fileStore).createForAllUsers({
      type: 'gate_reminder',
      title: tier1Title,
      content: kind.tier1Hint,
      wuId: wu.id,
      link,
    });
    // 铃铛 SSE 失效触发只监听 atHuman/状态流转——补发 notification.created 信封
    // （未知 event_type 落 all topic 前端可收），前端据以 load() + 弹浏览器原生通知
    eventBus.publish('events', {
      event_type: 'notification.created',
      event_id: uuidv4(),
      timestamp: now.toISOString(),
      data: { title: tier1Title, content: kind.tier1Hint, wuId: wu.id, link },
    });
    await markTier(fileStore, wu.id, 'gateReminderTier1At', now);
    result.tier1++;
  }
}

/** 一次性 tier 标记（ISO 时间戳留痕发送时刻）；不推进 updatedAt（见文件头注意） */
async function markTier(
  fileStore: FileStore,
  wuId: string,
  key: 'gateReminderTier1At' | 'gateReminderTier2At',
  now: Date,
): Promise<void> {
  await fileStore.updateMetadata(wuId, latest => ({
    ...latest,
    [key]: now.toISOString(),
  }), { touchUpdatedAt: false });
}
