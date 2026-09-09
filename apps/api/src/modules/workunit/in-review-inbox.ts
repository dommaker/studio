/**
 * #464：无频道 in_review 统一进 Web「需要处理」收件箱。
 *
 * analysis 类型有专门路径（analysis-handoff 决议 2，trigger 巡检单免确认直转 +
 * 其余投收件箱）；其余类型无频道卡 in_review 此前零痕迹
 * （仓内 cleanup-stuck-in-review-no-channel 脚本说明是已知积压源）。
 *
 * 机制：订阅 workunit.status_changed，命中 in_review ∧ 无频道 ∧ 非 analysis
 * 即 dispatchMonitorAlerts（warning 级既有管线：monitor:alert 事件 + notifyAlert
 * 频道/企业微信/行动中心通知三 sink；relatedTaskIds 带 wuId → 通知带
 * /workunits/:id 直链，#468 统一口径）。每次迁入只发一条（status_changed 单次发射），
 * 滞留超阈值的后续提醒仍归 review_stagnation 探针（#181），互不重复。
 */
import { eventBus } from '@dommaker/studio-shared';
import { dispatchMonitorAlerts } from '../agents/monitor/monitor-alerts.js';
import type { WorkUnitData } from './workunit-crud.js';

/** analysis 走 analysis-handoff 既有收件箱路径，本订阅不重复出声 */
const HANDLED_ELSEWHERE = new Set(['analysis']);

let initialized = false;

/** 订阅 status_changed（幂等，照 initLockEventsBridge 先例） */
export function initInReviewInbox(): void {
  if (initialized) return;
  initialized = true;

  eventBus.subscribe('workunit.status_changed', (payload: { workunit: WorkUnitData }) => {
    const wu = payload?.workunit;
    if (!wu || wu.status !== 'in_review') return;
    if (wu.channelId || HANDLED_ELSEWHERE.has(wu.type)) return;

    dispatchMonitorAlerts([{
      source: 'review_stagnation',
      level: 'warning',
      subject: wu.id,
      relatedTaskIds: [wu.id],
      message: `工单待人工评审：「${wu.scope.slice(0, 60)}」（WU ${wu.id.slice(0, 8)}，`
        + `${wu.type}，无频道可投递）——请在 Web 工单列表/详情点「通过」；结论有问题点「拒绝」返工`,
    }]);
  });
}
