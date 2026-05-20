/**
 * 会议 CRUD 路由
 * - POST / 创建会议
 * - GET / 列表（分页+缓存）
 * - GET /:id 详情
 * - PUT /:id 更新
 * - GET /roles/status 角色锁定状态
 * - GET /by-project/:projectId 按项目查会议
 * - POST /import-topic 导入议题
 * - POST /:id/confirm-minutes 确认纪要
 */
import {
  Router, Request, Response,
  prisma, logger,
  publishMeetingEvent,
  sendSuccess, sendError, sendNotFound, sendBadRequest,
  DEFAULT_MAX_ROUNDS,
} from './meeting-shared.js';
import { apiCache, CACHE_CONFIG } from '../../middleware/api-cache.js';
import { parsePagination, formatPaginatedResponse } from '../../utils/pagination.js';

const router = Router();

// 创建会议
router.post('/', async (req: Request, res: Response) => {
  try {
    const {
      title,
      description,
      topic,
      participantIds,
      companyId,
      mode,
      maxRounds,
      isSensitive,
      taskId,
      relatedWorkflowId,
      source,
      sourceChannelId,
      projectId,
    } = req.body;

    if (!title || !companyId) {
      return sendBadRequest(res, 'Missing required fields: title, companyId');
    }

    const meeting = await prisma.meeting.create({
      data: {
        title,
        description,
        topic,
        companyId,
        mode: mode || 'sync',
        maxRounds: maxRounds || DEFAULT_MAX_ROUNDS,
        isSensitive: isSensitive || false,
        status: 'pending',
        taskId,
        relatedWorkflowId,
        source: source || 'api',
        sourceChannelId,
        projectId,
      },
    });

    if (participantIds && participantIds.length > 0) {
      const lockedRoles = await prisma.meetingParticipant.findMany({
        where: {
          roleId: { in: participantIds },
          locked: true,
        },
        include: { Role: { select: { id: true, name: true, type: true, level: true } } },
      });

      if (lockedRoles.length > 0) {
        return res.status(400).json({
          error: 'Some roles are locked in other meetings',
          lockedRoles: lockedRoles.map(p => ({ id: p.roleId, name: p.Role.name })),
        });
      }

      await prisma.meetingParticipant.createMany({
        data: participantIds.map((roleId: string) => ({
          meetingId: meeting.id,
          roleId,
          stance: 'executor',
          status: 'invited',
        })),
      });
    }

    const fullMeeting = await prisma.meeting.findUnique({
      where: { id: meeting.id },
      include: {
        MeetingParticipant: {
          include: { Role: { select: { id: true, name: true, type: true, level: true } } },
        },
      },
    });

    await publishMeetingEvent('meeting.created', meeting.id, {
      title: meeting.title,
      status: meeting.status,
    });

    sendSuccess(res, fullMeeting);
  } catch (error) {
    logger.error('Error creating meeting', { error });
    sendError(res, 'Failed to create meeting');
  }
});

// 纪要人工确认
router.post('/:id/confirm-minutes', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { action, confirmedBy, feedback } = req.body;

    const meeting = await prisma.meeting.findUnique({ where: { id } });
    if (!meeting) return sendNotFound(res, 'Meeting');

    if (meeting.status !== 'pending_confirmation') {
      return sendBadRequest(res, '会议不需要确认');
    }

    if (action === 'confirm') {
      const updated = await prisma.meeting.update({
        where: { id },
        data: {
          status: 'completed',
          // @ts-expect-error confirmedBy not in Prisma schema but used at runtime
          confirmedBy,
          confirmedAt: new Date(),
          completedAt: new Date(),
        },
      });
      res.json({ success: true, meeting: updated });
    } else if (action === 'reject') {
      const updated = await prisma.meeting.update({
        where: { id },
        data: {
          status: 'needs_revision',
          // @ts-expect-error confirmationFeedback not in Prisma schema but used at runtime
          confirmationFeedback: feedback,
        },
      });
      res.json({ success: true, meeting: updated });
    } else {
      sendBadRequest(res, '无效的 action');
    }
  } catch (error) {
    logger.error('Error confirming minutes', { error });
    sendError(res, 'Failed to confirm minutes');
  }
});

// 会议列表
router.get('/', apiCache(CACHE_CONFIG.short), async (req: Request, res: Response) => {
  try {
    const { companyId, status } = req.query;
    const { page, limit, offset } = parsePagination(req);

    const where: Record<string, string> = {};
    if (companyId) where.companyId = String(companyId);
    if (status) where.status = String(status);

    const meetings = await prisma.meeting.findMany({
      where,
      include: {
        MeetingParticipant: { include: { Role: { select: { id: true, name: true, type: true, level: true } } } },
        _count: { select: { MeetingMessage: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
      skip: offset,
    });

    const total = await prisma.meeting.count({ where });
    res.json(formatPaginatedResponse(meetings, total, page, limit));
  } catch (error) {
    logger.error('Error fetching meetings', { error });
    sendError(res, 'Failed to fetch meetings');
  }
});

// 会议详情
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const meeting = await prisma.meeting.findUnique({
      where: { id },
      include: {
        MeetingParticipant: { include: { Role: { select: { id: true, name: true, type: true, level: true } } } },
        MeetingMessage: { include: { Role: { select: { id: true, name: true, type: true, level: true } } }, orderBy: { createdAt: 'asc' } },
      },
    });

    if (!meeting) return sendNotFound(res, 'Meeting');

    const response = {
      ...meeting,
      participants: meeting.MeetingParticipant.map((p) => ({ ...p, role: p.Role })),
      messages: meeting.MeetingMessage.map((m) => ({ ...m, role: m.Role })),
    };

    sendSuccess(res, response);
  } catch (error) {
    logger.error('Error fetching meeting', { error });
    sendError(res, 'Failed to fetch meeting');
  }
});

// 更新会议
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, description, topic, status, maxRounds } = req.body;

    const meeting = await prisma.meeting.update({
      where: { id },
      data: {
        ...(title && { title }),
        ...(description !== undefined && { description }),
        ...(topic !== undefined && { topic }),
        ...(status && { status }),
        ...(maxRounds !== undefined && { maxRounds }),
      },
    });

    await publishMeetingEvent('meeting.status_changed', id, {
      title: meeting.title,
      status: meeting.status,
    });

    sendSuccess(res, meeting);
  } catch (error) {
    logger.error('Error updating meeting', { error });
    sendError(res, 'Failed to update meeting');
  }
});

// 角色锁定状态
router.get('/roles/status', async (req: Request, res: Response) => {
  try {
    const { companyId } = req.query;
    const where: Record<string, string> = {};
    if (companyId) where.companyId = companyId as string;

    const roles = await prisma.role.findMany({
      where,
      include: {
        MeetingParticipant: {
          where: { locked: true },
          include: { Meeting: { select: { id: true, title: true } } },
        },
      },
    });

    const rolesWithStatus = roles.map(role => {
      const lockedParticipant = role.MeetingParticipant.find(p => p.locked);
      let status = 'idle';
      let currentTask = null;

      if (lockedParticipant) {
        status = 'meeting';
        currentTask = {
          type: 'meeting',
          id: lockedParticipant.meetingId,
          title: lockedParticipant.Meeting.title,
        };
      }

      return { ...role, status, currentTask };
    });

    sendSuccess(res, rolesWithStatus);
  } catch (error) {
    logger.error('Error fetching roles status', { error });
    sendError(res, 'Failed to fetch roles status');
  }
});

// 按项目查会议
router.get('/by-project/:projectId', async (req: Request, res: Response) => {
  try {
    const { projectId } = req.params;
    const meetings = await prisma.meeting.findMany({
      where: { projectId },
      select: {
        id: true, title: true, status: true, summary: true,
        decisions: true, createdAt: true, completedAt: true, startedAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    res.json({ success: true, data: meetings });
  } catch (error: unknown) {
    logger.error('[获取项目会议列表失败]', { error });
    const msg = error instanceof Error ? error.message : 'Failed to get project meetings';
    sendError(res, msg);
  }
});

// 导入议题
router.post('/import-topic', async (req: Request, res: Response) => {
  try {
    const { source, target, text, taskId } = req.body;
    const { parseTextTopics, fetchAndParse, readFileAndParse } = await import('./roadmap-parser');

    type Topic = Awaited<ReturnType<typeof parseTextTopics>>[number];
    let topics: Topic[] = [];

    switch (source) {
      case 'text':
        if (!text) return sendBadRequest(res, 'Missing text content');
        topics = parseTextTopics(text);
        break;
      case 'url':
        if (!target) return sendBadRequest(res, 'Missing target URL');
        try { topics = await fetchAndParse(target); }
        catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Failed to fetch URL';
          return sendBadRequest(res, msg);
        }
        break;
      case 'roadmap': {
        const roadmapPath = target || 'docs/roadmap.md';
        try { topics = await readFileAndParse(roadmapPath); }
        catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Failed to read roadmap';
          return sendBadRequest(res, msg);
        }
        break;
      }
      case 'file':
        if (!target) return sendBadRequest(res, 'Missing target file path');
        try { topics = await readFileAndParse(target); }
        catch (err: unknown) {
          const msg = err instanceof Error ? err.message : 'Failed to read file';
          return sendBadRequest(res, msg);
        }
        break;
      default:
        return sendBadRequest(res, 'Invalid source type');
    }

    if (taskId) topics = topics.filter(t => t.id === taskId);
    res.json({ success: true, topics });
  } catch (error) {
    logger.error('Error importing topic', { error });
    sendError(res, 'Failed to import topic');
  }
});

export { router as meetingCrudRoutes };
