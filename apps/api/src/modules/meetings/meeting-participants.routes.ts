/**
 * 会议参与者路由
 * - POST /:id/participants 添加参与者
 * - POST /:id/participants/:roleId/accept 接受邀请
 * - POST /:id/participants/:roleId/decline 拒绝邀请
 * - DELETE /:id/participants/:roleId 移除参与者
 * - POST /:id/start 开始会议
 */
import {
  Router, Request, Response,
  prisma, logger,
  publishMeetingEvent,
  sendSuccess, sendError, sendNotFound, sendBadRequest,
  requireRole,
} from './meeting-shared.js';

const router = Router();

// 邀请角色加入会议
router.post('/:id/participants', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { roleId, stance } = req.body;

    if (!roleId) return sendBadRequest(res, 'Missing required field: roleId');

    const meeting = await prisma.meeting.findUnique({
      where: { id },
      include: { MeetingParticipant: true },
    });

    if (!meeting) return sendNotFound(res, 'Meeting');

    const existing = meeting.MeetingParticipant.find(p => p.roleId === roleId);
    if (existing) return sendBadRequest(res, 'Role already in meeting');

    const role = await prisma.role.findUnique({ where: { id: roleId } });
    if (!role) return sendNotFound(res, 'Role');

    const participant = await prisma.meetingParticipant.create({
      data: {
        meetingId: id,
        roleId,
        stance: stance || 'executor',
        locked: true,
      },
      include: { Role: true },
    });

    await publishMeetingEvent('meeting.participant_joined', id, {
      roleId,
      roleName: role.name,
      stance: stance || 'executor',
    });

    sendSuccess(res, participant);
  } catch (error) {
    logger.error('Error adding participant', { error });
    sendError(res, 'Failed to add participant');
  }
});

// 接受邀请
router.post('/:id/participants/:roleId/accept', async (req: Request, res: Response) => {
  try {
    const { id, roleId } = req.params;

    const participant = await prisma.meetingParticipant.findFirst({
      where: { meetingId: id, roleId },
    });

    if (!participant) return sendNotFound(res, 'Participant');
    if (participant.inviteStatus === 'accepted') return sendBadRequest(res, 'Already accepted');
    if (participant.inviteStatus === 'declined') return sendBadRequest(res, 'Already declined');

    const updated = await prisma.meetingParticipant.update({
      where: { id: participant.id },
      data: {
        inviteStatus: 'accepted',
        respondedAt: new Date(),
        status: 'joined',
        joinedAt: new Date(),
        locked: true,
        lockedBy: id,
        lockedAt: new Date(),
      },
      include: { Role: true },
    });

    await publishMeetingEvent('meeting.participant_joined', id, {
      roleId,
      roleName: updated.Role?.name,
      stance: participant.stance,
    });

    sendSuccess(res, updated);
  } catch (error) {
    logger.error('Error accepting invite', { error });
    sendError(res, 'Failed to accept invite');
  }
});

// 拒绝邀请
router.post('/:id/participants/:roleId/decline', async (req: Request, res: Response) => {
  try {
    const { id, roleId } = req.params;
    const { reason } = req.body;

    const participant = await prisma.meetingParticipant.findFirst({
      where: { meetingId: id, roleId },
    });

    if (!participant) return sendNotFound(res, 'Participant');
    if (participant.inviteStatus !== 'pending') return sendBadRequest(res, 'Already responded');

    const updated = await prisma.meetingParticipant.update({
      where: { id: participant.id },
      data: {
        inviteStatus: 'declined',
        respondedAt: new Date(),
        declineReason: reason,
      },
      include: { Role: true },
    });

    await publishMeetingEvent('meeting.participant_declined', id, {
      roleId,
      roleName: updated.Role?.name,
      reason,
    });

    sendSuccess(res, updated);
  } catch (error) {
    logger.error('Error declining invite', { error });
    sendError(res, 'Failed to decline invite');
  }
});

// 移除参与者
router.delete('/:id/participants/:roleId', requireRole('Admin'), async (req: Request, res: Response) => {
  try {
    const { id, roleId } = req.params;

    const participant = await prisma.meetingParticipant.findFirst({
      where: { meetingId: id, roleId },
    });

    if (!participant) return sendNotFound(res, 'Participant');

    await prisma.meetingParticipant.delete({ where: { id: participant.id } });
    res.json({ success: true });
  } catch (error) {
    logger.error('Error removing participant', { error });
    sendError(res, 'Failed to remove participant');
  }
});

// 启动会议
router.post('/:id/start', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const meeting = await prisma.meeting.findUnique({
      where: { id },
      include: { MeetingParticipant: { include: { Role: true } } },
    });

    if (!meeting) return sendNotFound(res, 'Meeting');
    if (meeting.status !== 'pending') return sendBadRequest(res, 'Meeting already started');
    if (meeting.MeetingParticipant.length === 0) return sendBadRequest(res, 'Meeting has no participants');

    const updatedMeeting = await prisma.meeting.update({
      where: { id },
      data: { status: 'discussing', startedAt: new Date() },
      include: { MeetingParticipant: { include: { Role: true } } },
    });

    await prisma.meetingParticipant.updateMany({
      where: { meetingId: id },
      data: {
        locked: true,
        lockedBy: id,
        lockedAt: new Date(),
        status: 'joined',
        joinedAt: new Date(),
      },
    });

    await publishMeetingEvent('meeting.started', id, {
      title: meeting.title,
      participantCount: meeting.MeetingParticipant.length,
    });

    res.json({
      data: {
        ...updatedMeeting,
        MeetingParticipant: await prisma.meetingParticipant.findMany({
          where: { meetingId: id },
          include: { Role: true },
        }),
      }
    });
  } catch (error) {
    logger.error('Error starting meeting', { error });
    sendError(res, 'Failed to start meeting');
  }
});

export { router as meetingParticipantRoutes };
