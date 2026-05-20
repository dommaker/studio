/**
 * 会议公开操作路由
 *
 * 用于外部渠道（Discord Link 按钮）确认/拒绝高风险会议
 * 不需要认证（公开端点）
 */
import {
  Router, Request, Response,
  prisma, logger,
  publishMeetingEvent,
} from './meeting-shared.js';

const router = Router();

/**
 * 继续执行会议流程（确认后）
 */
async function proceedWithBranchCreation(meetingId: string): Promise<void> {
  logger.info('Proceeding with branch creation', { meetingId });

  await prisma.meeting.update({
    where: { id: meetingId },
    data: { discussionStatus: 'confirmed', status: 'completed' },
  });

  await publishMeetingEvent('meeting.confirmed', meetingId, {
    confirmedBy: 'discord_link_button',
    timestamp: new Date().toISOString(),
  });

  logger.info('Meeting confirmed, event published', { meetingId });
}

/**
 * GET /api/v1/meetings/:id/confirm
 * 确认执行高风险会议
 */
router.get('/:id/confirm', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  logger.info('[MeetingAction] Confirm button clicked', { meetingId: id });

  try {
    const meeting = await prisma.meeting.findUnique({
      where: { id },
      select: { id: true, title: true, status: true, discussionStatus: true },
    });

    if (!meeting) {
      res.send(`
        <html>
          <head><title>会议不存在</title></head>
          <body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1 style="color: orange;">⚠️ 会议不存在</h1>
            <p>ID: ${id.slice(0, 8)}</p>
          </body>
        </html>
      `);
      return;
    }

    if (meeting.discussionStatus === 'confirmed') {
      res.send(`
        <html>
          <head><title>已确认</title></head>
          <body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1 style="color: green;">✅ 会议已确认</h1>
            <p>会议：${meeting.title}</p>
            <p style="color: gray;">（之前已确认）</p>
          </body>
        </html>
      `);
      return;
    }

    await proceedWithBranchCreation(id);

    res.send(`
      <html>
        <head><title>已确认</title></head>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1 style="color: green;">✅ 会议已确认执行</h1>
          <p>会议：${meeting.title}</p>
          <p>正在创建分支并执行任务...</p>
        </body>
      </html>
    `);
  } catch (error) {
    logger.error('[MeetingAction] Confirm handler error', { error: String(error) });
    res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1 style="color: red;">❌ 处理失败</h1>
          <p>${String(error)}</p>
        </body>
      </html>
    `);
  }
});

/**
 * GET /api/v1/meetings/:id/reject
 * 拒绝执行高风险会议
 */
router.get('/:id/reject', async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  logger.info('[MeetingAction] Reject button clicked', { meetingId: id });

  try {
    const meeting = await prisma.meeting.findUnique({
      where: { id },
      select: { id: true, title: true, status: true, discussionStatus: true },
    });

    if (!meeting) {
      res.send(`
        <html>
          <head><title>会议不存在</title></head>
          <body style="font-family: sans-serif; text-align: center; padding: 50px;">
            <h1 style="color: orange;">⚠️ 会议不存在</h1>
            <p>ID: ${id.slice(0, 8)}</p>
          </body>
        </html>
      `);
      return;
    }

    await prisma.meeting.update({
      where: { id },
      data: { discussionStatus: 'rejected', status: 'completed' },
    });

    await publishMeetingEvent('meeting.rejected', id, {
      rejectedBy: 'discord_link_button',
      timestamp: new Date().toISOString(),
    });

    res.send(`
      <html>
        <head><title>已拒绝</title></head>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1 style="color: red;">❌ 会议已拒绝执行</h1>
          <p>会议：${meeting.title}</p>
        </body>
      </html>
    `);
  } catch (error) {
    logger.error('[MeetingAction] Reject handler error', { error: String(error) });
    res.send(`
      <html>
        <body style="font-family: sans-serif; text-align: center; padding: 50px;">
          <h1 style="color: red;">❌ 处理失败</h1>
          <p>${String(error)}</p>
        </body>
      </html>
    `);
  }
});

export { router as meetingActionRoutes };