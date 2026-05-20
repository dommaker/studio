/**
 * 会议讨论路由
 * - POST /:id/messages 发送消息
 * - GET /:id/messages 获取消息
 * - POST /:id/run-discussion 启动讨论
 * - GET /:id/discussion-status 讨论状态
 * - GET /:id/speaking-queue 发言队列+投票
 * - POST /:id/user-intervention 用户介入
 * - POST /:id/stop-discussion 停止讨论
 */
import {
  Router, Request, Response,
  prisma, Prisma, logger, redis,
  notifyService, discussionEventPublisher,
  publishMeetingEvent,
  sendSuccess, sendError, sendNotFound, sendBadRequest,
  checkPermission,
  DEFAULT_DISCUSSION_MAX_ROUNDS, REDIS_TTL_1H,
} from './meeting-shared.js';
import { parsePagination, formatPaginatedResponse } from '../../utils/pagination.js';

const router = Router();
const MESSAGE_PREVIEW_LENGTH = 100;

// 获取消息列表
router.get('/:id/messages', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { page, limit, offset } = parsePagination(req);

    const messages = await prisma.meetingMessage.findMany({
      where: { meetingId: id },
      include: { Role: { select: { id: true, name: true, type: true, level: true } } },
      orderBy: { createdAt: 'asc' },
      take: limit,
      skip: offset,
    });

    const total = await prisma.meetingMessage.count({ where: { meetingId: id } });
    res.json(formatPaginatedResponse(messages, total, page, limit));
  } catch (error) {
    logger.error('Error fetching messages', { error });
    sendError(res, 'Failed to fetch messages');
  }
});

// 发送消息
router.post('/:id/messages', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { roleId, content, messageType, round } = req.body;

    if (!roleId || !content) return sendBadRequest(res, 'Missing required fields: roleId, content');

    const meeting = await prisma.meeting.findUnique({
      where: { id },
      include: { MeetingParticipant: true },
    });

    if (!meeting) return sendNotFound(res, 'Meeting');

    const participant = meeting.MeetingParticipant.find(p => p.roleId === roleId);
    if (!participant) return sendBadRequest(res, 'Role is not a participant in this meeting');

    if (meeting.status === 'pending') {
      await prisma.meeting.update({
        where: { id },
        data: { status: 'discussing', startedAt: new Date() },
      });

      await prisma.meetingParticipant.updateMany({
        where: { meetingId: id },
        data: {
          locked: true, lockedBy: id, lockedAt: new Date(),
          status: 'joined', joinedAt: new Date(),
        },
      });
    }

    const message = await prisma.meetingMessage.create({
      data: {
        meetingId: id,
        participantId: participant.id,
        roleId,
        content,
        messageType: messageType || 'speech',
        round: round || 1,
        stance: participant.stance,
      },
      include: { Role: { select: { id: true, name: true, type: true, level: true } } },
    });

    await publishMeetingEvent('meeting.message_sent', id, {
      messageId: message.id,
      roleId,
      roleName: message.Role?.name,
      content: content.substring(0, MESSAGE_PREVIEW_LENGTH),
      round: round || 1,
    });

    if (meeting.source === 'discord' && meeting.sourceChannelId) {
      await notifyService.send({
        type: 'meeting-message',
        meetingId: id,
        title: `会议室讨论`,
        content: `${message.Role?.name}: ${content}`,
      });
    }

    if (meeting.status === 'pending') {
      await publishMeetingEvent('meeting.started', id, { title: meeting.title });

      if (meeting.source === 'discord' && meeting.sourceChannelId) {
        await notifyService.send({
          type: 'meeting-started',
          meetingId: id,
          title: `🚀 会议开始`,
          content: `**${meeting.title}**\n\n参与者已就位，开始讨论...`,
        });
      }
    }

    sendSuccess(res, message);
  } catch (error) {
    logger.error('Error sending message', { error });
    sendError(res, 'Failed to send message');
  }
});

// 启动讨论
router.post('/:id/run-discussion', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { mode, topic, maxRounds, consensusThreshold } = req.body;

    if (!mode) return sendBadRequest(res, '缺少 mode 参数，请使用 manual/auto/mixed');
    if (mode !== 'manual' && mode !== 'auto' && mode !== 'mixed') {
      return sendBadRequest(res, `无效的讨论模式 "${mode}"，请使用 manual/auto/mixed`);
    }

    if (mode === 'mixed') {
      return res.status(501).json({
        success: false, mode: 'mixed',
        message: '混合讨论模式尚未实现（计划 DD-009）',
      });
    }

    const meeting = await prisma.meeting.findUnique({
      where: { id },
      include: { MeetingParticipant: { include: { Role: { select: { id: true, name: true, type: true, level: true } } } } },
    });

    if (!meeting) return sendNotFound(res, 'Meeting');
    if (meeting.status !== 'discussing') return sendBadRequest(res, '会议未激活，无法启动讨论');

    switch (mode) {
      case 'manual':
        await prisma.meeting.update({
          where: { id },
          data: { discussionMode: 'manual', discussionStatus: 'idle' },
        });
        return res.json({ success: true, mode: 'manual', message: '手动讨论模式已开启' });

      case 'auto': {
        const taskId = uuidv4();

        await redis.set(
          `discussion:task:${taskId}`,
          JSON.stringify({
            meetingId: id, status: 'running',
            startedAt: new Date().toISOString(),
            topic, maxRounds, consensusThreshold,
          }),
          'EX', REDIS_TTL_1H
        );

        await prisma.meeting.update({
          where: { id },
          data: {
            discussionMode: 'auto', discussionTaskId: taskId,
            discussionTopic: topic || meeting.topic, discussionStatus: 'running',
          },
        });

        await discussionEventPublisher.publishAutoStart(
          id, taskId,
          topic || meeting.topic || '未指定议题',
          maxRounds || DEFAULT_DISCUSSION_MAX_ROUNDS
        );

        return res.json({
          success: true, mode: 'auto', taskId,
          message: '自动讨论已启动',
          statusEndpoint: `/api/v1/meetings/${id}/discussion-status`,
        });
      }
    }
  } catch (error) {
    logger.error('Error running discussion', { error });
    sendError(res, 'Failed to run discussion');
  }
});

// 查询讨论状态
router.get('/:id/discussion-status', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const meeting = await prisma.meeting.findUnique({
      where: { id },
      select: {
        id: true, title: true, discussionMode: true,
        discussionTaskId: true, discussionTopic: true,
        discussionStatus: true, status: true,
      },
    });

    if (!meeting) return sendNotFound(res, 'Meeting');

    let taskDetails = null;
    if (meeting.discussionTaskId) {
      const taskData = await redis.get(`discussion:task:${meeting.discussionTaskId}`);
      if (taskData) taskDetails = JSON.parse(taskData);
    }

    res.json({
      meetingId: meeting.id,
      title: meeting.title,
      discussionMode: meeting.discussionMode || 'manual',
      discussionStatus: meeting.discussionStatus || 'idle',
      discussionTopic: meeting.discussionTopic,
      taskId: meeting.discussionTaskId,
      taskDetails,
      meetingStatus: meeting.status,
    });
  } catch (error) {
    logger.error('Error getting discussion status', { error });
    sendError(res, 'Failed to get discussion status');
  }
});

// 发言队列可视化
router.get('/:id/speaking-queue', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const meeting = await prisma.meeting.findUnique({
      where: { id },
      include: {
        MeetingParticipant: { include: { Role: { select: { id: true, name: true, type: true, level: true } } } },
        MeetingMessage: { orderBy: { createdAt: 'asc' }, include: { Role: { select: { id: true, name: true, type: true, level: true } } } },
      },
    });

    if (!meeting) return sendNotFound(res, 'Meeting');

    const participants = meeting.MeetingParticipant || [];
    const messages = meeting.MeetingMessage || [];

    const speakCounts = new Map<string, number>();
    for (const p of participants) speakCounts.set(p.roleId, 0);
    for (const m of messages) speakCounts.set(m.roleId, (speakCounts.get(m.roleId) ?? 0) + 1);

    const waitingQueue = participants
      .filter(p => p.status !== 'left')
      .map(p => ({
        roleId: p.roleId,
        roleName: p.Role?.name || 'Unknown',
        roleLevel: p.Role?.level || 1,
        stance: p.stance || 'executor',
        speakCount: speakCounts.get(p.roleId) ?? 0,
      }))
      .sort((a, b) => a.speakCount - b.speakCount)
      .map((p, index) => ({
        order: index + 1,
        roleId: p.roleId,
        roleName: p.roleName,
        roleLevel: p.roleLevel,
        stance: p.stance,
      }));

    const lastMessage = messages[messages.length - 1];
    const spokenThisRound = lastMessage ? [{
      roleId: lastMessage.roleId,
      roleName: lastMessage.Role?.name || 'Unknown',
      speakCount: speakCounts.get(lastMessage.roleId) ?? 1,
      lastMessageAt: lastMessage.createdAt.toISOString(),
    }] : [];

    const currentRound = messages.length > 0
      ? Math.max(...messages.map(m => m.round || 1))
      : 0;
    const maxRounds = meeting.maxRounds || DEFAULT_DISCUSSION_MAX_ROUNDS;

    // 投票状态
    const specReview = await prisma.specReview.findFirst({
      where: { meetingId: id },
      include: { SpecReviewApproval: true },
    });

    let voting = null;
    let signatures = null;

    if (specReview) {
      const approvals = specReview.SpecReviewApproval || [];
      const approveCount = approvals.filter(a => a.approved).length;
      const rejectCount = approvals.filter(a => !a.approved).length;
      const totalParticipants = participants.length;
      const pendingCount = totalParticipants - approveCount - rejectCount;

      const approvedRoleIds = approvals.map(a => a.reviewerId);
      const pendingVoters = participants
        .filter(p => !approvedRoleIds.includes(p.roleId))
        .map(p => ({ roleId: p.roleId, roleName: p.Role?.name || 'Unknown' }));

      voting = {
        votes: { approve: approveCount, reject: rejectCount, abstain: 0, pending: pendingCount },
        pendingVoters,
        votingRule: { mode: 'majority_2_3', minApprovers: Math.ceil(totalParticipants * 2 / 3) },
        architectVeto: {
          canVeto: true,
          hasVetoed: approvals.some(a => a.role === 'architect' && !a.approved),
        },
      };

      signatures = {
        signed: approvals.map(a => ({
          roleId: a.reviewerId, roleName: a.reviewerName,
          stance: a.role, signedAt: a.createdAt.toISOString(),
          verdict: a.approved ? 'approve' : 'reject',
        })),
        pending: pendingVoters,
        progress: {
          signedCount: approvals.length,
          totalCount: totalParticipants,
          percentage: Math.round(approvals.length / totalParticipants * 100),
        },
      };
    }

    const stats = {
      totalMessages: messages.length,
      consensusProgress: Math.min(100, Math.round(currentRound / maxRounds * 100)),
    };

    res.json({
      data: {
        meetingId: meeting.id, currentRound, maxRounds,
        waitingQueue, spokenThisRound, stats,
        discussionStatus: meeting.discussionStatus || meeting.status,
        voting, signatures,
      },
    });
  } catch (error) {
    logger.error('Error getting speaking queue', { error });
    sendError(res, 'Failed to get speaking queue');
  }
});

// 用户干预
router.post('/:id/user-intervention', checkPermission('force_decision'), async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { action, decision, channelId } = req.body;

    const meeting = await prisma.meeting.findUnique({
      where: { id },
      include: { MeetingParticipant: { include: { Role: { select: { id: true, name: true, type: true, level: true } } } } },
    });

    if (!meeting) return sendNotFound(res, 'Meeting');

    if (meeting.discussionStatus !== 'pending_user' && meeting.status !== 'pending_user') {
      return sendBadRequest(res, '会议不需要干预');
    }

    if (meeting.source === 'discord' && channelId) {
      if (meeting.sourceChannelId !== channelId) return sendBadRequest(res, '消息来源不匹配');
    }

    switch (action) {
      case 'continue':
        await prisma.meeting.update({
          where: { id },
          data: { discussionStatus: 'discussing', status: 'discussing' },
        });
        await discussionEventPublisher.publishAutoStart(
          id, meeting.discussionTaskId || '',
          meeting.topic || '', meeting.maxRounds || DEFAULT_DISCUSSION_MAX_ROUNDS
        );
        break;

      case 'force_decision':
        if (!decision) return sendBadRequest(res, '决策内容为空');
        const existingDecisions = Array.isArray(meeting.decisions) ? meeting.decisions as Record<string, unknown>[] : [];
        await prisma.meeting.update({
          where: { id },
          data: {
            discussionStatus: 'completed',
            status: 'pending_confirmation',
            decisions: [...existingDecisions, { content: decision, agreed: true, priority: 'high', source: 'user' }] as unknown as Prisma.InputJsonValue,
          },
        });
        await discussionEventPublisher.publishCompleted(id, decision, meeting.maxRounds || DEFAULT_DISCUSSION_MAX_ROUNDS);
        break;

      case 'cancel':
        await prisma.meeting.update({
          where: { id },
          data: { discussionStatus: 'cancelled', status: 'cancelled', completedAt: new Date() },
        });
        await discussionEventPublisher.publishStopped(id, 'user_cancel');
        break;

      default:
        return sendBadRequest(res, '无效的 action');
    }

    if (meeting.source === 'discord' && meeting.sourceChannelId) {
      const actionText = action === 'continue' ? '继续讨论' : action === 'cancel' ? '已终止' : `决策：${decision}`;
      await notifyService.send({
        type: 'meeting-completed',
        meetingId: id,
        title: `✅ 用户干预`,
        content: `会议「${meeting.title}」\n${actionText}`,
      });
    }

    res.json({
      success: true,
      meeting: {
        id: meeting.id, title: meeting.title,
        status: action === 'continue' ? 'discussing' : action === 'cancel' ? 'cancelled' : 'pending_confirmation',
        discussionStatus: action === 'continue' ? 'discussing' : action === 'cancel' ? 'cancelled' : 'completed',
      },
    });
  } catch (error) {
    logger.error('Error handling user intervention', { error });
    sendError(res, 'Failed to handle intervention');
  }
});

// 停止讨论
router.post('/:id/stop-discussion', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const meeting = await prisma.meeting.findUnique({ where: { id } });
    if (!meeting) return sendNotFound(res, 'Meeting');

    await prisma.meeting.update({
      where: { id },
      data: { discussionStatus: 'completed', discussionTaskId: null },
    });

    if (meeting.discussionTaskId) {
      await redis.del(`discussion:task:${meeting.discussionTaskId}`);
    }

    await discussionEventPublisher.publishStopped(id, 'user_request');
    res.json({ success: true, message: '讨论已停止' });
  } catch (error) {
    logger.error('Error stopping discussion', { error });
    sendError(res, 'Failed to stop discussion');
  }
});

export { router as meetingDiscussionRoutes };
