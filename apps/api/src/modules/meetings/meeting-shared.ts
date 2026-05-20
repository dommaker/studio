/**
 * 会议模块共享依赖
 */
import { Router, Request, Response } from 'express';
import { prisma } from '@dommaker/studio-prisma';
import { Prisma } from '@prisma/client';
import { createLogger } from '@dommaker/studio-shared';
import { eventStore } from '../../core/event-store.js';
import { v4 as uuidv4 } from 'uuid';
import { notifyService } from '../outbound-notify/notify.service.js';
import { discussionEventPublisher } from '@dommaker/studio-meeting/events/discussion-events';
import { checkPermission } from '../../middleware/permission-check.js';
import { requireRole } from '../../middleware/auth.js';
import { sendSuccess, sendError, sendNotFound, sendBadRequest } from '../../utils/response.js';

const redis = eventStore;
const logger = createLogger('Meetings');

// 常量
const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_DISCUSSION_MAX_ROUNDS = 10;
const REDIS_TTL_1H = 3600;
const SUMMARY_PREVIEW_LENGTH = 200;

// 类型
interface RoleMatch {
  id: string;
  name: string;
  type?: string;
}

// 事件发布
async function publishMeetingEvent(eventType: string, meetingId: string, data: Record<string, unknown>) {
  const event = {
    event_id: uuidv4(),
    event_type: eventType,
    timestamp: new Date().toISOString(),
    data: { meetingId, ...data },
  };
  await redis.publish('events:meeting', JSON.stringify(event));
  logger.info(`[Meeting Event] ${eventType} - ${meetingId}`);
}

export {
  Router,
  Request,
  Response,
  prisma,
  Prisma,
  redis,
  logger,
  uuidv4,
  notifyService,
  discussionEventPublisher,
  checkPermission,
  requireRole,
  sendSuccess,
  sendError,
  sendNotFound,
  sendBadRequest,
  publishMeetingEvent,
  DEFAULT_MAX_ROUNDS,
  DEFAULT_DISCUSSION_MAX_ROUNDS,
  REDIS_TTL_1H,
  SUMMARY_PREVIEW_LENGTH,
  type RoleMatch,
};
