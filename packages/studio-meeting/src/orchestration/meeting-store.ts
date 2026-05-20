/**
 * 会议存储接口
 * 
 * 设计原则：
 * - runtime 定义接口，studio 实现
 * - 支持依赖注入
 * - 无直接 DB 依赖
 */

import type { ConstraintLevel } from '@dommaker/studio-shared';

/**
 * 会议参与者
 */
export interface MeetingParticipant {
  roleId: string;
  roleName: string;
  joinedAt: string;
  stance?: string;
}

/**
 * 会议消息
 */
export interface MeetingMessage {
  id: string;
  meetingId: string;
  roleId: string;
  roleName: string;
  content: string;
  stance?: string;
  createdAt: string;
}

/**
 * 会议决策
 */
export interface MeetingDecision {
  id: string;
  meetingId: string;
  content: string;
  agreed: boolean;
  roles: string[];
  /**
   * 约束级别（AS-035）
   * - L1: 快速执行（无风险）
   * - L2: 标准流程（常规任务）
   * - L3: 严格验证（高风险/核心模块）
   * - L4: 最高约束（架构变更）
   */
  constraintLevel?: ConstraintLevel;
  createdAt: string;
}

/**
 * 会议摘要
 */
export interface MeetingSummary {
  summary: string;
  decisions: MeetingDecision[];
  generatedAt: string;
}

/**
 * 会议状态
 */
export type MeetingStatus = 'pending' | 'running' | 'ended' | 'cancelled';

/**
 * 会议实体
 */
export interface Meeting {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  status: MeetingStatus;
  participants: MeetingParticipant[];
  messages: MeetingMessage[];
  summary?: MeetingSummary;
  /**
   * 约束级别（AS-035）
   * 决定后续工作流的审批流程
   */
  constraintLevel?: ConstraintLevel;
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 创建会议参数
 */
export interface CreateMeetingInput {
  projectId: string;
  title: string;
  description?: string;
  participantRoles: string[]; // 角色 ID 列表
  /**
   * 约束级别（AS-035）
   * @default 'L2'
   */
  constraintLevel?: ConstraintLevel;
}

/**
 * 发送消息参数
 */
export interface SendMessageInput {
  meetingId: string;
  roleId: string;
  content: string;
  stance?: string;
}

/**
 * 会议存储接口
 * 
 * 由 agent-studio 实现，注入到 runtime
 */
export interface MeetingStore {
  // 会议 CRUD
  create(input: CreateMeetingInput): Promise<Meeting>;
  getById(id: string): Promise<Meeting | null>;
  getByProject(projectId: string): Promise<Meeting[]>;
  update(id: string, data: Partial<Meeting>): Promise<Meeting>;
  delete(id: string): Promise<void>;
  
  // 参与者管理
  addParticipant(meetingId: string, roleId: string): Promise<void>;
  removeParticipant(meetingId: string, roleId: string): Promise<void>;
  
  // 消息管理
  sendMessage(input: SendMessageInput): Promise<MeetingMessage>;
  getMessages(meetingId: string): Promise<MeetingMessage[]>;
  
  // 决策管理
  addDecision(meetingId: string, decision: Omit<MeetingDecision, 'id' | 'meetingId' | 'createdAt'>): Promise<MeetingDecision>;
  getDecisions(meetingId: string): Promise<MeetingDecision[]>;
  
  // 摘要管理
  saveSummary(meetingId: string, summary: MeetingSummary): Promise<void>;
  
  // 状态管理
  startMeeting(id: string): Promise<Meeting>;
  endMeeting(id: string): Promise<Meeting>;
}

/**
 * 内存存储实现（用于测试）
 */
export class InMemoryMeetingStore implements MeetingStore {
  private meetings: Map<string, Meeting> = new Map();
  private messages: Map<string, MeetingMessage[]> = new Map();
  private decisions: Map<string, MeetingDecision[]> = new Map();
  private idCounter = 0;
  
  private generateId(): string {
    return `meeting-${++this.idCounter}`;
  }
  
  async create(input: CreateMeetingInput): Promise<Meeting> {
    const id = this.generateId();
    const now = new Date().toISOString();
    
    const meeting: Meeting = {
      id,
      projectId: input.projectId,
      title: input.title,
      description: input.description,
      status: 'pending',
      participants: input.participantRoles.map(roleId => ({
        roleId,
        roleName: roleId, // 简化实现
        joinedAt: now,
      })),
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    
    this.meetings.set(id, meeting);
    this.messages.set(id, []);
    this.decisions.set(id, []);
    
    return meeting;
  }
  
  async getById(id: string): Promise<Meeting | null> {
    const meeting = this.meetings.get(id);
    if (!meeting) return null;
    
    // 附加消息和决策
    return {
      ...meeting,
      messages: this.messages.get(id) || [],
      summary: meeting.summary,
    };
  }
  
  async getByProject(projectId: string): Promise<Meeting[]> {
    const result: Meeting[] = [];
    for (const meeting of this.meetings.values()) {
      if (meeting.projectId === projectId) {
        result.push(await this.getById(meeting.id) as Meeting);
      }
    }
    return result;
  }
  
  async update(id: string, data: Partial<Meeting>): Promise<Meeting> {
    const meeting = this.meetings.get(id);
    if (!meeting) throw new Error(`Meeting not found: ${id}`);
    
    Object.assign(meeting, data, { updatedAt: new Date().toISOString() });
    return meeting;
  }
  
  async delete(id: string): Promise<void> {
    this.meetings.delete(id);
    this.messages.delete(id);
    this.decisions.delete(id);
  }
  
  async addParticipant(meetingId: string, roleId: string): Promise<void> {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);
    
    meeting.participants.push({
      roleId,
      roleName: roleId,
      joinedAt: new Date().toISOString(),
    });
  }
  
  async removeParticipant(meetingId: string, roleId: string): Promise<void> {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);
    
    meeting.participants = meeting.participants.filter(p => p.roleId !== roleId);
  }
  
  async sendMessage(input: SendMessageInput): Promise<MeetingMessage> {
    const messages = this.messages.get(input.meetingId);
    if (!messages) throw new Error(`Meeting not found: ${input.meetingId}`);
    
    const message: MeetingMessage = {
      id: `msg-${Date.now()}`,
      meetingId: input.meetingId,
      roleId: input.roleId,
      roleName: input.roleId, // 简化实现
      content: input.content,
      stance: input.stance,
      createdAt: new Date().toISOString(),
    };
    
    messages.push(message);
    return message;
  }
  
  async getMessages(meetingId: string): Promise<MeetingMessage[]> {
    return this.messages.get(meetingId) || [];
  }
  
  async addDecision(meetingId: string, decision: Omit<MeetingDecision, 'id' | 'meetingId' | 'createdAt'>): Promise<MeetingDecision> {
    const decisions = this.decisions.get(meetingId);
    if (!decisions) throw new Error(`Meeting not found: ${meetingId}`);
    
    const newDecision: MeetingDecision = {
      id: `decision-${Date.now()}`,
      meetingId,
      ...decision,
      createdAt: new Date().toISOString(),
    };
    
    decisions.push(newDecision);
    return newDecision;
  }
  
  async getDecisions(meetingId: string): Promise<MeetingDecision[]> {
    return this.decisions.get(meetingId) || [];
  }
  
  async saveSummary(meetingId: string, summary: MeetingSummary): Promise<void> {
    const meeting = this.meetings.get(meetingId);
    if (!meeting) throw new Error(`Meeting not found: ${meetingId}`);
    
    meeting.summary = summary;
  }
  
  async startMeeting(id: string): Promise<Meeting> {
    return this.update(id, {
      status: 'running',
      startedAt: new Date().toISOString(),
    });
  }
  
  async endMeeting(id: string): Promise<Meeting> {
    return this.update(id, {
      status: 'ended',
      endedAt: new Date().toISOString(),
    });
  }
}
