/**
 * 会议-项目关联路由 + 任务分配
 * - PUT /:id/project 关联项目
 * - GET /:id/project 获取关联项目
 * - POST /:id/create-project 从会议创建项目
 * - POST /:id/end 结束会议（生成纪要）
 * - POST /:id/generate-summary 预览纪要
 * - POST /:id/assign-tasks 批量分配任务
 */
import {
  Router, Request, Response,
  prisma, logger, redis,
  publishMeetingEvent,
  sendSuccess, sendError, sendNotFound, sendBadRequest,
  REDIS_TTL_1H, SUMMARY_PREVIEW_LENGTH,
} from './meeting-shared.js';
import { generateMeetingSummary } from './meeting-summary.service.js';
import { createProjectFromMeeting } from './project-bootstrap.service.js';


const router = Router();

// 关联会议到已有 Project
router.put('/:id/project', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { projectId, pmoNumber, companyId } = req.body;

    const meeting = await prisma.meeting.findUnique({
      where: { id },
      select: { companyId: true, status: true },
    });

    if (!meeting) return sendNotFound(res, 'Meeting');

    let project;
    if (pmoNumber && companyId) {
      project = await prisma.project.findUnique({
        where: { companyId_pmoNumber: { companyId, pmoNumber } },
      });
      if (!project) return sendNotFound(res, 'Project');
    } else if (projectId) {
      project = await prisma.project.findUnique({ where: { id: projectId } });
      if (!project) return sendNotFound(res, 'Project');
    }

    const updated = await prisma.meeting.update({
      where: { id },
      data: { projectId: project?.id || projectId },
      include: { Project: true },
    });

    if (updated.projectId) {
      await prisma.project.update({
        where: { id: updated.projectId },
        data: { status: 'in_review' },
      });
    }

    sendSuccess(res, updated);
  } catch (error) {
    logger.error('Error linking meeting to project', { error });
    sendError(res, 'Failed to link meeting to project');
  }
});

// 从会议创建项目
router.post('/:id/create-project', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { title, description, requirement, okrId, priority, gitRepo } = req.body;

    const result = await createProjectFromMeeting(id, { title, description, requirement, okrId, priority, gitRepo });

    res.status(201).json({ data: result });
  } catch (error) {
    logger.error('Error creating project from meeting', { error });
    sendError(res, 'Failed to create project from meeting');
  }
});

// 获取会议关联的 Project
router.get('/:id/project', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const meeting = await prisma.meeting.findUnique({
      where: { id },
      include: { Project: true, OutputProject: true },
    });

    if (!meeting) return sendNotFound(res, 'Meeting');

    res.json({
      data: {
        linkedProject: meeting.Project,
        outputProject: meeting.OutputProject,
      },
    });
  } catch (error) {
    logger.error('Error getting meeting project', { error });
    sendError(res, 'Failed to get meeting project');
  }
});

// 结束会议
router.post('/:id/end', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { summary, decisions, generateSummary } = req.body;

    const meeting = await prisma.meeting.findUnique({
      where: { id },
      include: {
        MeetingParticipant: { include: { Role: true } },
        MeetingMessage: { include: { Role: true }, orderBy: { createdAt: 'asc' } },
      },
    });

    if (!meeting) return sendNotFound(res, 'Meeting');

    let finalSummary = summary;
    let finalDecisions = decisions;

    if (generateSummary && meeting.MeetingMessage.length > 0) {
      const generated = await generateMeetingSummary(meeting);
      finalSummary = finalSummary || generated.summary;
      finalDecisions = finalDecisions || generated.decisions;

      // 保存结构化待办和关键发现
      await prisma.meeting.update({
        where: { id },
        data: {
          actionItems: generated.actionItems,
          keyFindings: generated.keyFindings,
        },
      });
    }

    const updatedMeeting = await prisma.meeting.update({
      where: { id },
      data: {
        status: 'pending_confirmation',
        summary: finalSummary,
        decisions: finalDecisions,
      },
    });

    await prisma.meetingParticipant.updateMany({
      where: { meetingId: id },
      data: {
        locked: false, lockedBy: null, lockedAt: null,
        status: 'completed',
      },
    });

    const summaryKey = `meeting:${id}:summary`;
    const decisionsKey = `meeting:${id}:decisions`;

    if (finalSummary) await redis.setex(summaryKey, REDIS_TTL_1H, finalSummary);
    if (finalDecisions && finalDecisions.length > 0) {
      await redis.setex(decisionsKey, REDIS_TTL_1H, JSON.stringify(finalDecisions));
    }

    await publishMeetingEvent('meeting.ended', id, {
      title: meeting.title,
      taskId: meeting.taskId,
      projectId: meeting.projectId,
      constraintLevel: meeting.constraintLevel || 'L2',
      summaryKey: finalSummary ? summaryKey : undefined,
      summaryPreview: finalSummary ? finalSummary.substring(0, SUMMARY_PREVIEW_LENGTH) : undefined,
      decisionsKey: finalDecisions?.length > 0 ? decisionsKey : undefined,
      decisionCount: finalDecisions?.length || 0,
      participants: meeting.MeetingParticipant?.map((p) => ({
        roleId: p.roleId,
        roleName: p.Role?.name,
      })),
      messageCount: meeting.MeetingMessage?.length || 0,
    });

    res.json({ data: updatedMeeting, summary: finalSummary, decisions: finalDecisions });
  } catch (error) {
    logger.error('Error ending meeting', { error });
    sendError(res, 'Failed to end meeting');
  }
});

// 预览纪要
router.post('/:id/generate-summary', async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

    const meeting = await prisma.meeting.findUnique({
      where: { id },
      include: {
        MeetingParticipant: { include: { Role: true } },
        MeetingMessage: { include: { Role: true }, orderBy: { createdAt: 'asc' } },
      },
    });

    if (!meeting) return sendNotFound(res, 'Meeting');
    if (meeting.MeetingMessage.length === 0) {
      return res.json({ summary: '暂无讨论内容', decisions: [] });
    }

    const generated = await generateMeetingSummary(meeting);
    res.json(generated);
  } catch (error) {
    logger.error('Error generating summary', { error });
    sendError(res, 'Failed to generate summary');
  }
});

export { router as meetingProjectRoutes };
