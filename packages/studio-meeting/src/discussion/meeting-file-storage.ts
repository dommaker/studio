/**
 * Meeting 文件存储
 * 
 * DD-016: Redis + 文件双写（借鉴 Ralph）
 * 
 * 用途：
 * - Redis：实时读写（性能）
 * - 文件：会议结束/关键节点保存（可审计）
 */

import { prisma } from '@dommaker/studio-prisma';
import fs from 'fs/promises';
import path from 'path';

// 存储路径
const STORAGE_DIR = process.env.MEETING_STORAGE_DIR || '/tmp/meeting-records';

/**
 * Meeting 文件存储器
 */
export class MeetingFileStorage {
  private storageDir: string;

  constructor(storageDir?: string) {
    this.storageDir = storageDir || STORAGE_DIR;
  }

  /**
   * 保存会议到文件
   */
  async saveMeetingToFile(meetingId: string, reason: 'completed' | 'consensus' | 'stopped'): Promise<string> {
    // 确保目录存在
    await fs.mkdir(this.storageDir, { recursive: true });

    // 获取会议完整数据
    const meeting = await prisma.meeting.findUnique({
      where: { id: meetingId },
      include: {
        MeetingParticipant: true,
        MeetingMessage: true,
        Project: true,
        OutputProject: true,
      },
    });

    if (!meeting) {
      throw new Error(`Meeting ${meetingId} not found`);
    }

    // 构建保存内容
    const record = {
      meetingId: meeting.id,
      title: meeting.title,
      topic: meeting.topic,
      status: meeting.status,
      summary: meeting.summary,
      decisions: meeting.decisions,
      createdAt: meeting.createdAt.toISOString(),
      startedAt: meeting.startedAt?.toISOString(),
      completedAt: meeting.completedAt?.toISOString(),
      savedAt: new Date().toISOString(),
      savedReason: reason,
      participants: (meeting as any).MeetingParticipant || [],
      messages: (meeting as any).MeetingMessage || [],
      project: (meeting as any).Project || null,
      outputProject: (meeting as any).OutputProject || null,
    };

    // 保存到文件
    const filename = `${meetingId}-${reason}-${Date.now()}.json`;
    const filepath = path.join(this.storageDir, filename);

    await fs.writeFile(filepath, JSON.stringify(record, null, 2));

    console.log(`[MeetingFileStorage] Saved meeting ${meetingId} to ${filepath}`);

    return filepath;
  }

  /**
   * 读取会议文件
   */
  async readMeetingFile(filepath: string): Promise<any> {
    const content = await fs.readFile(filepath, 'utf-8');
    return JSON.parse(content);
  }

  /**
   * 列出所有会议文件
   */
  async listMeetingFiles(): Promise<string[]> {
    try {
      const files = await fs.readdir(this.storageDir);
      return files.filter(f => f.endsWith('.json')).map(f => path.join(this.storageDir, f));
    } catch {
      return [];
    }
  }
}

// 导出单例
export const meetingFileStorage = new MeetingFileStorage();