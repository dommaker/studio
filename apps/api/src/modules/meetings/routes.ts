/**
 * 会议室 API 路由 - 聚合入口
 *
 * 拆分为 4 个子路由：
 * - meeting-crud.routes.ts: CRUD + 角色状态 + 议题导入
 * - meeting-participants.routes.ts: 参与者管理 + 启动会议
 * - meeting-discussion.routes.ts: 消息 + 讨论 + 发言队列 + 用户干预
 * - meeting-project.routes.ts: 项目关联 + 纪要 + 任务分配
 *
 * 服务层：
 * - meeting-summary.service.ts: LLM 纪要生成
 * - project-bootstrap.service.ts: 从会议创建项目 (git init)
 * - task-assignment.service.ts: 角色匹配 + Workflow 触发
 * - meeting-shared.ts: 共享依赖 (prisma, redis, logger, utils)
 */
import { Router } from 'express';
import { meetingCrudRoutes } from './meeting-crud.routes.js';
import { meetingParticipantRoutes } from './meeting-participants.routes.js';
import { meetingDiscussionRoutes } from './meeting-discussion.routes.js';
import { meetingProjectRoutes } from './meeting-project.routes.js';
import { meetingActionRoutes } from './meeting-action.routes.js';

const router = Router();

router.use(meetingCrudRoutes);
router.use(meetingParticipantRoutes);
router.use(meetingDiscussionRoutes);
router.use(meetingProjectRoutes);
router.use(meetingActionRoutes);

export default router;
