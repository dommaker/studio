/**
 * #469：PMO 项目里程碑出声统一出口（completed/in_review 翻转 + 交付播报）。
 *
 * 两个面（对齐 wu-messenger 的 milestone 形态）：
 *   - 频道面：项目已 publish（channelId 非空）→ ChannelMessageService.createAgentMessage
 *     发 'Studio' 系统消息，meta 带 pmoId（NotificationBell 跳 PMO 详情）+ atHuman（响铃）；
 *   - 持久面：NotificationService.createForAllUsers 落通知（type 'system'，
 *     link `/pmo/project/:id` 直链）——SSE 只做实时增量，刷新/断线重连以通知为准。
 *
 * 全程 best-effort：任一面失败仅 warn，绝不阻断状态翻转/交付落档主路径。
 */
import { FileStore, logger } from '@dommaker/studio-shared';
import { NotificationService } from '@dommaker/studio-notification';
import { ChannelMessageService } from '../channels/channel-message.service.js';

/** 里程碑发声所需的最小项目字段（progress-rollup 的 ProjectData / delivery 的 DeliveryStatus 均可喂入） */
export interface ProjectMilestoneRef {
  id: string;
  pmoNumber: string;
  channelId?: string | null;
}

export async function postProjectMilestone(
  project: ProjectMilestoneRef,
  msg: { title: string; content: string },
  opts?: { fileStore?: FileStore },
): Promise<void> {
  const fileStore = opts?.fileStore ?? new FileStore();

  if (project.channelId) {
    try {
      await new ChannelMessageService(fileStore).createAgentMessage(
        project.channelId,
        'Studio',
        msg.content,
        { meta: { pmoId: project.id, atHuman: true } },
      );
    } catch (err) {
      logger.warn('[PMO] milestone channel message failed (non-blocking)', { projectId: project.id, error: String(err) });
    }
  }

  try {
    await new NotificationService(fileStore).createForAllUsers({
      type: 'system',
      title: msg.title,
      content: msg.content.slice(0, 200),
      link: `/pmo/project/${project.id}`,
      channelId: project.channelId ?? undefined,
    });
  } catch (err) {
    logger.warn('[PMO] milestone notification write failed (non-blocking)', { projectId: project.id, error: String(err) });
  }
}
