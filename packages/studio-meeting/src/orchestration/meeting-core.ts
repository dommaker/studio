/**
 * 会议核心逻辑
 * 
 * 功能：
 * 1. 会议创建、开始、结束
 * 2. 消息发送、决策记录
 * 3. 会议纪要生成（LLM）
 * 4. 多角色协作支持
 * 
 * 架构：
 * - runtime 定义核心逻辑
 * - 通过 MeetingStore 接口访问存储
 * - 无直接依赖 agent-studio
 */

import { EventEmitter } from '@dommaker/studio-shared';
import type {
  MeetingStore,
  Meeting,
  MeetingParticipant,
  MeetingMessage,
  MeetingDecision,
  MeetingSummary,
  CreateMeetingInput,
  SendMessageInput,
} from './meeting-store';

/**
 * 会议核心配置
 */
export interface MeetingCoreConfig {
  store: MeetingStore;
  eventEmitter?: EventEmitter;
  llmEndpoint?: string; // LLM API 端点
}

/**
 * 会议核心逻辑
 */
export class MeetingCore {
  private store: MeetingStore;
  private eventEmitter?: EventEmitter;
  private llmEndpoint: string;
  
  constructor(config: MeetingCoreConfig) {
    this.store = config.store;
    this.eventEmitter = config.eventEmitter;
    this.llmEndpoint = config.llmEndpoint ?? `http://localhost:${process.env.PORT || 3001}/api/v1/llm/chat`;
  }
  
  /**
   * 创建会议
   */
  async createMeeting(input: CreateMeetingInput): Promise<Meeting> {
    const meeting = await this.store.create(input);
    
    this.eventEmitter?.emit('meeting.created', {
      meetingId: meeting.id,
      projectId: meeting.projectId,
      title: meeting.title,
    });
    
    return meeting;
  }
  
  /**
   * 获取会议
   */
  async getMeeting(id: string): Promise<Meeting | null> {
    return this.store.getById(id);
  }
  
  /**
   * 开始会议
   */
  async startMeeting(id: string): Promise<Meeting> {
    const meeting = await this.store.startMeeting(id);
    
    this.eventEmitter?.emit('meeting.started', {
      meetingId: id,
      projectId: meeting.projectId,
      participants: meeting.participants.map(p => p.roleId),
    });
    
    return meeting;
  }
  
  /**
   * 发送消息
   */
  async sendMessage(input: SendMessageInput): Promise<MeetingMessage> {
    const message = await this.store.sendMessage(input);
    
    this.eventEmitter?.emit('meeting.message', {
      meetingId: input.meetingId,
      roleId: input.roleId,
      content: input.content,
      stance: input.stance,
    });
    
    return message;
  }
  
  /**
   * 记录决策
   */
  async recordDecision(
    meetingId: string,
    content: string,
    agreed: boolean,
    roles: string[]
  ): Promise<MeetingDecision> {
    const decision = await this.store.addDecision(meetingId, {
      content,
      agreed,
      roles,
    });
    
    this.eventEmitter?.emit('meeting.decision', {
      meetingId,
      decisionId: decision.id,
      content,
      agreed,
      roles,
    });
    
    return decision;
  }
  
  /**
   * 结束会议并生成纪要
   */
  async endMeeting(id: string): Promise<Meeting> {
    // 获取完整会议数据
    const meeting = await this.store.getById(id);
    if (!meeting) {
      throw new Error(`Meeting not found: ${id}`);
    }
    
    // 生成会议纪要
    const summary = await this.generateSummary(meeting);
    await this.store.saveSummary(id, summary);
    
    // 更新状态
    const endedMeeting = await this.store.endMeeting(id);
    
    this.eventEmitter?.emit('meeting.ended', {
      meetingId: id,
      projectId: meeting.projectId,
      summary: summary.summary,
      decisionCount: summary.decisions.length,
    });
    
    return endedMeeting;
  }
  
  /**
   * 生成会议纪要
   */
  async generateSummary(meeting: Meeting): Promise<MeetingSummary> {
    // 构建讨论内容
    const messagesText = meeting.messages
      .map(m => `[${m.roleName}${m.stance ? `(${m.stance})` : ''}]: ${m.content}`)
      .join('\n\n');
    
    const participants = meeting.participants
      .map(p => p.roleName)
      .join('、');
    
    // 使用 LLM 生成纪要
    const prompt = `请为以下会议生成结构化的会议纪要：

## 会议信息
- 标题：${meeting.title}
- 参与者：${participants}
- 消息数：${meeting.messages.length}

## 讨论内容
${messagesText}

请输出：
1. 会议总结（200字以内）
2. 关键决策点（JSON数组格式，每个决策包含：content-决策内容, agreed-是否达成共识, roles-相关角色）

输出格式：
{
  "summary": "会议总结内容...",
  "decisions": [
    {"content": "决策1", "agreed": true, "roles": ["角色A"]},
    {"content": "决策2", "agreed": false, "roles": ["角色B", "角色C"]}
  ]
}`;
    
    try {
      const response = await fetch(this.llmEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.7,
        }),
      });
      
      if (!response.ok) {
        throw new Error('LLM call failed');
      }
      
      const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content || '';
      
      // 解析 JSON
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          summary: parsed.summary || content.substring(0, 500),
          decisions: (parsed.decisions || []).map((d: any, i: number) => ({
            id: `decision-${i}`,
            meetingId: meeting.id,
            content: d.content,
            agreed: d.agreed,
            roles: d.roles,
            createdAt: new Date().toISOString(),
          })),
          generatedAt: new Date().toISOString(),
        };
      }
      
      // 无法解析，返回纯文本
      return {
        summary: content.substring(0, 500),
        decisions: [],
        generatedAt: new Date().toISOString(),
      };
    } catch (error) {
      console.error('[MeetingCore] Failed to generate summary:', error);
      
      // 降级：返回简单摘要
      return {
        summary: `会议"${meeting.title}"共有${meeting.messages.length}条消息，${meeting.participants.length}位参与者。`,
        decisions: [],
        generatedAt: new Date().toISOString(),
      };
    }
  }
  
  /**
   * 获取项目的所有会议
   */
  async getProjectMeetings(projectId: string): Promise<Meeting[]> {
    return this.store.getByProject(projectId);
  }
  
  /**
   * 获取会议决策
   */
  async getDecisions(meetingId: string): Promise<MeetingDecision[]> {
    return this.store.getDecisions(meetingId);
  }
  
  /**
   * 获取会议消息
   */
  async getMessages(meetingId: string): Promise<MeetingMessage[]> {
    return this.store.getMessages(meetingId);
  }
  
  /**
   * 删除会议
   */
  async deleteMeeting(id: string): Promise<void> {
    await this.store.delete(id);
    
    this.eventEmitter?.emit('meeting.deleted', { meetingId: id });
  }
}

/**
 * 创建会议核心实例（便捷函数）
 */
export function createMeetingCore(config: MeetingCoreConfig): MeetingCore {
  return new MeetingCore(config);
}
