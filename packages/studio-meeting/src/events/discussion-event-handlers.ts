/**
 * Discussion 事件处理器
 * 
 * DD-007/DD-008: 监听 discussion.auto_start 事件并启动 DiscussionDriver
 * DD-009: 监听 discussion.user_intervention_needed 事件并发送通知
 * AS-011: Meeting → Project 自动关联增强
 */

import { DiscussionEvent, discussionEventSubscriber, discussionEventPublisher } from './discussion-events';
import { prisma } from '@dommaker/studio-prisma';
import { DiscussionDriver, createDiscussionDriver, LLMClientInterface } from '../discussion/discussion-driver';
import { assessMeetingRisk, type RiskAssessment } from '../services/risk-assessor';  // 🆕 风险评估
import { buildRequirementsDocPrompt, parseRequirementsDoc, correctFileConflicts } from '../services/requirements-doc';  // 🆕 BP-002: LLM 聚合 + 冲突修正
import { knowledgeKeeper, recordDecision, memoryStore, logger } from '@dommaker/studio-shared';  // 🆕 BP-001: Knowledge Keeper + 审计
import * as fs from 'fs/promises';  // 🆕 FL-006/022: Spec 文件写入
import * as path from 'path';  // 🆕 FL-006/022: 文件路径处理
const redis = memoryStore;

// Discord 通知服务（通过 API 调用）
const API_BASE_URL = process.env.API_BASE_URL || `http://localhost:${process.env.PORT || 3001}`;

// 🆕 AS-011: PMO 号生成器（简化版，不依赖 projectService）
async function generatePmoNumber(companyId: string): Promise<string> {
  const latestProject = await prisma.project.findFirst({
    where: { companyId },
    orderBy: { createdAt: 'desc' },
  });

  let nextNumber = 1;
  if (latestProject) {
    const match = latestProject.pmoNumber.match(/PM-(\d+)/);
    if (match) {
      nextNumber = parseInt(match[1]) + 1;
    }
  }

  return `PM-${nextNumber.toString().padStart(3, '0')}`;
}

/**
 * LLM Client 适配器（调用 studio-shared）
 */
class LLMClientAdapter implements LLMClientInterface {
  async chat(prompt: string, options?: { temperature?: number }): Promise<string> {
    // 调用 /api/v1/llm/chat（端口 13101）
    const apiUrl = process.env.LLM_API_URL || `http://localhost:${process.env.PORT || 3001}/api/v1/llm/chat`;
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: prompt }],
        temperature: options?.temperature ?? 0.7,
      }),
    });

    if (!res.ok) {
      throw new Error(`LLM API error: ${res.status}`);
    }

    // API 返回 { content: ... } 格式（顶层 content）
    const data = await res.json() as { content?: string; choices?: Array<{ message?: { content?: string } }> };
    
    // 优先使用顶层 content，兼容 choices 格式
    if (data.content) {
      return data.content;
    }
    
    return data.choices?.[0]?.message?.content || '';
  }
}

const llmClient = new LLMClientAdapter();

/**
 * 处理 discussion.auto_start 事件
 * 
 * 当 Meeting API 发布 discussion.auto_start 事件时，
 * 此处理器启动 DiscussionDriver 执行自动讨论
 */
export async function handleAutoStart(event: DiscussionEvent): Promise<void> {
  const { meetingId, taskId, topic, maxRounds } = event.data;

  console.log(`[Auto Discussion Handler] Starting discussion for meeting ${meetingId}`);
  console.log(`  - taskId: ${taskId}`);
  console.log(`  - topic: ${topic}`);
  console.log(`  - maxRounds: ${maxRounds}`);

  // 1. 检查会议状态
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    include: {
      MeetingParticipant: { include: { Role: true } },
    },
  });

  if (!meeting) {
    console.error(`[Auto Discussion Handler] Meeting ${meetingId} not found`);
    return;
  }

  if (meeting.status !== 'discussing') {
    console.error(`[Auto Discussion Handler] Meeting ${meetingId} is not discussing`);
    await updateTaskStatus(taskId!, 'failed', 'Meeting is not discussing');
    return;
  }

  // 2. 更新任务状态为 running
  await updateTaskStatus(taskId!, 'running', 'Discussion started');

  // 3. 发布 discussion.started 事件
  await discussionEventPublisher.publishStarted(meetingId, topic || meeting.topic || '未指定议题');

  // 4. 启动 DiscussionDriver
  try {
    // 🆕 BP-001: 查询公司知识库（类似需求、可复用模式、已知坑位）
    let companyKnowledgeContext = '';
    let isColdStart = false;
    if (meeting.companyId) {
      try {
        const results = knowledgeKeeper.query(meeting.companyId, topic || meeting.topic || '', 5);
        companyKnowledgeContext = knowledgeKeeper.formatForPrompt(results);
        isColdStart = results.length === 0;
        if (companyKnowledgeContext) {
          console.log(`[BP-001] Loaded ${results.length} knowledge entries for debate`);
        } else {
          console.log(`[BP-012] Cold start — no company knowledge found, using conservative strategy`);
        }
      } catch (e) {
        console.warn(`[BP-001] Knowledge query failed (non-blocking):`, (e as Error).message);
        isColdStart = true; // 查询失败也视为冷启动
      }
    } else {
      isColdStart = true;
    }

    const driver = createDiscussionDriver({
      llmClient,
      maxRounds: maxRounds || 10,
      consensusThreshold: 0.8,
      timeoutMs: 300000,
      companyKnowledgeContext,
      isColdStart,
    });

    const result = await driver.runDiscussion(meetingId, topic || meeting.topic || '未指定议题');

    console.log(`[Auto Discussion Handler] Discussion completed for meeting ${meetingId}`);
    console.log(`  - result: ${result.status}`);
    console.log(`  - rounds: ${result.round}`);

    // 5. 发布完成事件
    await discussionEventPublisher.publishCompleted(meetingId, result.status, result.round);

    // 6. 更新会议状态
    await prisma.meeting.update({
      where: { id: meetingId },
      data: {
        status: 'completed', // Use status instead of discussionStatus
        summary: result.summary || `讨论已完成，共 ${result.round} 轮`,
        decisions: result.decisions ? JSON.parse(JSON.stringify(result.decisions)) : null,
      },
    });

    // 7. 更新任务状态
    await updateTaskStatus(taskId!, 'completed', `Discussion finished: ${result.status}`);
  } catch (error) {
    console.error(`[Auto Discussion Handler] Discussion failed:`, error);
    
    await updateTaskStatus(taskId!, 'failed', String(error));
    
    await discussionEventPublisher.publishStopped(meetingId, 'error');
  }
}

/**
 * 处理 discussion.stopped 事件
 */
export async function handleStopped(event: DiscussionEvent): Promise<void> {
  const { meetingId, reason } = event.data;

  console.log(`[Auto Discussion Handler] Discussion stopped for meeting ${meetingId}`);
  console.log(`  - reason: ${reason}`);

  // 更新会议状态
  await prisma.meeting.update({
    where: { id: meetingId },
    data: {
      status: 'stopped',
    },
  });
}

/**
 * 处理 discussion.completed 事件
 */
export async function handleCompleted(event: DiscussionEvent): Promise<void> {
  const { meetingId, result, round } = event.data;

  console.log(`[Auto Discussion Handler] Discussion completed for meeting ${meetingId}`);
  console.log(`  - result: ${result}`);
  console.log(`  - rounds: ${round}`);

  // 更新会议状态
  await prisma.meeting.update({
    where: { id: meetingId },
    data: {
      status: 'completed',
      summary: `讨论已完成，共 ${round} 轮，结果: ${result}`,
    },
  });
}

/**
 * 🆕 DD-009: 处理 discussion.user_intervention_needed 事件
 * 
 * 当讨论出现分歧时，发送 Discord 通知请求用户干预
 */
export async function handleUserInterventionNeeded(event: DiscussionEvent): Promise<void> {
  const { meetingId, round, reason } = event.data;

  console.log(`[Auto Discussion Handler] User intervention needed for meeting ${meetingId}`);
  console.log(`  - round: ${round}`);
  console.log(`  - reason: ${reason}`);

  // 1. 获取会议信息
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
  });

  if (!meeting) {
    console.error(`[Auto Discussion Handler] Meeting ${meetingId} not found`);
    return;
  }

  // 2. 更新会议状态为 pending_user
  await prisma.meeting.update({
    where: { id: meetingId },
    data: {
      discussionStatus: 'pending_user',
    },
  });

  // 3. 发送 Discord 通知（通过 API）
  if (meeting.source === 'discord' && meeting.sourceChannelId) {
    try {
      await fetch('http://localhost:3001/api/v1/notify/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'user-intervention-needed',
          meetingId,
          title: '⚠️ 会议需要您的决策',
          content: `会议：${meeting.title}\n原因：${reason}\n轮次：第 ${round} 轮\n\n请回复：\n- "继续" - 让角色继续讨论\n- "决策:xxx" - 您拍板指定方案\n- "终止" - 结束会议`,
          priority: 'high',
        }),
      });
      
      console.log(`[Auto Discussion Handler] Notification sent for meeting ${meetingId}`);
    } catch (error) {
      console.error(`[Auto Discussion Handler] Failed to send notification:`, error);
    }
  }
}

/**
 * 更新任务状态（Redis）
 */
async function updateTaskStatus(taskId: string, status: string, message: string): Promise<void> {
  const taskData = await redis.get(`discussion:task:${taskId}`);
  
  if (taskData) {
    const task = JSON.parse(taskData);
    task.status = status;
    task.message = message;
    task.updatedAt = new Date().toISOString();
    
    await redis.setex(`discussion:task:${taskId}`, 3600, JSON.stringify(task));
  }
}

/**
 * 初始化事件处理器
 */
export async function initDiscussionEventHandlers(): Promise<void> {
  // 注册 discussion 事件处理器
  discussionEventSubscriber.on('discussion.auto_start', handleAutoStart);
  discussionEventSubscriber.on('discussion.stopped', handleStopped);
  discussionEventSubscriber.on('discussion.completed', handleCompleted);
  discussionEventSubscriber.on('discussion.user_intervention_needed', handleUserInterventionNeeded);

  // 开始订阅 discussion 事件
  await discussionEventSubscriber.subscribe();

  // 🆕 FL-002: 订阅 meeting 事件（meeting.ended → TaskSplitter）
  memoryStore.subscribe('events:meeting', async (message) => {
    console.log(`[Meeting Event Subscriber] Message: ${message.slice(0, 100)}...`);

    try {
      const event = JSON.parse(message);
      console.log(`[Meeting Event Subscriber] Received ${event.event_type}`);

      if (event.event_type === 'meeting.ended') {
        await handleMeetingEnded(event);
        console.log(`[Meeting Event Subscriber] handleMeetingEnded completed`);
      }

      // 🆕 处理高风险会议确认事件
      if (event.event_type === 'meeting.confirmed') {
        await handleMeetingConfirmed(event);
        console.log(`[Meeting Event Subscriber] handleMeetingConfirmed completed`);
      }
    } catch (error) {
      console.error('[Meeting Event Subscriber] Error:', error);
    }
  });

  console.log('[Meeting Event Subscriber] subscribed to events:meeting');
  console.log('[Discussion Event Handlers] Initialized');
}

/**
 * 🆕 FL-002 + FL-006 + FL-007: 处理 meeting.ended 事件
 * 从 decisions 拆分任务 + 生成 Spec + 创建 Git 分支
 */
async function handleMeetingEnded(event: any): Promise<void> {
  const { meetingId, title, taskId, decisionsKey, decisionCount, projectId } = event.data;

  console.log(`[FL-002] Meeting ended: ${meetingId}`);
  console.log(`  - title: ${title}`);
  console.log(`  - decisionCount: ${decisionCount}`);
  console.log(`  - projectId: ${projectId || 'none'}`);

  // 1. 从 Redis 获取 decisions
  let decisions: any[] = [];
  console.log(`[FL-002] decisionsKey from event: ${decisionsKey || 'none'}`);
  if (decisionsKey) {
    const decisionsJson = await redis.get(decisionsKey);
    console.log(`[FL-002] Redis.get result: ${decisionsJson ? 'found' : 'not found'}`);
    if (decisionsJson) {
      decisions = JSON.parse(decisionsJson);
      console.log(`[FL-002] Parsed decisions: ${decisions.length} items`);
    }
  }

  // 2. 获取会议信息（companyId）
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: { companyId: true, topic: true, projectId: true, outputProjectId: true, title: true },
  });

  if (!meeting) {
    console.error(`[FL-002] Meeting ${meetingId} not found`);
    return;
  }

  // 🆕 风险评估：评估决策执行风险
  const risk = assessMeetingRisk(decisions, []);
  console.log(`[Risk] Assessment for meeting ${meetingId}:`);
  console.log(`  - level: ${risk.level}`);
  console.log(`  - score: ${risk.score}`);
  console.log(`  - reasons: ${risk.reasons.join(', ')}`);

  // 保存风险评估结果到会议
  await prisma.meeting.update({
    where: { id: meetingId },
    data: { riskAssessment: JSON.stringify(risk) },
  });

  // 高风险：暂停执行，发送 Discord 按钮等待确认
  if (risk.level === 'high') {
    console.log(`[Risk] High risk meeting ${meetingId}, waiting for user confirmation`);
    await prisma.meeting.update({
      where: { id: meetingId },
      data: { discussionStatus: 'pending_confirmation' },
    });

    // 发送高风险通知（带按钮）
    try {
      await fetch(`${API_BASE_URL}/api/v1/notify/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'user-intervention-needed',
          meetingId,
          title: '🔴 高风险会议待确认',
          content: `会议：${meeting.title || title}\n风险评分: ${risk.score}\n原因: ${risk.reasons.join(', ')}`,
          priority: 'high',
          components: [
            {
              type: 1,
              components: [
                { type: 2, style: 3, label: '✅ 确认执行', custom_id: `confirm:${meetingId}` },
                { type: 2, style: 4, label: '❌ 拒绝', custom_id: `reject:${meetingId}` },
              ],
            },
          ],
        }),
      });
      console.log(`[Risk] Discord notification sent for meeting ${meetingId}`);
    } catch (error) {
      console.error(`[Risk] Failed to send Discord notification:`, error);
    }
    return; // 暂停执行，等待用户确认
  }

  // 中风险：执行 + 发送通知
  if (risk.level === 'medium') {
    console.log(`[Risk] Medium risk meeting ${meetingId}, executing with notification`);
    try {
      await fetch(`${API_BASE_URL}/api/v1/notify/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'meeting-completed',
          meetingId,
          title: '🟡 中风险会议已执行',
          content: `会议：${meeting.title || title}\n风险评分: ${risk.score}\n原因: ${risk.reasons.join(', ')}`,
          priority: 'medium',
        }),
      });
    } catch (error) {
      console.error(`[Risk] Failed to send medium risk notification:`, error);
    }
  }

  // 低风险/中风险：继续执行（高风险已在前面暂停）
  await continueMeetingExecution(meetingId, meeting, decisions);
}

/**
 * 🆕 处理高风险会议确认事件
 * 用户通过 Discord 按钮确认后继续执行
 */
async function handleMeetingConfirmed(event: any): Promise<void> {
  const { meetingId } = event.data;

  console.log(`[Risk] Meeting confirmed by user: ${meetingId}`);

  // 获取会议信息
  const meeting = await prisma.meeting.findUnique({
    where: { id: meetingId },
    select: {
      companyId: true,
      topic: true,
      projectId: true,
      outputProjectId: true,
      title: true,
      decisions: true,
    },
  });

  if (!meeting) {
    console.error(`[Risk] Meeting ${meetingId} not found`);
    return;
  }

  // 获取 decisions
  let decisions: any[] = [];
  if (meeting.decisions) {
    decisions = Array.isArray(meeting.decisions)
      ? meeting.decisions
      : JSON.parse(JSON.stringify(meeting.decisions));
  }

  // 继续执行（跳过风险检查）
  await continueMeetingExecution(meetingId, meeting, decisions);
}

/**
 * 🆕 继续会议执行流程（创建项目、Spec、Git 分支、任务）
 * 被 handleMeetingEnded（低/中风险）和 handleMeetingConfirmed（高风险确认后）调用
 */
async function continueMeetingExecution(
  meetingId: string,
  meeting: { companyId: string; topic: string | null; projectId: string | null; outputProjectId: string | null; title: string | null },
  decisions: any[]
): Promise<void> {
  const title = meeting.title || '未命名会议';

  // 🆕 AS-011: 自动创建 Project（如果会议无关联项目）
  let effectiveProjectId = meeting.projectId || meeting.outputProjectId;

  if (!effectiveProjectId && decisions.length > 0) {
    console.log(`[AS-011] No project associated, creating new Project...`);

    try {
      const pmoNumber = await generatePmoNumber(meeting.companyId);

      const newProject = await prisma.project.create({
        data: {
          pmoNumber,
          title: meeting.title || title || '新项目',
          description: meeting.topic || '',
          requirement: meeting.topic || '',
          companyId: meeting.companyId,
          status: 'active',
          startedAt: new Date(),
        },
      });

      await prisma.meeting.update({
        where: { id: meetingId },
        data: { outputProjectId: newProject.id },
      });

      effectiveProjectId = newProject.id;

      console.log(`[AS-011] Created Project ${newProject.pmoNumber} (${newProject.id})`);
    } catch (error) {
      console.error(`[AS-011] Failed to create Project:`, error);
    }
  }

  // 🆕 FL-006 + FL-022: 生成 Spec 文档 + 版本关联
  if (effectiveProjectId) {
    try {
      const project = await prisma.project.findUnique({
        where: { id: effectiveProjectId },
        select: { pmoNumber: true, title: true, requirement: true, gitRepo: true, specFilePath: true },
      });

      if (project) {
        const specContent = generateSpecContent(project, meeting, decisions);

        const specPath = path.join(
          process.env.HOME || '/root',
          'knowledge-base',
          'specs',
          `${project.pmoNumber}.md`
        );

        const specsDir = path.dirname(specPath);
        try {
          await fs.mkdir(specsDir, { recursive: true });
        } catch (e) {
          // 目录已存在
        }

        await fs.writeFile(specPath, specContent, 'utf-8');

        await prisma.project.update({
          where: { id: effectiveProjectId },
          data: { specFilePath: specPath },
        });

        console.log(`[FL-006] Generated Spec for ${project.pmoNumber}`);
      }
    } catch (error) {
      console.error('[FL-006/022] Failed to generate spec:', error);
    }
  }

  // 🆕 FL-007: 创建 Git 分支
  if (effectiveProjectId) {
    try {
      const project = await prisma.project.findUnique({
        where: { id: effectiveProjectId },
        select: { pmoNumber: true, gitRepo: true, gitBranch: true },
      });

      if (project && !project.gitBranch && project.gitRepo) {
        const branchName = `feat/${project.pmoNumber}`;

        try {
          const repoParts = project.gitRepo.replace('github.com/', '').split('/');
          const repoOwner = repoParts[0];
          const repoName = repoParts[1];

          if (repoOwner && repoName) {
            const { execSync } = await import('child_process');
            const repoSlug = `${repoOwner}/${repoName}`;

            const mainSha = execSync(
              `gh api repos/${repoSlug}/git/refs/heads/main --jq '.object.sha'`,
              { encoding: 'utf-8', timeout: 15000 }
            ).trim();

            if (mainSha) {
              execSync(
                `gh api repos/${repoSlug}/git/refs -X POST -f ref='refs/heads/${branchName}' -f sha='${mainSha}'`,
                { encoding: 'utf-8', timeout: 15000 }
              );
              console.log(`[FL-007] Created branch: ${branchName} in ${repoSlug}`);
            }
          }
        } catch (gitError) {
          console.warn('[FL-007] Git branch creation skipped:', (gitError as Error).message);
        }

        await prisma.project.update({
          where: { id: effectiveProjectId },
          data: { gitBranch: branchName },
        });

        console.log(`[FL-007] Git branch updated: ${branchName}`);
      }
    } catch (error) {
      console.error('[FL-007] Failed to create git branch:', error);
    }
  }

  // 🆕 NA-001: 决策质量检查（via hooks）
  try {
    const decisionsText = decisions.map(d => d.content || '').join(' ');
    const { afterMeetingDecision } = await import('@dommaker/studio-shared/harness/hooks');
    await afterMeetingDecision({
      operation: 'design_request',
      taskDescription: decisionsText,
    });
    console.log(`[NA-001] Decision quality check passed`);
  } catch (checkErr) {
    // S4 修复：区分 Iron Law 违规（阻塞）和一般错误（警告）
    const { ConstraintViolationError } = await import('@dommaker/harness');
    if (checkErr instanceof ConstraintViolationError) {
      console.error(`[NA-001] Decision quality BLOCKED — Iron Law violation:`, (checkErr as Error).message);
      return; // 阻断后续执行：不生成 RequirementsDoc
    }
    console.warn(`[NA-001] Decision quality check warning:`, (checkErr as Error).message);
  }

  // 🆕 NA-001: 生成 RequirementsDoc（替换旧的 TaskSplitter）
  if (effectiveProjectId) {
    try {
      const project = await prisma.project.findUnique({
        where: { id: effectiveProjectId },
        select: { pmoNumber: true },
      });

      if (project) {
        const reqDocPath = path.join(
          process.env.HOME || '/root',
          'knowledge-base',
          'requirements-docs',
          `${project.pmoNumber}.json`
        );

        const reqDir = path.dirname(reqDocPath);
        try { await fs.mkdir(reqDir, { recursive: true }); } catch (e) { /* exists */ }

        // 🆕 BP-002: LLM 聚合 decisions → RequirementsDoc（替代简单 1:1 映射）
        const decisionsForPrompt = decisions.map((d: any) => ({
          content: d.content || '',
          agreed: d.agreed ?? true,
          priority: d.priority || 'normal',
        }));

        let requirementsDoc: any;
        try {
          // Step 1: LLM 聚合
          const prompt = buildRequirementsDocPrompt(decisionsForPrompt, meeting.topic || title);
          const llmOutput = await llmClient.chat(prompt, { temperature: 0.3 });
          const parsed = parseRequirementsDoc(llmOutput);

          if (parsed && parsed.acGroups.length > 0) {
            requirementsDoc = {
              pmoNumber: project.pmoNumber,
              summary: parsed.summary,
              acGroups: parsed.acGroups,
              constraints: parsed.constraints,
              generatedAt: new Date().toISOString(),
            };

            // Step 2: Checker 立场验证
            const checkerPrompt = `你是一个接手执行的开发者。请检查以下需求文档是否有问题：

${JSON.stringify(requirementsDoc, null, 2)}

检查项：
1. acGroup 之间是否有隐藏的文件冲突（两个组改同一个文件但没标依赖）？
2. 约束是否完整？有没有遗漏的安全/性能约束？
3. 每个 AC 是否可验证（有明确的通过标准）？

如果发现问题，以 JSON 格式输出修正：{"fixes": [{"acGroupId": "group-a", "field": "dependencies", "original": [], "fixed": ["group-b"], "reason": "..."}]}。
如果没有问题，输出：{"fixes": []}。`;

            try {
              const checkerOutput = await llmClient.chat(checkerPrompt, { temperature: 0.1 });
              // 提取 JSON：移除 markdown 代码块，找到第一个 { 开始的部分
              const cleaned = checkerOutput
                .replace(/```json\s*/g, '')
                .replace(/```\s*/g, '')
                .trim();
              const jsonStart = cleaned.indexOf('{');
              const jsonEnd = cleaned.lastIndexOf('}');
              const jsonStr = jsonStart >= 0 && jsonEnd > jsonStart
                ? cleaned.slice(jsonStart, jsonEnd + 1)
                : cleaned;
              const checkerResult = JSON.parse(jsonStr);
              if (checkerResult.fixes?.length > 0) {
                for (const fix of checkerResult.fixes) {
                  const group = requirementsDoc.acGroups.find((g: any) => g.id === fix.acGroupId);
                  if (group) {
                    (group as any)[fix.field] = fix.fixed;
                  }
                }
                console.log(`[NA-001] Checker fixed ${checkerResult.fixes.length} issues in RequirementsDoc`);
              }
            } catch {
              // Checker 失败不阻塞
              console.log('[NA-001] Checker verification skipped (non-blocking)');
            }

            // 🆕 冲突修正：检测文件重叠 → 自动加依赖（SDD 串行）
            const conflictResult = correctFileConflicts(requirementsDoc.acGroups);
            if (conflictResult.changes.length > 0) {
              requirementsDoc.acGroups = conflictResult.corrected;
              for (const change of conflictResult.changes) {
                console.log(`[NA-001] File conflict corrected: ${change.groupId} now depends on ${change.original.length > 0 ? change.original.join(',') : 'none'} → ${change.fixed.join(',')} (${change.reason})`);
              }
            }
          } else {
            throw new Error('LLM returned invalid RequirementsDoc');
          }
        } catch (llmErr) {
          // Fallback: 简单 1:1 映射
          console.warn(`[NA-001] LLM aggregation failed, using simple mapping:`, (llmErr as Error).message);
          requirementsDoc = {
            pmoNumber: project.pmoNumber,
            summary: meeting.topic || title,
            acGroups: decisions.map((d: any, i: number) => ({
              id: `ac-${i + 1}`,
              acs: [d.content || ''],
              files: [],
              dependencies: [],
            })),
            constraints: [],
            generatedAt: new Date().toISOString(),
          };
        }

        await fs.writeFile(reqDocPath, JSON.stringify(requirementsDoc, null, 2), 'utf-8');
        console.log(`[NA-001] RequirementsDoc saved to ${reqDocPath}`);

        // 🆕 审计: RequirementsDoc 产出
        try {
          recordDecision({
            eventType: 'requirements.generated',
            entityType: 'meeting',
            entityId: meetingId,
            projectId: effectiveProjectId,
            companyId: meeting.companyId,
            summary: `RequirementsDoc 产出（${requirementsDoc.acGroups.length} AC 组, ${requirementsDoc.constraints.length} 约束）`,
            details: { acGroupCount: requirementsDoc.acGroups.length, constraintCount: requirementsDoc.constraints.length, usedLLM: requirementsDoc.acGroups.length !== decisions.length || requirementsDoc.constraints.length > 0 },
            actorRole: 'analyst',
          });
        } catch (e) {
          logger.warn('[DiscussionEventHandlers] Audit recording failed (non-blocking)', { error: String(e) });
        }

        // 保存路径到 meeting
        await prisma.meeting.update({
          where: { id: meetingId },
          data: { summary: (meeting.topic || title) + `\n[RequirementsDoc] ${reqDocPath}` },
        });

        // 发布 requirements_ready 事件，API 侧自动创建 Goal
        try {
          await memoryStore.publish('events:meeting', JSON.stringify({
            event_type: 'meeting.requirements_ready',
            meetingId,
            projectId: effectiveProjectId,
            companyId: meeting.companyId,
            requirementsDocPath: reqDocPath,
            timestamp: new Date().toISOString(),
          }));
          console.log(`[NA-001] Published meeting.requirements_ready`);
        } catch (pubErr) {
          console.warn(`[NA-001] Failed to publish meeting.requirements_ready:`, (pubErr as Error).message);
        }
      }
    } catch (error) {
      console.error(`[NA-001] Failed to generate RequirementsDoc:`, error);
    }
  }

}

// 🆕 FL-006: 生成 Spec 内容
function generateSpecContent(project: any, meeting: any, decisions: any[]): string {
  const timestamp = new Date().toISOString();
  
  return `# ${project.pmoNumber} - ${project.title}

> 生成时间: ${timestamp}
> 来源会议: ${meeting.topic || '需求评审'}

---

## 一、需求概述

${project.requirement || '无需求描述'}

---

## 二、会议决策

${decisions.map((d, i) => `${i + 1}. ${d.content} (${d.agreed ? '✅ 已同意' : '⚠️ 待讨论'})`).join('\n')}

---

## 三、验收标准

- [ ] 功能实现完成
- [ ] 单元测试通过
- [ ] 代码评审通过

---

## 四、技术方案

待补充（从会议讨论中提取）

---

*此文档由 Agent Studio 自动生成*
`;
}