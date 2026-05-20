/**
 * 会议纪要生成服务
 */
import { logger } from './meeting-shared.js';
import fetch from 'node-fetch';

const LLM_SERVICE_URL = 'http://localhost:3001/api/v1/llm/chat';
const SUMMARY_FALLBACK_LENGTH = 500;

interface MeetingMessageWithRole {
  content: string;
  stance?: string;
  Role?: { name: string };
}

interface MeetingParticipantWithRole {
  Role?: { name: string };
}

interface MeetingForSummary {
  title: string;
  MeetingMessage: MeetingMessageWithRole[];
  MeetingParticipant: MeetingParticipantWithRole[];
}

export async function generateMeetingSummary(meeting: MeetingForSummary): Promise<{
  summary: string;
  decisions: Record<string, unknown>[];
  actionItems: Record<string, unknown>[];
  keyFindings: Record<string, unknown>[];
}> {
  const messagesText = (meeting.MeetingMessage || [])
    .map((m) => {
      const roleName = m.Role?.name || '未知';
      const stance = m.stance || 'executor';
      return `[${roleName}(${stance})]: ${m.content}`;
    })
    .join('\n\n');

  const participants = (meeting.MeetingParticipant || [])
    .map((p) => p.Role?.name)
    .filter(Boolean)
    .join('、');

  const prompt = `请为以下会议生成结构化的会议纪要：

## 会议信息
- 标题：${meeting.title}
- 参与者：${participants}
- 消息数：${(meeting.MeetingMessage || []).length}

## 讨论内容
${messagesText}

请输出：
1. 会议总结（200字以内）
2. 关键决策点（JSON数组，每个决策包含：content-决策内容, agreed-是否达成共识, roles-相关角色）
3. 待办事项（JSON数组，每个待办包含：content-任务描述, assignee-建议负责人角色, priority-优先级high/medium/low）
4. 关键发现（JSON数组，每个发现包含：finding-发现内容, importance-重要性1-5, relatedTopic-相关主题）

输出格式：
{
  "summary": "会议总结内容...",
  "decisions": [
    {"content": "决策1", "agreed": true, "roles": ["角色A"]},
    {"content": "决策2", "agreed": false, "roles": ["角色B", "角色C"]}
  ],
  "actionItems": [
    {"content": "待办1", "assignee": "角色A", "priority": "high"}
  ],
  "keyFindings": [
    {"finding": "发现1", "importance": 4, "relatedTopic": "主题"}
  ]
}`;

  try {
    const llmRes = await fetch(LLM_SERVICE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.7,
      }),
    });

    if (!llmRes.ok) {
      throw new Error('LLM call failed');
    }

    const llmData = await llmRes.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = llmData.choices?.[0]?.message?.content || '';

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      return {
        summary: parsed.summary || content.substring(0, SUMMARY_FALLBACK_LENGTH),
        decisions: parsed.decisions || [],
        actionItems: parsed.actionItems || [],
        keyFindings: parsed.keyFindings || [],
      };
    }

    return { summary: content.substring(0, SUMMARY_FALLBACK_LENGTH), decisions: [], actionItems: [], keyFindings: [] };
  } catch (error) {
    logger.error('[Meeting Summary] Generation failed', { error });
    return {
      summary: `会议进行了 ${(meeting.MeetingMessage || []).length} 轮讨论，参与者包括 ${participants}。`,
      decisions: [],
    };
  }
}
