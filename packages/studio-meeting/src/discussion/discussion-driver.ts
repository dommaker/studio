/**
 * 讨论驱动器 - 分组并行发言版本
 * 
 * DD-008 + DD-019: Meeting 自动讨论 + 并行优化
 * AS-009: 争议检查机制（强制分歧）
 * 
 * 功能：
 * 1. 轮次调度（分组并行发言）
 * 2. 共识检查（判断是否达成一致）
 * 3. 用户干预机制（关键决策点）
 * 4. 讨论终止条件（超时/共识/分歧）
 * 5. 🆕 争议检查（防止群体思维）
 */

import { prisma } from '@dommaker/studio-prisma';
import { discussionEventPublisher } from '../events/discussion-events';
import { meetingFileStorage } from './meeting-file-storage';
import { logger } from '@dommaker/studio-shared';

// 立场分类常量（避免重复定义）
const PROPONENT_STANCES = ['advocate', 'pragmatist', 'executor', 'visionary'];
const OPPONENT_STANCES = ['skeptic', 'reviewer', 'architect'];
const NEUTRAL_STANCES = ['neutral'];

/**
 * 讨论驱动器配置
 */
export interface DiscussionDriverConfig {
  llmClient: LLMClientInterface;
  maxRounds?: number;
  consensusThreshold?: number;
  timeoutMs?: number;
  enableParallelGroups?: boolean;  // 🆕 DD-019: 是否启用分组并行发言
  // 🆕 AS-009: 争议检查配置
  enableControversyCheck?: boolean;  // 是否启用争议检查
  minOppositionRatio?: number;       // 最小反对比例（默认 0.2）
  controversyTriggerRounds?: number; // 连续几轮无反对触发（默认 2）
  // 🆕 ROLE-001: 外部立场配置（从 RoleConfig 加载）
  externalStances?: { id: string; name: string; prompt: string; group: string }[];
  // 🆕 BP-001: 公司知识上下文（从 Knowledge Keeper 加载）
  companyKnowledgeContext?: string;
  // 🆕 BP-012: 冷启动（知识库为空时保守策略）
  isColdStart?: boolean;
}

/**
 * 🆕 AS-009: 争议检查结果
 */
export interface ControversyCheckResult {
  hasEnoughDissent: boolean;
  proponentCount: number;
  opponentCount: number;
  neutralCount: number;
  ratio: number;
  consecutiveNoOpposition: number;
  needsIntervention: boolean;
  suggestedAction?: 'inject_devils_advocate' | 'prompt_skeptic' | 'notify_user';
}

/**
 * LLM 客户端接口
 */
export interface LLMClientInterface {
  chat(prompt: string, options?: { temperature?: number }): Promise<string>;
}

/**
 * 角色信息
 */
export interface RoleInfo {
  roleId: string;
  name: string;
  stance: string;
  expertise?: string[];
  speakCount?: number;
}

/**
 * 讨论结果
 */
export interface DiscussionResult {
  status: 'consensus' | 'pending_user' | 'max_rounds' | 'divergence' | 'timeout';
  round: number;
  decisions?: Decision[];
  pendingQuestions?: string[];
  summary?: string;
  durationMs?: number;
}

/**
 * 🆕 AS-015: 投票记录
 */
export interface VoteRecord {
  roleId: string;
  stance: string;
  agree: boolean;
  comment?: string;
}

/**
 * 决策
 */
export interface Decision {
  content: string;
  agreed: boolean;
  priority?: 'high' | 'medium' | 'low';
  // 🆕 AS-015: 投票详情
  votes?: VoteRecord[];
  agreement?: 'unanimous' | 'majority' | 'divided';
}

/**
 * 共识检查结果
 */
export interface ConsensusResult {
  reached: boolean;
  decisions: Decision[];
  disagreements: string[];
  confidence: number;
  // 🆕 AS-015: 共识类型
  agreement: 'unanimous' | 'majority' | 'divided';
  // 🆕 AS-015: 投票统计
  voteStats?: {
    agree: number;
    disagree: number;
    neutral: number;
    total: number;
  };
}

/**
 * 讨论驱动器
 */
export class DiscussionDriver {
  private llmClient: LLMClientInterface;
  private maxRounds: number;
  private consensusThreshold: number;
  private timeoutMs: number;
  private enableParallelGroups: boolean;
  // 🆕 AS-009: 争议检查配置
  private enableControversyCheck: boolean;
  private minOppositionRatio: number;
  private controversyTriggerRounds: number;

  private config: DiscussionDriverConfig;

  constructor(config: DiscussionDriverConfig) {
    this.config = config;
    this.llmClient = config.llmClient;
    this.maxRounds = config.maxRounds ?? 10;
    this.consensusThreshold = config.consensusThreshold ?? 0.8;
    this.timeoutMs = config.timeoutMs ?? 300000; // 5分钟
    this.enableParallelGroups = config.enableParallelGroups ?? true;
    // 🆕 AS-009
    this.enableControversyCheck = config.enableControversyCheck ?? true;
    this.minOppositionRatio = config.minOppositionRatio ?? 0.2; // 20% 反对意见
    this.controversyTriggerRounds = config.controversyTriggerRounds ?? 2; // 连续2轮
  }

  /**
   * 运行讨论（支持分组并行发言）
   */
  async runDiscussion(meetingId: string, topic: string): Promise<DiscussionResult> {
    const startTime = Date.now();

    logger.info('DiscussionDriver starting', { meetingId, topic, maxRounds: this.maxRounds, parallel: this.enableParallelGroups });

    // 发布开始事件
    await discussionEventPublisher.publishStarted(meetingId, topic);

    // 获取参与者
    const participants = await this.getParticipants(meetingId);
    
    if (participants.length === 0) {
      return {
        status: 'divergence',
        round: 0,
        summary: '会议无参与者',
        durationMs: Date.now() - startTime,
      };
    }

    // 获取历史消息
    const messages = await this.getMessages(meetingId);
    let round = messages.length > 0 ? Math.max(...messages.map(m => m.round)) : 0;

    // 🆕 DD-019: 分组并行发言
    // 🆕 BP-012: 冷启动时优先串行（更保守，避免分组错误）
    if (this.enableParallelGroups && participants.length >= 3 && !this.config.isColdStart) {
      logger.info('Using parallel group discussion mode', { participantCount: participants.length });
      return await this.runParallelGroupDiscussion(meetingId, topic, participants, messages, round, startTime);
    }
    if (this.config.isColdStart) {
      logger.info('Cold start — using sequential discussion for conservative debate', { participantCount: participants.length });
    }

    // Fallback: 串行发言（兼容旧模式）
    logger.info('Using sequential discussion mode', { participantCount: participants.length });
    return await this.runSequentialDiscussion(meetingId, topic, participants, messages, round, startTime);
  }

  /**
   * 🆕 DD-019: 分组并行讨论
   */
  private async runParallelGroupDiscussion(
    meetingId: string,
    topic: string,
    participants: RoleInfo[],
    messages: Array<{ roleId: string; content: string; stance: string; round: number }>,
    startRound: number,
    startTime: number
  ): Promise<DiscussionResult> {
    // 分组（赞成方、反对方、中立方）
    const groups = this.groupParticipantsByStance(participants);
    
    logger.info('Participants grouped', { 
      proponents: groups.proponents.length,
      opponents: groups.opponents.length,
      neutral: groups.neutral.length,
    });

    let round = startRound;

    while (round < this.maxRounds) {
      // 检查超时
      if (Date.now() - startTime > this.timeoutMs) {
        await discussionEventPublisher.publishTimeout(meetingId, Date.now() - startTime);
        return await this.createResult(meetingId, 'timeout', round, startTime);
      }

      round++;
      logger.info(`Round ${round} starting`, { groups: Object.keys(groups).map(k => `${k}:${groups[k as keyof SpeakerGroups].length}`) });

      // 🆕 并行发言：赞成方和反对方同时发言
      const parallelResults = await this.executeParallelGroupRound(
        meetingId,
        topic,
        groups,
        messages,
        round
      );

      // 刷新消息列表
      messages = await this.getMessages(meetingId);

      // 发布轮次完成事件
      await discussionEventPublisher.publishRoundCompleted(meetingId, round, parallelResults.totalMessages);

      // 🆕 AS-009: 争议检查（防止群体思维）
      if (this.enableControversyCheck) {
        const controversy = this.checkControversy(messages, round);
        
        if (controversy.needsIntervention) {
          logger.warn('Controversy check triggered', { 
            meetingId, 
            round, 
            ratio: controversy.ratio,
            consecutiveNoOpposition: controversy.consecutiveNoOpposition,
            action: controversy.suggestedAction,
          });

          // 根据建议行动
          if (controversy.suggestedAction === 'inject_devils_advocate') {
            await this.injectDevilsAdvocate(meetingId, topic, messages, round);
            // 刷新消息列表（包含新注入的消息）
            messages = await this.getMessages(meetingId);
          } else if (controversy.suggestedAction === 'prompt_skeptic') {
            await this.promptSkepticToSpeak(meetingId, topic, messages, groups.opponents, round);
            messages = await this.getMessages(meetingId);
          } else if (controversy.suggestedAction === 'notify_user') {
            await discussionEventPublisher.publishUserInterventionNeeded(
              meetingId,
              round,
              `讨论缺乏反对意见（反对比例 ${(controversy.ratio * 100).toFixed(0)}%），建议引入质疑观点`
            );
          }
        }
      }

      // 检查共识（每 3 轮检查一次）
      if (round >= 3 && round % 3 === 0) {
        const consensus = await this.checkConsensus(messages, topic);

        if (consensus.reached && consensus.confidence >= this.consensusThreshold) {
          await discussionEventPublisher.publishConsensusReached(
            meetingId,
            round,
            consensus.decisions.length,
            consensus.confidence
          );

          return await this.createResult(meetingId, 'consensus', round, startTime, consensus);
        }

        if (consensus.disagreements.length >= 3) {
          await discussionEventPublisher.publishUserInterventionNeeded(
            meetingId,
            round,
            '分歧过多，需要用户决策'
          );

          return await this.createResult(meetingId, 'pending_user', round, startTime, consensus, consensus.disagreements);
        }
      }
    }

    // 🆕 AS-015: 强制裁决机制
    // 达到 maxRounds 但未达成共识，调用 decider 做最终决定
    await discussionEventPublisher.publishMaxRoundsReached(meetingId, round);
    
    const finalDecision = await this.executeFinalDecision(meetingId, topic, messages, round);
    
    return await this.createResult(meetingId, 'consensus', round, startTime, finalDecision);
  }

  /**
   * 🆕 AS-015: 强制裁决（decider 最终决定）
   */
  private async executeFinalDecision(
    meetingId: string,
    topic: string,
    messages: Array<{ roleId: string; content: string; stance: string; round: number }>,
    round: number
  ): Promise<ConsensusResult> {
    logger.info('Executing final decision by decider', { meetingId, round });

    // 获取所有参与者
    const participants = await this.getParticipants(meetingId);
    
    // 找到 decider 角色
    let decider = participants.find(p => p.stance === 'decider' || p.stance === 'executor');
    if (!decider) {
      // 如果没有 decider，选择发言最多的角色作为裁决者
      const sortedBySpeakCount = participants.sort((a, b) => (b.speakCount ?? 0) - (a.speakCount ?? 0));
      decider = sortedBySpeakCount[0];
    }

    // 构建裁决 prompt
    const keyDiscussion = messages.slice(-10).map(m => 
      `[${m.roleId}(${m.stance})]: ${m.content.slice(0, 200)}`
    ).join('\n');

    const prompt = `你现在是会议的最终裁决者"${decider.name}"。

## 会议主题
${topic}

## 讨论历史（最近10条）
${keyDiscussion}

## 裁决任务
讨论已达到最大轮次，但未能达成共识。作为裁决者，你需要：
1. 总结各方核心观点
2. 权衡利弊后做出最终决定
3. 说明裁决理由

## 输出格式（JSON）
{
  "summary": "讨论总结",
  "finalDecision": "最终决策内容",
  "rationale": "裁决理由",
  "priority": "high|medium|low"
}

请输出 JSON（不要包含 markdown）：`;

    const result = await this.llmClient.chat(prompt, { temperature: 0.3 });

    try {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        
        // 发送裁决消息
        await this.sendMeetingMessage(
          meetingId, 
          decider.roleId, 
          `【最终裁决】${parsed.finalDecision}\n\n理由：${parsed.rationale}`, 
          round + 1
        );

        return {
          reached: true,
          decisions: [{
            content: parsed.finalDecision,
            agreed: true,
            priority: parsed.priority ?? 'high',
            agreement: 'majority',
          }],
          disagreements: [],
          confidence: 0.9,
          agreement: 'majority',
        };
      }
    } catch (e) {
      logger.error('Failed to parse final decision', { error: String(e) });
    }

    // 解析失败，返回未达成
    return { 
      reached: false, 
      decisions: [], 
      disagreements: ['裁决解析失败'], 
      confidence: 0,
      agreement: 'divided',
    };
  }

  /**
   * 🆕 DD-019: 执行一轮分组并行发言
   */
  private async executeParallelGroupRound(
    meetingId: string,
    topic: string,
    groups: SpeakerGroups,
    messages: Array<{ roleId: string; content: string; stance: string; round: number }>,
    round: number
  ): Promise<{ totalMessages: number; proponentMessages: number; opponentMessages: number }> {
    // 选择发言角色（发言最少的优先）
    const proponentSpeaker = this.selectSpeakerByCount(groups.proponents);
    const opponentSpeaker = this.selectSpeakerByCount(groups.opponents);

    const speakersToExecute: RoleInfo[] = [];
    if (proponentSpeaker) speakersToExecute.push(proponentSpeaker);
    if (opponentSpeaker) speakersToExecute.push(opponentSpeaker);

    // 中立方每 2 轮发言一次
    if (round % 2 === 0 && groups.neutral.length > 0) {
      const neutralSpeaker = this.selectSpeakerByCount(groups.neutral);
      if (neutralSpeaker) speakersToExecute.push(neutralSpeaker);
    }

    logger.info('Executing parallel round', { round, speakers: speakersToExecute.map(r => r.name) });

    // 🆕 并行调用 LLM
    const llmPromises = speakersToExecute.map(async (role) => {
      const prompt = await this.buildSpeakerPrompt(role, topic, messages, round, meetingId);
      try {
        const content = await this.llmClient.chat(prompt, { temperature: 0.7 });
        return { role, content, success: true };
      } catch (error) {
        logger.error('LLM call failed for role', { roleId: role.roleId, error: String(error) });
        return { role, content: '（发言失败，请稍后重试）', success: false };
      }
    });

    // 等待所有 LLM 完成（并行执行）
    const results = await Promise.all(llmPromises);

    // 批量发送消息
    const messagesToSend = results.filter(r => r.success).map(r => ({
      meetingId,
      roleId: r.role.roleId,
      content: r.content,
      round,
      stance: r.role.stance,
    }));

    await this.sendMeetingMessagesBatch(messagesToSend);

    // 更新发言计数
    for (const result of results) {
      result.role.speakCount = (result.role.speakCount ?? 0) + 1;
    }

    // 发布发言事件
    for (const result of results) {
      await discussionEventPublisher.publishMessageSent(
        meetingId,
        round,
        result.role.roleId,
        result.content.length
      );
    }

    return {
      totalMessages: results.length,
      proponentMessages: proponentSpeaker ? 1 : 0,
      opponentMessages: opponentSpeaker ? 1 : 0,
    };
  }

  /**
   * 🆕 DD-019: 分组参与者（按立场）
   */
  private groupParticipantsByStance(participants: RoleInfo[]): SpeakerGroups {
    const proponents: RoleInfo[] = [];  // 赞成方
    const opponents: RoleInfo[] = [];   // 反对方/质疑方
    const neutral: RoleInfo[] = [];     // 中立方

    for (const p of participants) {
      const stance = p.stance.toLowerCase();

      if (PROPONENT_STANCES.includes(stance)) {
        proponents.push(p);
      } else if (OPPONENT_STANCES.includes(stance)) {
        opponents.push(p);
      } else {
        neutral.push(p);
      }
    }

    return { proponents, opponents, neutral };
  }

  /**
   * 🆕 DD-019: 按发言次数选择发言人（少的优先）
   */
  private selectSpeakerByCount(roles: RoleInfo[]): RoleInfo | null {
    if (roles.length === 0) return null;
    
    const sorted = roles.sort((a, b) => (a.speakCount ?? 0) - (b.speakCount ?? 0));
    return sorted[0];
  }

  /**
   * 🆕 DD-019: 批量发送会议消息
   */
  private async sendMeetingMessagesBatch(
    messages: Array<{ meetingId: string; roleId: string; content: string; round: number; stance: string }>
  ): Promise<void> {
    if (messages.length === 0) return;

    // 获取 participant IDs
    const participantMap = new Map<string, string>();
    for (const msg of messages) {
      if (!participantMap.has(msg.roleId)) {
        const participant = await prisma.meetingParticipant.findFirst({
          where: { meetingId: msg.meetingId, roleId: msg.roleId },
        });
        if (participant) {
          participantMap.set(msg.roleId, participant.id);
        }
      }
    }

    // 批量创建
    const createData = messages.map(msg => ({
      meetingId: msg.meetingId,
      participantId: participantMap.get(msg.roleId) || '',
      roleId: msg.roleId,
      content: msg.content,
      messageType: 'speech',
      stance: msg.stance,
      round: msg.round,
    }));

    await prisma.meetingMessage.createMany({ data: createData, skipDuplicates: true });

    // 🆕 检测 @human — AI 角色请求人类介入
    for (const msg of messages) {
      if (msg.content.includes('@human') || msg.content.includes('@人类')) {
        await discussionEventPublisher.publishUserInterventionNeeded(
          msg.meetingId,
          msg.round,
          `[${msg.roleId}(${msg.stance})] 请求你的决策: ${msg.content.slice(0, 200)}`
        );
      }
    }
  }

  /**
   * 串行讨论（兼容旧模式）
   */
  private async runSequentialDiscussion(
    meetingId: string,
    topic: string,
    participants: RoleInfo[],
    messages: Array<{ roleId: string; content: string; stance: string; round: number }>,
    startRound: number,
    startTime: number
  ): Promise<DiscussionResult> {
    let round = startRound;

    while (round < this.maxRounds) {
      if (Date.now() - startTime > this.timeoutMs) {
        await discussionEventPublisher.publishTimeout(meetingId, Date.now() - startTime);
        return await this.createResult(meetingId, 'timeout', round, startTime);
      }

      const role = await this.selectNextSpeaker(participants, messages, round);
      round++;

      await discussionEventPublisher.publishSpeakerSelected(meetingId, round, role.roleId, `轮次调度`);

      const prompt = await this.buildSpeakerPrompt(role, topic, messages, round, meetingId);
      const content = await this.llmClient.chat(prompt, { temperature: 0.7 });

      await this.sendMeetingMessage(meetingId, role.roleId, content, round);
      await discussionEventPublisher.publishMessageSent(meetingId, round, role.roleId, content.length);

      // DD-014: 更新会议进度
      await this.updateProgress(meetingId, round, role.name || role.roleId, content);

      role.speakCount = (role.speakCount ?? 0) + 1;
      messages = await this.getMessages(meetingId);

      if (round >= 3 && round % 3 === 0) {
        const consensus = await this.checkConsensus(messages, topic);

        if (consensus.reached && consensus.confidence >= this.consensusThreshold) {
          await discussionEventPublisher.publishConsensusReached(meetingId, round, consensus.decisions.length, consensus.confidence);
          return await this.createResult(meetingId, 'consensus', round, startTime, consensus);
        }

        if (consensus.disagreements.length >= 3) {
          await discussionEventPublisher.publishUserInterventionNeeded(meetingId, round, '分歧过多，需要用户决策');
          return await this.createResult(meetingId, 'pending_user', round, startTime, consensus, consensus.disagreements);
        }
      }
    }

    // 🆕 AS-015: 强制裁决机制
    await discussionEventPublisher.publishMaxRoundsReached(meetingId, round);
    const finalDecision = await this.executeFinalDecision(meetingId, topic, messages, round);
    return await this.createResult(meetingId, 'consensus', round, startTime, finalDecision);
  }

  /**
   * 获取参与者
   */
  private async getParticipants(meetingId: string): Promise<RoleInfo[]> {
    const participants = await prisma.meetingParticipant.findMany({
      where: { meetingId },
      include: { Role: true },
    });

    return participants.map(p => ({
      roleId: p.roleId,
      name: p.Role?.name || 'Unknown',
      stance: p.stance,
      expertise: [],
      speakCount: 0,
    }));
  }

  /**
   * 获取消息
   */
  private async getMessages(meetingId: string): Promise<Array<{
    roleId: string;
    content: string;
    stance: string;
    round: number;
  }>> {
    const messages = await prisma.meetingMessage.findMany({
      where: { meetingId },
      orderBy: { createdAt: 'asc' },
    });

    return messages.map(m => ({
      roleId: m.roleId,
      content: m.content,
      stance: m.stance || 'executor',
      round: m.round,
    }));
  }

  /**
   * 选择下一个发言角色（串行模式）
   */
  private async selectNextSpeaker(
    participants: RoleInfo[],
    messages: Array<{ roleId: string; content: string; stance: string; round: number }>,
    currentRound: number
  ): Promise<RoleInfo> {
    const speakCounts = new Map<string, number>();
    for (const p of participants) {
      speakCounts.set(p.roleId, 0);
    }
    for (const m of messages) {
      speakCounts.set(m.roleId, (speakCounts.get(m.roleId) ?? 0) + 1);
    }

    for (const p of participants) {
      p.speakCount = speakCounts.get(p.roleId) ?? 0;
    }

    // 质疑者优先
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && (lastMessage.stance === 'advocate' || lastMessage.stance === 'executor')) {
      const skepticStances = ['skeptic', 'reviewer', 'architect'];
      for (const p of participants) {
        if (skepticStances.includes(p.stance)) {
          return p;
        }
      }
    }

    // 发言最少的优先
    const sortedBySpeakCount = participants.sort((a, b) => 
      (a.speakCount ?? 0) - (b.speakCount ?? 0)
    );

    return sortedBySpeakCount[0];
  }

  /**
   * 构建发言 prompt
   */
  private async buildSpeakerPrompt(
    role: RoleInfo,
    topic: string,
    messages: Array<{ roleId: string; content: string; stance: string; round: number }>,
    round: number,
    meetingId: string
  ): Promise<string> {
    const recentMessages = messages.slice(-10);
    const stancePrompt = this.getStancePrompt(role.stance);
    const keyMessages = this.getKeyMessages(messages);
    const projectContext = await this.getProjectContext(meetingId);

    return `你现在是会议室中的"${role.name}"角色，你的立场是"${role.stance}"。

## 你的立场要求
${stancePrompt}

## 会议主题
${topic}
${projectContext ? '\n' + projectContext : ''}
${this.config.companyKnowledgeContext ? '\n' + this.config.companyKnowledgeContext : ''}

## 关键讨论
${keyMessages.length > 0 
  ? keyMessages.map(m => `[${m.roleId}(${m.stance})]: ${m.content}`).join('\n')
  : '暂无讨论历史'}

## 当前轮次
第 ${round} 轮 / 共 ${this.maxRounds} 轮

## 🆕 AS-015: 多轮收敛引导
${round >= this.maxRounds * 0.7 
  ? '⚠️ 讨论接近尾声，请尝试缩小分歧、聚焦核心问题。'
  : round >= this.maxRounds * 0.5 
    ? '💡 讨论进入中后期，请尝试提出具体建议而非抽象观点。'
    : ''}

## 你的任务
根据你的立场，发表你的观点。注意：
1. 保持立场一致性
2. 如果有不同意见，礼貌地提出质疑
3. 如果遇到需要人类做决策的问题（技术选型、架构取舍、产品方向），在消息末尾加上 @human 并给出清晰的可选方案
3. 如果同意某个观点，可以补充证据
4. 发言要简洁有力（100-200字）
5. 如果认为讨论已经成熟，可以提议"总结决策"

请直接输出你的发言内容（不要包含角色名和标记）：`;
  }

  /**
   * 提取关键消息（最小上下文）
   */
  private getKeyMessages(
    messages: Array<{ roleId: string; content: string; stance: string; round: number }>
  ): Array<{ roleId: string; content: string; stance: string; round: number }> {
    if (messages.length === 0) return [];

    const keyMessages: Array<{ roleId: string; content: string; stance: string; round: number }> = [];

    // 首轮发言
    const firstRoundMessages = messages.filter(m => m.round === 1);
    if (firstRoundMessages.length > 0) keyMessages.push(firstRoundMessages[0]);

    // 最后一条消息
    if (messages.length > 1) {
      const lastMessage = messages[messages.length - 1];
      if (!keyMessages.some(m => m.roleId === lastMessage.roleId && m.round === lastMessage.round)) {
        keyMessages.push(lastMessage);
      }
    }

    // 有"总结决策"提议的消息
    for (const m of messages) {
      if (m.content.includes('总结决策') || m.content.includes('总结一下')) {
        if (!keyMessages.some(k => k.roleId === m.roleId && k.round === m.round)) {
          keyMessages.push(m);
        }
      }
    }

    // 质疑/反对的消息
    const skepticMessages = messages.filter(m => m.stance === 'skeptic' || m.stance === 'reviewer');
    for (const m of skepticMessages.slice(0, 2)) {
      if (!keyMessages.some(k => k.roleId === m.roleId && k.round === m.round)) {
        keyMessages.push(m);
      }
    }

    return keyMessages.sort((a, b) => a.round - b.round);
  }

  /**
   * 获取立场 prompt
   */
  private getStancePrompt(stance: string): string {
    // 如果提供了外部立场配置，优先使用
    if (this.config.externalStances?.length) {
      const external = this.config.externalStances.find(s => s.id === stance);
      if (external) return external.prompt;
    }

    // 硬编码兜底
    const stancePrompts: Record<string, string> = {
      advocate: '你是方案的倡导者，你需要论证方案的可行性，提供证据和例子。',
      skeptic: '你是方案的质疑者，你需要找出潜在问题，提出替代方案或改进建议。',
      neutral: '你是中立的观察者，你需要客观分析各方观点，指出关键假设和风险。',
      pragmatist: '你是实用主义者，你关注实施成本、时间线和可行性。',
      visionary: '你是远见者，你关注长期影响、战略价值和未来可能性。',
      executor: '你是执行者，你关注具体任务、责任分配和验收标准。',
      reviewer: '你是审查者，你需要确保质量和合规性。',
      architect: '你是架构师，你需要评估技术方案的架构影响。',
    };

    return stancePrompts[stance] || stancePrompts.executor;
  }

  /**
   * 发送会议消息（单条）
   */
  private async sendMeetingMessage(
    meetingId: string,
    roleId: string,
    content: string,
    round: number
  ): Promise<void> {
    const participant = await prisma.meetingParticipant.findFirst({
      where: { meetingId, roleId },
    });

    if (!participant) {
      throw new Error(`Role ${roleId} not in meeting ${meetingId}`);
    }

    await prisma.meetingMessage.create({
      data: {
        meetingId,
        participantId: participant.id,
        roleId,
        content,
        messageType: 'speech',
        stance: participant.stance,
        round,
      },
    });
  }

  /**
   * 检查共识
   * 
   * 🆕 AS-015: 增加 agreement 类型和 votes 详情
   */
  private async checkConsensus(
    messages: Array<{ roleId: string; content: string; stance: string; round: number }>,
    topic: string
  ): Promise<ConsensusResult> {
    if (messages.length < 3) {
      return { reached: false, decisions: [], disagreements: [], confidence: 0, agreement: 'divided' };
    }

    // 统计投票
    const votes: VoteRecord[] = messages.map(m => ({
      roleId: m.roleId,
      stance: m.stance,
      agree: PROPONENT_STANCES.includes(m.stance.toLowerCase()),
      comment: m.content.slice(0, 100),
    }));

    const agreeCount = votes.filter(v => v.agree).length;
    const disagreeCount = votes.filter(v => !v.agree && !NEUTRAL_STANCES.includes(v.stance.toLowerCase())).length;
    const neutralCount = votes.filter(v => NEUTRAL_STANCES.includes(v.stance.toLowerCase())).length;
    const total = votes.length;
    
    // 🆕 AS-015: 计算共识类型
    let agreement: 'unanimous' | 'majority' | 'divided' = 'divided';
    if (disagreeCount === 0 && neutralCount === 0) {
      agreement = 'unanimous';
    } else if (agreeCount / total >= 0.6) {
      agreement = 'majority';
    }

    const prompt = `分析以下讨论，判断是否达成共识：

## 会议主题
${topic}

## 讨论记录
${messages.map(m => `[${m.roleId}(${m.stance})]: ${m.content}`).join('\n')}

## 当前投票统计
- 赞成: ${agreeCount} 票
- 反对: ${disagreeCount} 票
- 中立: ${neutralCount} 票

## 输出格式（JSON）
{
  "reached": boolean,
  "decisions": [{"content": "...", "agreed": true, "priority": "high|medium|low"}],
  "disagreements": ["问题描述"],
  "confidence": 0-1
}

请输出 JSON（不要包含 markdown）：`;

    const result = await this.llmClient.chat(prompt, { temperature: 0.3 });

    try {
      const jsonMatch = result.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        return {
          reached: parsed.reached ?? false,
          decisions: (parsed.decisions ?? []).map((d: { content: string; agreed: boolean; priority?: 'high' | 'medium' | 'low' }) => ({
            ...d,
            votes,
            agreement,
          })),
          disagreements: parsed.disagreements ?? [],
          confidence: parsed.confidence ?? 0,
          agreement,
          voteStats: { agree: agreeCount, disagree: disagreeCount, neutral: neutralCount, total },
        };
      }
    } catch (e) {
      logger.error('Failed to parse consensus', { error: String(e) });
    }

    return { reached: false, decisions: [], disagreements: [], confidence: 0, agreement: 'divided' };
  }

  /**
   * 创建结果
   */
  private async createResult(
    meetingId: string,
    status: DiscussionResult['status'],
    round: number,
    startTime: number,
    consensus?: ConsensusResult,
    pendingQuestions?: string[]
  ): Promise<DiscussionResult> {
    const result: DiscussionResult = {
      status,
      round,
      durationMs: Date.now() - startTime,
    };

    if (consensus) {
      result.decisions = consensus.decisions;
      result.summary = this.summarizeConsensus(consensus);
    }

    if (pendingQuestions) {
      result.pendingQuestions = pendingQuestions;
    }

    // 文件持久化
    const saveReason = status === 'consensus' ? 'consensus' : 
                       status === 'timeout' ? 'stopped' : 
                       status === 'max_rounds' ? 'completed' : 'stopped';
    
    try {
      await meetingFileStorage.saveMeetingToFile(meetingId, saveReason);
    } catch (e) {
      logger.error('Failed to save meeting to file', { error: String(e) });
    }

    return result;
  }

  /**
   * 总结共识
   */
  private summarizeConsensus(consensus: ConsensusResult): string {
    const parts: string[] = [];

    if (consensus.decisions.length > 0) {
      parts.push(`达成 ${consensus.decisions.length} 个决策`);
    }

    if (consensus.disagreements.length > 0) {
      parts.push(`${consensus.disagreements.length} 个分歧待解决`);
    }

    parts.push(`置信度 ${(consensus.confidence * 100).toFixed(0)}%`);

    return parts.join('，');
  }

  // ========================================
  // 🆕 AS-009: 争议检查机制
  // ========================================

  /**
   * 争议检查
   * 
   * 监控赞成/反对比例，防止群体思维
   * 
   * @param messages 讨论消息
   * @param currentRound 当前轮次
   * @returns 争议检查结果
   */
  private checkControversy(
    messages: Array<{ roleId: string; content: string; stance: string; round: number }>,
    currentRound: number
  ): ControversyCheckResult {
    // 统计各立场发言数
    const proponentCount = messages.filter(m => PROPONENT_STANCES.includes(m.stance.toLowerCase())).length;
    const opponentCount = messages.filter(m => OPPONENT_STANCES.includes(m.stance.toLowerCase())).length;
    const neutralCount = messages.filter(m => NEUTRAL_STANCES.includes(m.stance.toLowerCase())).length;

    const total = proponentCount + opponentCount + neutralCount;
    const ratio = total > 0 ? opponentCount / total : 0;

    // 计算连续无反对轮次
    let consecutiveNoOpposition = 0;
    for (let r = currentRound; r >= currentRound - this.controversyTriggerRounds && r > 0; r--) {
      const roundMessages = messages.filter(m => m.round === r);
      const hasOpposition = roundMessages.some(m => OPPONENT_STANCES.includes(m.stance.toLowerCase()));
      if (!hasOpposition) {
        consecutiveNoOpposition++;
      } else {
        break;
      }
    }

    // 判断是否需要干预
    const needsIntervention = 
      ratio < 0.1 ||  // 反对比例低于 10%
      consecutiveNoOpposition >= this.controversyTriggerRounds;  // 连续 N 轮无反对

    // 建议行动
    let suggestedAction: 'inject_devils_advocate' | 'prompt_skeptic' | 'notify_user' | undefined;
    if (consecutiveNoOpposition >= this.controversyTriggerRounds) {
      suggestedAction = 'inject_devils_advocate';
    } else if (ratio < 0.1 && opponentCount === 0) {
      suggestedAction = 'prompt_skeptic';
    } else if (ratio < this.minOppositionRatio) {
      suggestedAction = 'notify_user';
    }

    return {
      hasEnoughDissent: ratio >= this.minOppositionRatio,
      proponentCount,
      opponentCount,
      neutralCount,
      ratio,
      consecutiveNoOpposition,
      needsIntervention,
      suggestedAction,
    };
  }

  /**
   * 强制分歧（注入 Devil's Advocate）
   * 
   * 当讨论过于一致时，自动引入质疑观点
   */
  private async injectDevilsAdvocate(
    meetingId: string,
    topic: string,
    messages: Array<{ roleId: string; content: string; stance: string; round: number }>,
    round: number
  ): Promise<void> {
    logger.info('Injecting Devil\'s Advocate', { meetingId, round });

    // 构建质疑 prompt
    const recentMessages = messages.slice(-5);
    const recentContent = recentMessages.map(m => 
      `[${m.roleId}(${m.stance})]: ${m.content.slice(0, 200)}`
    ).join('\n');

    const prompt = `作为"魔鬼代言人"（Devil's Advocate），请对以下观点提出质疑。

## 讨论主题
${topic}

## 最近观点（过于一致）
${recentContent || '暂无讨论'}

## 你的任务
1. 找出假设中的漏洞和潜在问题
2. 提出替代方案或改进建议
3. 指出可能被忽略的风险
4. 质疑"理所当然"的决策

注意：你的质疑要具体、有建设性，不是为了反对而反对。

请直接输出质疑内容（100-200字）：`;

    // 调用 LLM 生成质疑
    const content = await this.llmClient.chat(prompt, { temperature: 0.9 });

    // 发送消息（标记为 devil's advocate）
    await prisma.meetingMessage.create({
      data: {
        meetingId,
        participantId: 'devils-advocate',  // 虚拟参与者
        roleId: 'devils-advocate',
        content,
        messageType: 'controversy_injection',  // 🆕 AS-009: 标记争议注入
        stance: 'skeptic',
        round,
      },
    });

    // 发布事件
    await discussionEventPublisher.publishControversyInjected(meetingId, round, content);

    logger.info('Devil\'s Advocate message sent', { meetingId, round, contentLength: content.length });
  }

  /**
   * 提醒质疑者发言
   * 
   * 当有质疑者角色但未发言时，提示其发言
   */
  private async promptSkepticToSpeak(
    meetingId: string,
    topic: string,
    messages: Array<{ roleId: string; content: string; stance: string; round: number }>,
    participants: RoleInfo[],
    round: number
  ): Promise<void> {
    // 找出质疑者角色
    const skeptics = participants.filter(p => OPPONENT_STANCES.includes(p.stance.toLowerCase()));
    
    if (skeptics.length === 0) {
      // 没有质疑者，直接注入 Devil's Advocate
      await this.injectDevilsAdvocate(meetingId, topic, messages, round);
      return;
    }

    // 选择发言最少的质疑者
    const skeptic = skeptics.sort((a, b) => (a.speakCount ?? 0) - (b.speakCount ?? 0))[0];

    logger.info('Prompting skeptic to speak', { meetingId, round, skepticId: skeptic.roleId });

    // 构建提示 prompt
    const recentMessages = messages.slice(-5);
    const prompt = `你是会议室中的"${skeptic.name}"角色，你的立场是"${skeptic.stance}"（质疑者）。

## 会议主题
${topic}

## 最近观点
${recentMessages.map(m => `[${m.roleId}(${m.stance})]: ${m.content.slice(0, 150)}`).join('\n')}

## ⚠️ 提醒
讨论中缺乏质疑和反对意见。作为质疑者，你需要：
1. 检查假设是否合理
2. 提出潜在问题和风险
3. 提供替代观点

请发表你的质疑（100-200字）：`;

    const content = await this.llmClient.chat(prompt, { temperature: 0.8 });

    await this.sendMeetingMessage(meetingId, skeptic.roleId, content, round);
    
    await discussionEventPublisher.publishMessageSent(meetingId, round, skeptic.roleId, content.length);
  }

  /**
   * DD-013: 获取项目上下文
   * 查询 Meeting 关联的 Project，构建包含 PMO 编号、名称、状态的上下文字符串
   */
  private async getProjectContext(meetingId: string): Promise<string> {
    try {
      const meeting = await prisma.meeting.findUnique({
        where: { id: meetingId },
        select: { projectId: true, outputProjectId: true },
      });
      const projectId = meeting?.projectId || meeting?.outputProjectId;
      if (!projectId) return '';

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { pmoNumber: true, title: true, status: true, description: true },
      });
      if (!project) return '';

      return [
        `## 关联项目`,
        `- PMO 编号: ${project.pmoNumber}`,
        `- 项目名称: ${project.title}`,
        project.description ? `- 描述: ${project.description}` : '',
        `- 状态: ${project.status}`,
      ].filter(Boolean).join('\n');
    } catch {
      return ''; // 非致命，获取失败不影响讨论
    }
  }

  /**
   * DD-014: 更新会议进度
   * 每轮发言后由 DiscussionDriver 调用，更新 Meeting.progress 和 currentTask
   */
  private async updateProgress(
    _meetingId: string,
    _round: number,
    _speaker: string,
    _content: string,
  ): Promise<void> {
    // DD-014: progress/currentTask 字段待 DB 迁移完成后启用
    // 当前 Prisma schema 中 Meeting 模型暂无这两个字段
  }
}

/**
 * 发言组（用于分组）
 */
interface SpeakerGroups {
  proponents: RoleInfo[];   // 赞成方
  opponents: RoleInfo[];    // 反对方
  neutral: RoleInfo[];      // 中立方
}

/**
 * 创建讨论驱动器
 */
export function createDiscussionDriver(config: DiscussionDriverConfig): DiscussionDriver {
  return new DiscussionDriver(config);
}