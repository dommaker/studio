/**
 * NA-001: Requirements Handler
 *
 * 监听 meeting.requirements_ready 事件，自动调用 GoalService 创建
 * 并行 Goal + GoalPlan + GoalExecution。
 */
import { eventStore } from '../../core/event-store.js';
import { logger } from '@dommaker/studio-shared';
import * as fs from 'fs';
import { prisma } from '@dommaker/studio-prisma';
import { goalService } from '../goals/goal.service.js';
import type { RequirementsDoc } from '@dommaker/studio-meeting';
import { afterRequirementsDoc, recordDecision } from '@dommaker/studio-shared/harness/hooks';
import { knowledgeKeeper } from '@dommaker/studio-shared';

let started = false;

export function startRequirementsSubscriber(): void {
  if (started) return;

  eventStore.subscribe('events:meeting', async (message: string) => {
    try {
      const event = JSON.parse(message);
      if (event.event_type !== 'meeting.requirements_ready') return;

      const { meetingId, projectId, requirementsDocPath } = event;
      logger.info('[RequirementsHandler] Processing requirements_ready', { meetingId, projectId });

      if (!requirementsDocPath || !fs.existsSync(requirementsDocPath)) {
        logger.warn('[RequirementsHandler] RequirementsDoc file not found', { path: requirementsDocPath });
        return;
      }

      const raw = fs.readFileSync(requirementsDocPath, 'utf-8');
      const doc: RequirementsDoc = JSON.parse(raw);

      if (!doc.acGroups || doc.acGroups.length === 0) {
        logger.warn('[RequirementsHandler] No acGroups in requirementsDoc');
        return;
      }

      // Phase 4: RequirementsDoc 质量检查
      await afterRequirementsDoc({
        operation: 'file_modification',
        taskDescription: doc.summary || doc.acGroups.map(g => g.acs?.join('; ')).join(' | '),
      }).catch(err => logger.warn('[RequirementsHandler] afterRequirementsDoc failed', { error: String(err) }));

      const result = await goalService.createGoalFromRequirementsDoc(doc, meetingId);
      logger.info('[RequirementsHandler] Goal created from requirementsDoc', {
        meetingId,
        goalId: result.goalId,
        taskCount: result.taskCount,
        stepCount: result.stepCount,
      });

      // 🆕 BP-010: 创建 Wiki 项目页初稿
      const companyId = (event as any).companyId as string | undefined;
      if (companyId) {
        try {
          const project = await prisma.project.findUnique({
            where: { id: projectId as string },
            select: { pmoNumber: true, title: true },
          });
          if (project) {
            knowledgeKeeper.ingestProjectPage(companyId, project.pmoNumber, {
              title: project.title,
              summary: doc.summary,
              acGroups: doc.acGroups,
              constraints: doc.constraints,
              meetingId: meetingId as string,
              goalId: result.goalId,
            });

            // 🆕 审计: Wiki 项目页创建
            recordDecision({
              eventType: 'wiki.page_created',
              entityType: 'wiki',
              entityId: `projects/${project.pmoNumber}.md`,
              companyId,
              projectId: projectId as string,
              summary: `Wiki 项目页创建: ${project.pmoNumber} · ${project.title}`,
              actorRole: 'knowledge_keeper',
            });
          }
        } catch (e) {
          logger.warn('[RequirementsHandler] Wiki page creation failed (non-blocking)', { error: String(e) });
        }
      }

      // 审计: RequirementsDoc → Goal
      recordDecision({
        eventType: 'goal.created',
        entityType: 'goal',
        entityId: result.goalId,
        projectId: projectId as string,
        summary: `Goal 创建（${result.stepCount} 步骤，${result.taskCount} AC 组）`,
        details: { meetingId, acGroupCount: doc.acGroups.length },
        actorRole: 'analyst',
      });
    } catch (error) {
      logger.error('[RequirementsHandler] Error processing requirements_ready', { error: String(error) });
    }
  });

  logger.info('[RequirementsHandler] Started');
}

export function stopRequirementsSubscriber(): void {
  started = false;
  logger.info('[RequirementsHandler] Stopped');
}
