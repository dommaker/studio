/**
 * MCP Tools 定义
 *
 * 将 Studio 模块暴露为 MCP tools，供 Agent 和 UI 共享调用。
 * FL-026: 使用 MCPToolRegistry 动态注册，替代静态数组。
 */

import { prisma } from '@dommaker/studio-prisma';
import { logger } from '@dommaker/studio-shared';
import { toolRegistry, type RegisteredTool } from './tool-registry.js';
import { mcpPermissionService } from './permission.service.js';

// ─── 类型（向后兼容） ───

export type MCPTool = RegisteredTool;

// ─── PMO 项目管理 ───

const createProject: MCPTool = {
  name: 'createProject',
  description: '创建新的 PMO 项目',
  inputSchema: {
    type: 'object',
    properties: {
      companyId: { type: 'string', description: '公司 ID' },
      title: { type: 'string', description: '项目标题' },
      description: { type: 'string', description: '项目描述' },
      requirement: { type: 'string', description: '需求描述' },
    },
    required: ['companyId', 'title'],
  },
  handler: async (input) => {
    const pmoNumber = `PMO-${Date.now().toString(36).toUpperCase()}`;
    const project = await prisma.project.create({
      data: {
        companyId: input.companyId,
        title: input.title,
        pmoNumber,
        status: 'active',
      },
    });
    return { projectId: project.id, pmoNumber: project.pmoNumber };
  },
};

const listProjects: MCPTool = {
  name: 'listProjects',
  description: '列出公司的所有项目',
  inputSchema: {
    type: 'object',
    properties: {
      companyId: { type: 'string', description: '公司 ID' },
      status: { type: 'string', description: '状态过滤' },
      limit: { type: 'number', description: '返回数量限制' },
    },
    required: ['companyId'],
  },
  handler: async (input) => {
    const where: Record<string, any> = { companyId: input.companyId };
    if (input.status) where.status = input.status;
    const projects = await prisma.project.findMany({
      where,
      take: input.limit || 50,
      orderBy: { createdAt: 'desc' },
      select: { id: true, pmoNumber: true, title: true, status: true, createdAt: true },
    });
    return { projects, total: projects.length };
  },
};

const getProjectStatus: MCPTool = {
  name: 'getProjectStatus',
  description: '获取项目详情和当前状态',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: '项目 ID' },
    },
    required: ['projectId'],
  },
  handler: async (input) => {
    const project = await prisma.project.findUnique({
      where: { id: input.projectId },
      include: {
        Documents: { select: { id: true, type: true, title: true, status: true } },
      },
    });
    if (!project) throw new Error('Project not found');
    return project;
  },
};

// ─── 角色管理 ───

const listRoles: MCPTool = {
  name: 'listRoles',
  description: '列出公司的所有角色',
  inputSchema: {
    type: 'object',
    properties: {
      companyId: { type: 'string', description: '公司 ID' },
      status: { type: 'string', description: '状态过滤' },
    },
    required: ['companyId'],
  },
  handler: async (input) => {
    const where: Record<string, any> = { companyId: input.companyId };
    if (input.status) where.status = input.status;
    const roles = await prisma.role.findMany({
      where,
      select: { id: true, name: true, type: true, level: true, status: true },
    });
    return { roles, total: roles.length };
  },
};

const getRoleMemory: MCPTool = {
  name: 'getRoleMemory',
  description: '获取角色的记忆内容',
  inputSchema: {
    type: 'object',
    properties: {
      roleId: { type: 'string', description: '角色 ID' },
    },
    required: ['roleId'],
  },
  handler: async (input) => {
    const role = await prisma.role.findUnique({
      where: { id: input.roleId },
      select: { id: true, name: true, memory: true },
    });
    if (!role) throw new Error('Role not found');
    return { roleId: role.id, name: role.name, memory: role.memory };
  },
};

// ─── 任务管理 ───

const getTaskBoard: MCPTool = {
  name: 'getTaskBoard',
  description: '获取任务看板状态',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: '项目 ID' },
      status: { type: 'string', description: '状态过滤' },
    },
  },
  handler: async (input) => {
    const where: Record<string, any> = {};
    if (input.projectId) where.projectId = input.projectId;
    if (input.status) where.status = input.status;
    const tasks = await prisma.task.findMany({
      where,
      take: 50,
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, status: true, assignedTo: true, createdAt: true },
    });
    return { tasks, total: tasks.length };
  },
};

// ─── 知识库 ───

const queryKnowledge: MCPTool = {
  name: 'queryKnowledge',
  description: '搜索知识库文档',
  inputSchema: {
    type: 'object',
    properties: {
      companyId: { type: 'string', description: '公司 ID' },
      search: { type: 'string', description: '搜索关键词' },
      type: { type: 'string', description: '文档类型过滤' },
      limit: { type: 'number', description: '返回数量' },
    },
    required: ['companyId'],
  },
  handler: async (input) => {
    const where: Record<string, any> = { companyId: input.companyId, status: 'active' };
    if (input.type) where.type = input.type;
    if (input.search) {
      where.OR = [
        { title: { contains: input.search, mode: 'insensitive' } },
        { content: { contains: input.search, mode: 'insensitive' } },
      ];
    }
    const docs = await prisma.document.findMany({
      where,
      take: input.limit || 10,
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, type: true, content: true, tags: true, updatedAt: true },
    });
    return { documents: docs, total: docs.length };
  },
};

const extractKnowledge: MCPTool = {
  name: 'extractKnowledge',
  description: '从内容中提取知识条目并存储',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: '项目 ID' },
      companyId: { type: 'string', description: '公司 ID' },
      title: { type: 'string', description: '文档标题' },
      content: { type: 'string', description: '文档内容' },
      type: { type: 'string', description: '文档类型', enum: ['requirement', 'design', 'spec', 'execution', 'meeting'] },
      tags: { type: 'array', items: { type: 'string' }, description: '标签' },
    },
    required: ['projectId', 'companyId', 'title', 'content', 'type'],
  },
  handler: async (input) => {
    const doc = await prisma.document.create({
      data: {
        projectId: input.projectId,
        companyId: input.companyId,
        title: input.title,
        content: input.content,
        type: input.type,
        tags: input.tags || [],
        status: 'active',
      },
    });
    return { documentId: doc.id, title: doc.title };
  },
};

// ─── 会议管理 ───

const startDiscussion: MCPTool = {
  name: 'startDiscussion',
  description: '在项目会议中发起议题讨论',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '会议标题' },
      topic: { type: 'string', description: '讨论主题' },
      companyId: { type: 'string', description: '公司 ID' },
      projectId: { type: 'string', description: '项目 ID' },
    },
    required: ['title', 'companyId'],
  },
  handler: async (input) => {
    const meeting = await prisma.meeting.create({
      data: {
        title: input.title,
        topic: input.topic,
        companyId: input.companyId,
        projectId: input.projectId,
        status: 'pending',
      },
    });
    return { meetingId: meeting.id, title: meeting.title };
  },
};

const sendMessage: MCPTool = {
  name: 'sendMessage',
  description: '向会议发送消息（角色发言）',
  inputSchema: {
    type: 'object',
    properties: {
      meetingId: { type: 'string', description: '会议 ID' },
      roleId: { type: 'string', description: '发言角色 ID' },
      content: { type: 'string', description: '消息内容' },
      messageType: { type: 'string', description: '消息类型', enum: ['speech', 'controversy_injection'], default: 'speech' },
      round: { type: 'number', description: '讨论轮次', default: 1 },
    },
    required: ['meetingId', 'roleId', 'content'],
  },
  handler: async (input) => {
    const meeting = await prisma.meeting.findUnique({
      where: { id: input.meetingId },
      select: { id: true, status: true },
    });
    if (!meeting) throw new Error('Meeting not found');
    if (['completed', 'cancelled'].includes(meeting.status)) {
      throw new Error(`Meeting is ${meeting.status}, cannot send message`);
    }
    const message = await prisma.meetingMessage.create({
      data: {
        meetingId: input.meetingId,
        roleId: input.roleId,
        content: input.content,
        messageType: input.messageType || 'speech',
        round: input.round || 1,
      },
    });
    return { messageId: message.id, meetingId: input.meetingId, round: message.round };
  },
};

const checkConsensus: MCPTool = {
  name: 'checkConsensus',
  description: '检查会议讨论是否达成共识',
  inputSchema: {
    type: 'object',
    properties: {
      meetingId: { type: 'string', description: '会议 ID' },
    },
    required: ['meetingId'],
  },
  handler: async (input) => {
    const messages = await prisma.meetingMessage.findMany({
      where: { meetingId: input.meetingId },
      orderBy: { round: 'asc' },
      select: { id: true, roleId: true, content: true, round: true, stance: true, messageType: true },
    });
    const meeting = await prisma.meeting.findUnique({
      where: { id: input.meetingId },
      select: { id: true, topic: true, status: true, decisions: true, maxRounds: true },
    });
    if (!meeting) throw new Error('Meeting not found');
    return {
      meetingId: input.meetingId,
      topic: meeting.topic,
      status: meeting.status,
      messageCount: messages.length,
      rounds: Math.max(...messages.map(m => m.round), 0),
      maxRounds: meeting.maxRounds,
      decisions: meeting.decisions,
    };
  },
};

const extractDecision: MCPTool = {
  name: 'extractDecision',
  description: '提取会议的决策、待办和关键发现',
  inputSchema: {
    type: 'object',
    properties: {
      meetingId: { type: 'string', description: '会议 ID' },
    },
    required: ['meetingId'],
  },
  handler: async (input) => {
    const meeting = await prisma.meeting.findUnique({
      where: { id: input.meetingId },
      select: { id: true, title: true, summary: true, decisions: true, actionItems: true, keyFindings: true, status: true },
    });
    if (!meeting) throw new Error('Meeting not found');
    return {
      meetingId: meeting.id,
      title: meeting.title,
      summary: meeting.summary,
      decisions: meeting.decisions,
      actionItems: meeting.actionItems,
      keyFindings: meeting.keyFindings,
      status: meeting.status,
    };
  },
};

const endMeeting: MCPTool = {
  name: 'endMeeting',
  description: '结束会议并生成纪要',
  inputSchema: {
    type: 'object',
    properties: {
      meetingId: { type: 'string', description: '会议 ID' },
      summary: { type: 'string', description: '会议纪要（可选，不传则自动生成）' },
      decisions: { type: 'array', items: { type: 'object' }, description: '决策列表' },
      generateSummary: { type: 'boolean', description: '是否使用 LLM 自动生成纪要', default: true },
    },
    required: ['meetingId'],
  },
  handler: async (input) => {
    const meeting = await prisma.meeting.findUnique({ where: { id: input.meetingId } });
    if (!meeting) throw new Error('Meeting not found');

    const updateData: Record<string, any> = {
      status: 'completed',
      completedAt: new Date(),
    };
    if (input.summary) updateData.summary = input.summary;
    if (input.decisions) updateData.decisions = input.decisions;

    const updated = await prisma.meeting.update({
      where: { id: input.meetingId },
      data: updateData,
      select: { id: true, title: true, status: true, summary: true, decisions: true, actionItems: true },
    });
    return updated;
  },
};

const getDiscussionStatus: MCPTool = {
  name: 'getDiscussionStatus',
  description: '获取会议讨论状态和发言队列',
  inputSchema: {
    type: 'object',
    properties: {
      meetingId: { type: 'string', description: '会议 ID' },
    },
    required: ['meetingId'],
  },
  handler: async (input) => {
    const meeting = await prisma.meeting.findUnique({
      where: { id: input.meetingId },
      select: { id: true, status: true, discussionStatus: true, discussionMode: true, topic: true, maxRounds: true },
    });
    if (!meeting) throw new Error('Meeting not found');

    const participants = await prisma.meetingParticipant.findMany({
      where: { meetingId: input.meetingId },
      select: { roleId: true, stance: true, status: true },
    });

    const messages = await prisma.meetingMessage.findMany({
      where: { meetingId: input.meetingId },
      orderBy: { round: 'desc' },
      take: 1,
      select: { round: true },
    });

    return {
      meetingId: input.meetingId,
      status: meeting.status,
      discussionStatus: meeting.discussionStatus,
      discussionMode: meeting.discussionMode,
      topic: meeting.topic,
      maxRounds: meeting.maxRounds,
      currentRound: messages[0]?.round || 0,
      participants: participants.length,
      participantDetails: participants,
    };
  },
};

// ─── 任务管理 ───

const createTask: MCPTool = {
  name: 'createTask',
  description: '创建新任务',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: '项目 ID' },
      name: { type: 'string', description: '任务名称' },
      assignee: { type: 'string', description: '指派角色类型 (developer/architect/qa/any)' },
      description: { type: 'string', description: '任务描述' },
      priority: { type: 'string', description: '优先级', enum: ['P0', 'P1', 'P2', 'P3'], default: 'P2' },
      meetingId: { type: 'string', description: '关联会议 ID' },
      dependsOn: { type: 'array', items: { type: 'string' }, description: '依赖的任务 ID 列表' },
      acceptanceCriteria: { type: 'array', items: { type: 'string' }, description: '验收标准' },
      estimatedHours: { type: 'number', description: '预估工时' },
    },
    required: ['projectId', 'name', 'assignee'],
  },
  handler: async (input) => {
    const task = await prisma.task.create({
      data: {
        projectId: input.projectId,
        name: input.name,
        assignee: input.assignee,
        description: input.description,
        priority: input.priority || 'P2',
        meetingId: input.meetingId,
        dependsOn: input.dependsOn || [],
        acceptanceCriteria: input.acceptanceCriteria || [],
        estimatedHours: input.estimatedHours,
      },
    });
    return { taskId: task.id, name: task.name, assignee: task.assignee, priority: task.priority };
  },
};

const assignTask: MCPTool = {
  name: 'assignTask',
  description: '认领任务（分配给指定角色）',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: '任务 ID' },
      roleId: { type: 'string', description: '认领角色 ID' },
    },
    required: ['taskId', 'roleId'],
  },
  handler: async (input) => {
    const task = await prisma.task.findUnique({ where: { id: input.taskId } });
    if (!task) throw new Error('Task not found');
    if (task.status !== 'pending') throw new Error(`Task is not pending (current: ${task.status})`);

    const updated = await prisma.task.update({
      where: { id: input.taskId },
      data: { claimedBy: input.roleId, claimedAt: new Date(), status: 'claimed' },
    });
    return { taskId: updated.id, status: updated.status, claimedBy: updated.claimedBy };
  },
};

const updateTaskStatus: MCPTool = {
  name: 'updateTaskStatus',
  description: '更新任务状态',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: '任务 ID' },
      status: { type: 'string', description: '新状态', enum: ['pending', 'blocked', 'claimed', 'in_progress', 'completed', 'failed', 'cancelled'] },
      testEvidence: { type: 'string', description: '测试证据（完成时可选）' },
    },
    required: ['taskId', 'status'],
  },
  handler: async (input) => {
    const existing = await prisma.task.findUnique({
      where: { id: input.taskId },
      select: { id: true, status: true },
    });
    if (!existing) throw new Error(`Task not found: ${input.taskId}`);

    const updateData: Record<string, any> = { status: input.status };
    if (input.status === 'in_progress') updateData.startedAt = new Date();
    if (input.status === 'completed') {
      updateData.completedAt = new Date();
      if (input.testEvidence) updateData.testEvidence = input.testEvidence;
    }

    const task = await prisma.task.update({
      where: { id: input.taskId },
      data: updateData,
    });
    return { taskId: task.id, status: task.status };
  },
};

const getTaskStats: MCPTool = {
  name: 'getTaskStats',
  description: '获取任务统计信息',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: '项目 ID（可选）' },
    },
  },
  handler: async (input) => {
    const where: Record<string, any> = {};
    if (input.projectId) where.projectId = input.projectId;

    const [byStatus, total] = await Promise.all([
      prisma.task.groupBy({ by: ['status'], where, _count: true }),
      prisma.task.count({ where }),
    ]);

    const statusMap: Record<string, number> = {};
    for (const row of byStatus) {
      statusMap[row.status] = row._count;
    }

    return {
      total,
      pending: statusMap['pending'] || 0,
      claimed: statusMap['claimed'] || 0,
      in_progress: statusMap['in_progress'] || 0,
      completed: statusMap['completed'] || 0,
      failed: statusMap['failed'] || 0,
      blocked: statusMap['blocked'] || 0,
    };
  },
};

// ─── 经济系统 ───

const getBalance: MCPTool = {
  name: 'getBalance',
  description: '查询公司或角色余额',
  inputSchema: {
    type: 'object',
    properties: {
      companyId: { type: 'string', description: '公司 ID' },
      roleId: { type: 'string', description: '角色 ID（可选，不传则返回公司余额）' },
    },
    required: ['companyId'],
  },
  handler: async (input) => {
    if (input.roleId) {
      const role = await prisma.role.findUnique({
        where: { id: input.roleId },
        select: { id: true, name: true, balance: true, debt: true, salary: true, level: true },
      });
      if (!role) throw new Error('Role not found');
      return { type: 'role', ...role };
    }
    const company = await prisma.company.findUnique({
      where: { id: input.companyId },
      select: { id: true, name: true, balance: true },
    });
    if (!company) throw new Error('Company not found');
    return { type: 'company', ...company };
  },
};

// ─── 规格审查 ───

const createSpec: MCPTool = {
  name: 'createSpec',
  description: '创建规格变更审查',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '变更标题' },
      description: { type: 'string', description: '变更描述' },
      changes: { type: 'array', items: { type: 'object' }, description: '变更内容列表' },
      changeType: { type: 'string', description: '变更类型' },
      impact: { type: 'string', description: '影响评估' },
      requestedBy: { type: 'string', description: '请求者' },
      workflowId: { type: 'string', description: '关联工作流 ID' },
    },
    required: ['title', 'changes', 'changeType'],
  },
  handler: async (input) => {
    const review = await prisma.specReview.create({
      data: {
        title: input.title,
        description: input.description,
        changes: input.changes,
        changeType: input.changeType,
        impact: input.impact || 'low',
        requestedBy: input.requestedBy,
        workflowId: input.workflowId,
        status: 'pending',
      },
    });
    return { reviewId: review.id, title: review.title, status: review.status };
  },
};

const approveSpec: MCPTool = {
  name: 'approveSpec',
  description: '审批规格变更',
  inputSchema: {
    type: 'object',
    properties: {
      reviewId: { type: 'string', description: '审查 ID' },
      role: { type: 'string', description: '审批角色', enum: ['architect', 'projectLead'] },
      reviewerId: { type: 'string', description: '审批者 ID' },
      reviewerName: { type: 'string', description: '审批者名称' },
      approved: { type: 'boolean', description: '是否通过' },
      comment: { type: 'string', description: '审批意见' },
    },
    required: ['reviewId', 'role', 'reviewerId', 'reviewerName', 'approved'],
  },
  handler: async (input) => {
    const review = await prisma.specReview.findUnique({ where: { id: input.reviewId } });
    if (!review) throw new Error('SpecReview not found');
    if (review.status !== 'pending') throw new Error(`Review already ${review.status}`);

    // 创建审批记录
    await prisma.specReviewApproval.create({
      data: {
        reviewId: input.reviewId,
        role: input.role,
        reviewerId: input.reviewerId,
        reviewerName: input.reviewerName,
        approved: input.approved,
        comment: input.comment,
      },
    });

    // 检查是否满足审批条件
    const approvals = await prisma.specReviewApproval.findMany({
      where: { reviewId: input.reviewId },
    });
    const approvedCount = approvals.filter(a => a.approved).length;
    const rejectedCount = approvals.filter(a => !a.approved).length;

    let newStatus = 'pending';
    if (rejectedCount > 0) {
      newStatus = 'rejected';
    } else if (approvedCount >= 1) { // 简化：单人审批即可
      newStatus = 'approved';
    }

    const updated = await prisma.specReview.update({
      where: { id: input.reviewId },
      data: {
        status: newStatus,
        approvals: approvals.map(a => ({
          role: a.role,
          reviewerName: a.reviewerName,
          approved: a.approved,
          comment: a.comment,
        })),
        ...(newStatus !== 'pending' ? { reviewedAt: new Date(), reviewedBy: input.reviewerName } : {}),
      },
    });

    return { reviewId: updated.id, status: updated.status, approvedCount, rejectedCount };
  },
};

const getSpecStatus: MCPTool = {
  name: 'getSpecStatus',
  description: '获取规格审查状态',
  inputSchema: {
    type: 'object',
    properties: {
      reviewId: { type: 'string', description: '审查 ID' },
    },
    required: ['reviewId'],
  },
  handler: async (input) => {
    const review = await prisma.specReview.findUnique({
      where: { id: input.reviewId },
      include: {
        SpecReviewApproval: { select: { role: true, reviewerName: true, approved: true, comment: true, createdAt: true } },
      },
    });
    if (!review) throw new Error('SpecReview not found');
    return review;
  },
};

const listSpecs: MCPTool = {
  name: 'listSpecs',
  description: '列出规格审查',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: '状态过滤', enum: ['pending', 'approved', 'rejected', 'applied'] },
      workflowId: { type: 'string', description: '工作流 ID' },
      limit: { type: 'number', description: '返回数量', default: 20 },
    },
  },
  handler: async (input) => {
    const where: Record<string, any> = {};
    if (input.status) where.status = input.status;
    if (input.workflowId) where.workflowId = input.workflowId;

    const reviews = await prisma.specReview.findMany({
      where,
      take: input.limit || 20,
      orderBy: { createdAt: 'desc' },
      select: { id: true, title: true, changeType: true, status: true, requestedBy: true, createdAt: true },
    });
    return { reviews, total: reviews.length };
  },
};

// ─── Agent 执行 ───

const spawnAgent: MCPTool = {
  name: 'spawnAgent',
  description: '创建执行计划并分配给 Agent 执行',
  inputSchema: {
    type: 'object',
    properties: {
      meetingId: { type: 'string', description: '关联会议 ID' },
      steps: { type: 'array', items: { type: 'object', properties: { agent: { type: 'string' }, task: { type: 'string' }, dependencies: { type: 'array', items: { type: 'string' } } } }, description: '执行步骤' },
      priority: { type: 'number', description: '优先级 (0-10)', default: 5 },
      assignedTo: { type: 'string', description: '指定 agent 类型 (claude/codex/opencode/llm)' },
    },
    required: ['meetingId', 'steps'],
  },
  handler: async (input) => {
    const meeting = await prisma.meeting.findUnique({
      where: { id: input.meetingId },
      select: { id: true },
    });
    if (!meeting) throw new Error(`Meeting not found: ${input.meetingId}`);

    const plan = await prisma.executionPlan.create({
      data: {
        meetingId: input.meetingId,
        plan: { steps: input.steps },
        priority: input.priority || 5,
        status: 'pending',
      },
    });
    return { planId: plan.id, status: plan.status, steps: input.steps.length };
  },
};

const getAgentStatus: MCPTool = {
  name: 'getAgentStatus',
  description: '获取 Agent 执行状态',
  inputSchema: {
    type: 'object',
    properties: {
      planId: { type: 'string', description: '执行计划 ID' },
    },
    required: ['planId'],
  },
  handler: async (input) => {
    const plan = await prisma.executionPlan.findUnique({
      where: { id: input.planId },
      include: {
        ExecutionResult: { select: { agentType: true, status: true, durationMs: true, tokenUsage: true, error: true } },
      },
    });
    if (!plan) throw new Error('ExecutionPlan not found');
    return {
      planId: plan.id,
      status: plan.status,
      assignedTo: plan.assignedTo,
      priority: plan.priority,
      startedAt: plan.startedAt,
      completedAt: plan.completedAt,
      result: plan.ExecutionResult,
    };
  },
};

const getAgentResult: MCPTool = {
  name: 'getAgentResult',
  description: '获取 Agent 执行结果',
  inputSchema: {
    type: 'object',
    properties: {
      planId: { type: 'string', description: '执行计划 ID' },
    },
    required: ['planId'],
  },
  handler: async (input) => {
    const result = await prisma.executionResult.findUnique({
      where: { planId: input.planId },
    });
    if (!result) throw new Error('No result found for this plan');
    return {
      planId: input.planId,
      agentType: result.agentType,
      status: result.status,
      output: result.output,
      tokenUsage: result.tokenUsage,
      durationMs: result.durationMs,
      error: result.error,
    };
  },
};

const getAgentStats: MCPTool = {
  name: 'getAgentStats',
  description: '获取 Agent 路由统计',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    const [byStatus, total] = await Promise.all([
      prisma.executionPlan.groupBy({ by: ['status'], _count: true }),
      prisma.executionPlan.count(),
    ]);

    const statusMap: Record<string, number> = {};
    for (const row of byStatus) {
      statusMap[row.status] = row._count;
    }

    return {
      total,
      pending: statusMap['pending'] || 0,
      running: statusMap['running'] || 0,
      completed: statusMap['completed'] || 0,
      failed: statusMap['failed'] || 0,
    };
  },
};

// ─── 安全约束 ───

const checkConstraint: MCPTool = {
  name: 'checkConstraint',
  description: '检查操作是否违反安全约束（Iron Laws + Guidelines + Tips）',
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string', description: '要检查的操作描述' },
      context: { type: 'object', description: '操作上下文 (roleId, resource, action 等)' },
      constraintIds: { type: 'array', items: { type: 'string' }, description: '指定检查的约束 ID（可选，不传则全量检查）' },
    },
    required: ['operation'],
  },
  handler: async (input) => {
    try {
      const { constraintService } = await import('@dommaker/studio-shared');
      const context = input.context || {};
      const result = await constraintService.checkConstraints(context);
      return {
        operation: input.operation,
        allowed: result.violations.length === 0,
        violations: result.violations,
        message: result.violations.length === 0
          ? 'Constraint check passed'
          : `${result.violations.length} violation(s) found`,
        checkedAt: new Date().toISOString(),
      };
    } catch {
      return {
        operation: input.operation,
        allowed: false,
        harnessUnavailable: true,
        message: 'Harness unavailable, constraint check not performed',
      };
    }
  },
};

const checkGuardrail: MCPTool = {
  name: 'checkGuardrail',
  description: '检查输入/输出是否通过安全护栏',
  inputSchema: {
    type: 'object',
    properties: {
      direction: { type: 'string', description: '检查方向', enum: ['input', 'output'], default: 'input' },
      content: { type: 'string', description: '要检查的内容' },
      context: { type: 'object', description: '上下文' },
    },
    required: ['content'],
  },
  handler: async (input) => {
    try {
      const { safetyService } = await import('@dommaker/studio-shared');
      const direction = input.direction || 'input';
      const guardrail = direction === 'input'
        ? safetyService.getInputGuardrail()
        : safetyService.getOutputGuardrail();
      const result = guardrail.check(input.content);
      return {
        direction,
        passed: result.passed,
        violations: result.violations,
        content: input.content.slice(0, 200),
        message: result.passed ? 'Guardrail check passed' : `${result.violations.length} violation(s) found`,
      };
    } catch {
      return {
        direction: input.direction || 'input',
        passed: false,
        harnessUnavailable: true,
        message: 'Harness unavailable, guardrail check not performed',
      };
    }
  },
};

const getSandboxLevel: MCPTool = {
  name: 'getSandboxLevel',
  description: '获取当前沙箱安全级别配置',
  inputSchema: {
    type: 'object',
    properties: {},
  },
  handler: async () => {
    try {
      const { safetyService } = await import('@dommaker/studio-shared');
      const sandbox = safetyService.getSandbox();
      return {
        level: `L${sandbox.getLevel()}`,
        description: sandbox.getDescription(),
        message: 'Sandbox configuration retrieved',
      };
    } catch {
      return { level: 'L3', message: 'Sandbox info unavailable (harness not loaded)' };
    }
  },
};

// ─── 知识库增强 ───

const storeKnowledge: MCPTool = {
  name: 'storeKnowledge',
  description: '存储知识文档到知识库',
  inputSchema: {
    type: 'object',
    properties: {
      projectId: { type: 'string', description: '项目 ID' },
      companyId: { type: 'string', description: '公司 ID' },
      title: { type: 'string', description: '文档标题' },
      content: { type: 'string', description: '文档内容' },
      type: { type: 'string', description: '文档类型', enum: ['requirement', 'design', 'spec', 'execution', 'meeting', 'archive'] },
      tags: { type: 'array', items: { type: 'string' }, description: '标签' },
      filePath: { type: 'string', description: '文件路径（可选）' },
    },
    required: ['projectId', 'companyId', 'title', 'content', 'type'],
  },
  handler: async (input) => {
    const doc = await prisma.document.create({
      data: {
        projectId: input.projectId,
        companyId: input.companyId,
        title: input.title,
        content: input.content,
        type: input.type,
        tags: input.tags || [],
        filePath: input.filePath,
        status: 'active',
      },
    });
    return { documentId: doc.id, title: doc.title, type: doc.type };
  },
};

const searchKnowledge: MCPTool = {
  name: 'searchKnowledge',
  description: '搜索知识库文档（全文搜索）',
  inputSchema: {
    type: 'object',
    properties: {
      companyId: { type: 'string', description: '公司 ID' },
      query: { type: 'string', description: '搜索关键词' },
      type: { type: 'string', description: '文档类型过滤' },
      projectId: { type: 'string', description: '项目 ID 过滤' },
      limit: { type: 'number', description: '返回数量', default: 10 },
    },
    required: ['companyId', 'query'],
  },
  handler: async (input) => {
    const where: Record<string, any> = {
      companyId: input.companyId,
      status: 'active',
      OR: [
        { title: { contains: input.query, mode: 'insensitive' } },
        { content: { contains: input.query, mode: 'insensitive' } },
      ],
    };
    if (input.type) where.type = input.type;
    if (input.projectId) where.projectId = input.projectId;

    // 先不查 content 列，避免大字段传输
    const docs = await prisma.document.findMany({
      where,
      take: input.limit || 10,
      orderBy: { updatedAt: 'desc' },
      select: { id: true, title: true, type: true, tags: true, projectId: true, updatedAt: true },
    });

    return {
      documents: docs,
      total: docs.length,
    };
  },
};

const getMaturity: MCPTool = {
  name: 'getMaturity',
  description: '获取知识库成熟度和健康指标',
  inputSchema: {
    type: 'object',
    properties: {
      companyId: { type: 'string', description: '公司 ID' },
    },
    required: ['companyId'],
  },
  handler: async (input) => {
    const [total, active, archived, byType] = await Promise.all([
      prisma.document.count({ where: { companyId: input.companyId } }),
      prisma.document.count({ where: { companyId: input.companyId, status: 'active' } }),
      prisma.document.count({ where: { companyId: input.companyId, status: 'archived' } }),
      prisma.document.groupBy({
        by: ['type'],
        where: { companyId: input.companyId, status: 'active' },
        _count: true,
      }),
    ]);

    const typeDistribution: Record<string, number> = {};
    for (const item of byType) {
      typeDistribution[item.type] = item._count;
    }

    return {
      total,
      active,
      archived,
      archiveRate: total > 0 ? (archived / total * 100).toFixed(1) + '%' : '0%',
      typeDistribution,
      healthScore: active > 0 ? Math.min(100, active * 10) : 0,
      maturityLadder: ['draft', 'candidate', 'validated', 'canonical', 'archived'],
    };
  },
};

// ─── 注册所有 tools ───

const allTools: RegisteredTool[] = [
  // PMO 项目 (3)
  createProject,
  listProjects,
  getProjectStatus,
  // 角色 (2)
  listRoles,
  getRoleMemory,
  // 任务 (5)
  getTaskBoard,
  createTask,
  assignTask,
  updateTaskStatus,
  getTaskStats,
  // 知识库 (5)
  queryKnowledge,
  extractKnowledge,
  storeKnowledge,
  searchKnowledge,
  getMaturity,
  // 会议 (6)
  startDiscussion,
  sendMessage,
  checkConsensus,
  extractDecision,
  endMeeting,
  getDiscussionStatus,
  // 经济 (3)
  getBalance,


  // 规格审查 (4)
  createSpec,
  approveSpec,
  getSpecStatus,
  listSpecs,
  // Agent 执行 (4)
  spawnAgent,
  getAgentStatus,
  getAgentResult,
  getAgentStats,
  // 安全 (3)
  checkConstraint,
  checkGuardrail,
  getSandboxLevel,
];

// FL-026: Register all tools into the registry on module load
// G2: assign risk levels based on operation type
for (const tool of allTools) {
  if (/^(create|store|extract|settle|spawn|approve|send|end|assign|update)/.test(tool.name)) {
    tool.riskLevel = 'medium';
  } else if (/^delete|^drop|^truncate/.test(tool.name)) {
    tool.riskLevel = 'high';
  } else {
    tool.riskLevel = 'low';
  }
}
toolRegistry.registerAll(allTools);

// BP3: 种子 default-deny 权限 — 系统角色默认允许所有工具
import('./permission.service.js').then(({ seedDefaultPermissions }) => {
  seedDefaultPermissions(allTools.map(t => t.name)).catch(() => {});
});

/**
 * 获取所有 tool 的 schema（不含 handler）— 向后兼容
 */
export function getToolSchemas() {
  return toolRegistry.getSchemas();
}

/**
 * 按名称查找并执行 tool（FL-026: 带权限检查 + 限流 + 审计）
 */
export async function executeTool(
  name: string,
  input: Record<string, any>,
  roleId?: string,
  traceCtx?: { executionId?: string; goalId?: string },
) {
  const tool = toolRegistry.get(name);
  if (!tool || !tool.enabled) {
    throw new Error(`Unknown or disabled tool: ${name}`);
  }

  // Rate limit check
  const rateCheck = toolRegistry.checkRateLimit(name);
  if (!rateCheck.allowed) {
    throw new Error(`Rate limit exceeded for tool "${name}". Retry after ${rateCheck.retryAfterMs}ms`);
  }

  // Permission check
  const allowed = await mcpPermissionService.isAllowed(roleId, name);
  if (!allowed) {
    throw new Error(`Permission denied: role ${roleId} is not allowed to call tool "${name}"`);
  }

  logger.info({ tool: name, roleId, ...traceCtx, input }, 'MCP tool execution');
  const start = Date.now();
  let success = false;
  let result: any;
  let error: string | undefined;

  try {
    result = await tool.handler(input);
    success = true;
    return { success: true, result, duration: Date.now() - start };
  } catch (e) {
    error = String(e);
    throw e;
  } finally {
    const duration = Date.now() - start;
    const caller = traceCtx?.executionId || roleId;
    toolRegistry.recordCall(name, success, duration, caller);
    // Async audit logging (don't block response)
    mcpPermissionService.logAudit({
      toolName: name,
      roleId,
      input,
      output: success ? result : undefined,
      duration,
      success,
      error,
    }).catch(err => logger.warn({ error: String(err) }, '[MCP] Audit log failed'));
  }
}
