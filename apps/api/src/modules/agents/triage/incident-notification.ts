/**
 * incident 落通知（#468 行动中心）：incident.created/escalated 处理点同步写
 * NotificationService（type=incident，全用户）——取代修复断裂的 SSE 桥
 * （incident 发裸频道、sse.routes 只订 events，TriageBanner 实际收不到）。
 * severity 进 content 首行（前端横幅 critical 突破判定据此解析）；有 wuId 时带 WU 直链。
 */
import { notificationService } from '@dommaker/studio-notification';
import { logger } from '@dommaker/studio-shared';

export interface IncidentNotificationInfo {
  incidentId: string;
  /** created 用 input.severity；escalated 缺省 critical（升级人工即横幅突破口径） */
  severity?: string;
  /** 人类可读摘要（事件类型/原因/诊断结论） */
  summary: string;
  /** 关联 WU（有则通知带 /workunits/:id 直链） */
  wuId?: string;
}

/** best-effort：写失败仅 warn，绝不阻断 triage 主流程 */
export async function persistIncidentNotification(
  kind: 'created' | 'escalated',
  info: IncidentNotificationInfo,
): Promise<void> {
  try {
    await notificationService.createForAllUsers({
      type: 'incident',
      title: kind === 'created' ? `Triage 事件 ${info.incidentId}` : `Triage 升级 ${info.incidentId}`,
      content: `severity: ${info.severity ?? 'critical'}\n${info.summary}`,
      ...(info.wuId ? { wuId: info.wuId, link: `/workunits/${info.wuId}` } : {}),
    });
  } catch (err) {
    logger.warn('[Triage] incident notification write failed (non-blocking)', { error: String(err) });
  }
}
