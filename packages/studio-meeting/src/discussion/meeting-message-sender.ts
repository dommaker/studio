/**
 * Meeting Message Sender
 * 
 * DD-008: MessageSender 接口的 Prisma 实现
 * 用于 DiscussionDriver 发送消息到会议
 */

import { PrismaClient } from '@prisma/client';
import { prisma } from '@dommaker/studio-prisma';

/**
 * 消息发送结果
 */
export interface MessageSendResult {
  messageId: string;
  timestamp: string;
}

/**
 * MessageSender 接口
 */
export interface MessageSender {
  send(meetingId: string, roleId: string, content: string): Promise<MessageSendResult>;
}

/**
 * Meeting Message Sender 实现
 */
export class MeetingMessageSender implements MessageSender {
  private prisma: PrismaClient;

  constructor(prismaClient?: PrismaClient) {
    this.prisma = prismaClient || prisma;
  }

  /**
   * 发送消息到会议
   */
  async send(meetingId: string, roleId: string, content: string): Promise<MessageSendResult> {
    // 检查角色是否是参与者
    const participant = await this.prisma.meetingParticipant.findFirst({
      where: { meetingId, roleId },
    });

    if (!participant) {
      throw new Error(`Role ${roleId} is not a participant in meeting ${meetingId}`);
    }

    // 创建消息
    const message = await this.prisma.meetingMessage.create({
      data: {
        meetingId,
        participantId: participant.id,
        roleId,
        content,
        messageType: 'speech',
        stance: participant.stance,
        round: 1, // DiscussionDriver 会管理 round
      },
    });

    return {
      messageId: message.id,
      timestamp: message.createdAt.toISOString(),
    };
  }
}

// 导出单例
export const messageSender = new MeetingMessageSender();