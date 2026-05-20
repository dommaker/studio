/**
 * 会议超时检查服务
 * 
 * 定期检查会议状态，自动结束超时会议
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';

export interface TimeoutCheckerConfig {
  checkInterval?: number;  // 检查间隔（毫秒），默认 60000（1分钟）
}

export class MeetingTimeoutChecker {
  private running = false;
  private checkInterval: number;
  private intervalId?: NodeJS.Timeout;

  constructor(config: TimeoutCheckerConfig = {}) {
    this.checkInterval = config.checkInterval || 60000;  // 默认 1 分钟检查一次
  }

  /**
   * 启动超时检查服务
   */
  async start(): Promise<void> {
    if (this.running) return;
    
    this.running = true;
    logger.info('Meeting timeout checker started', { checkInterval: this.checkInterval });

    // 立即执行一次检查
    await this.checkTimeouts();

    // 设置定时检查
    this.intervalId = setInterval(async () => {
      try {
        await this.checkTimeouts();
      } catch (error) {
        logger.error('Meeting timeout check failed', { error });
      }
    }, this.checkInterval);
  }

  /**
   * 停止超时检查服务
   */
  async stop(): Promise<void> {
    if (!this.running) return;
    
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = undefined;
    }
    
    logger.info('Meeting timeout checker stopped');
  }

  /**
   * 检查超时会议
   */
  async checkTimeouts(): Promise<void> {
    const now = new Date();

    // 1. 检查 discussing 状态会议（已开始但超时）
    const discussingMeetings = await prisma.meeting.findMany({
      where: {
        status: 'DISCUSSING',
        startedAt: { not: null },
      },
      include: {
        MeetingMessage: {
          orderBy: { createdAt: 'desc' },
          take: 1,
        },
      },
    });

    for (const meeting of discussingMeetings) {
      const startedAt = meeting.startedAt!;
      const autoEndMinutes = meeting.autoEndMinutes || 30;
      const lastMessage = meeting.MeetingMessage[0];
      
      // 计算超时：
      // - 开始时间超过 autoEndMinutes
      // - 或最后一条消息超过 responseTimeout 分钟
      const elapsedSinceStart = (now.getTime() - startedAt.getTime()) / 60000;
      const elapsedSinceLastMessage = lastMessage
        ? (now.getTime() - lastMessage.createdAt.getTime()) / 60000
        : elapsedSinceStart;

      if (elapsedSinceStart > autoEndMinutes || elapsedSinceLastMessage > (meeting.responseTimeout || 60)) {
        await this.endMeeting(meeting.id, '会议超时自动结束');
        logger.info('Meeting auto-ended due to timeout', {
          meetingId: meeting.id,
          elapsedSinceStart,
          elapsedSinceLastMessage,
        });
      }
    }

    // 2. 检查 pending 状态会议（未开始但超时）
    const pendingMeetings = await prisma.meeting.findMany({
      where: {
        status: 'PENDING',
        createdAt: { lt: new Date(now.getTime() - 24 * 60 * 60 * 1000) },  // 超过 24 小时
      },
    });

    for (const meeting of pendingMeetings) {
      // pending 超过 24 小时，自动取消
      await prisma.meeting.update({
        where: { id: meeting.id },
        data: {
          status: 'CANCELLED',
          completedAt: now,
          updatedAt: now,
        },
      });
      logger.info('Pending meeting cancelled after 24 hours', { meetingId: meeting.id });
    }

    logger.info('Meeting timeout check completed', {
      discussingChecked: discussingMeetings.length,
      pendingChecked: pendingMeetings.length,
    });
  }

  /**
   * 结束会议
   */
  private async endMeeting(meetingId: string, summary: string): Promise<void> {
    await prisma.meeting.update({
      where: { id: meetingId },
      data: {
        status: 'TIMEOUT',
        completedAt: new Date(),
        updatedAt: new Date(),
        summary,
      },
    });

    // 发布会议结束事件
    await this.publishMeetingEvent('meeting_timeout', meetingId, { reason: summary });
  }

  /**
   * 发布事件
   */
  private async publishMeetingEvent(eventType: string, meetingId: string, data: any): Promise<void> {
    // 这里可以发布到 Redis 或其他事件系统
    logger.info('Meeting event published', { eventType, meetingId, data });
  }
}

// 单例
let timeoutChecker: MeetingTimeoutChecker | null = null;

export function getTimeoutChecker(): MeetingTimeoutChecker {
  if (!timeoutChecker) {
    timeoutChecker = new MeetingTimeoutChecker();
  }
  return timeoutChecker;
}

export function startTimeoutChecker(): void {
  getTimeoutChecker().start();
}

export function stopTimeoutChecker(): void {
  if (timeoutChecker) {
    timeoutChecker.stop();
  }
}