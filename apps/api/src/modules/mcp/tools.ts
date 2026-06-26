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
      select: { id: true, name: true, status: true, assignee: true, createdAt: true },
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
        // meetingId removed — not in Task schema
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
        select: { id: true, name: true, salary: true, level: true },
      });
      if (!role) throw new Error('Role not found');
      return { type: 'role', ...role };
    }
    const company = await prisma.company.findUnique({
      where: { id: input.companyId },
      select: { id: true, name: true },
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
      } as any,
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
        })) as any,
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
      if (!input.operation?.trim()) {
        return { error: 'operation is required and must be non-empty', allowed: false };
      }
      const { constraintService } = await import('@dommaker/studio-shared');
      const context = { ...input.context, operation: input.operation };
      const result = await constraintService.checkConstraints(context);
      const violations = [...result.ironLaws, ...result.guidelines, ...result.tips].filter(r => !r.satisfied);
      return {
        operation: input.operation,
        allowed: result.passed,
        violations,
        message: result.passed
          ? 'Constraint check passed'
          : `${violations.length} violation(s) found`,
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
        passed: result.safe,
        violations: result.violations,
        content: input.content.slice(0, 200),
        message: result.safe ? 'Guardrail check passed' : `${result.violations.length} violation(s) found`,
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

// ─── Agent-First 系统健康 ───

const systemHealth: MCPTool = {
  name: 'systemHealth',
  description: 'Agent-first 系统健康检查：API 状态、知识库统计、Agent 运行状态、管线阶段。Agent 在任何关键操作前应调此 tool 确认系统在线。',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
  },
  handler: async () => {
    const { sharedStore, checkDocumentFreshness } = await import('../knowledge/knowledge-bus.service.js');
    const fs = await import('fs');
    const os = await import('os');
    const path = await import('path');

    // 1. 系统资源
    const mem = process.memoryUsage();
    const cpu = os.loadavg();
    const uptime = process.uptime();

    // 2. 知识库统计
    const entries = sharedStore.list({ excludeArchived: false });
    const byType: Record<string, number> = {};
    const byLayer: Record<string, number> = {};
    const byMaturity: Record<string, number> = {};
    for (const e of entries) {
      byType[e.type] = (byType[e.type] || 0) + 1;
      byLayer[e.layer] = (byLayer[e.layer] || 0) + 1;
      byMaturity[e.maturity] = (byMaturity[e.maturity] || 0) + 1;
    }

    // 3. 设计文档新鲜度
    const staleDocs = checkDocumentFreshness(process.env.REPO_DIR || process.cwd());

    // 4. events-daemon 探活
    let eventsDaemonAlive = false;
    try {
      const eventsDir = path.join(os.homedir(), 'events');
      if (fs.existsSync(eventsDir)) {
        const files = fs.readdirSync(eventsDir).filter(f => f.endsWith('.jsonl'));
        // events-daemon 每 2s 更新文件指针 → 如果最近 30s 内有事件文件被写入过，daemon 在线
        for (const f of files.slice(0, 3)) {
          const stat = fs.statSync(path.join(eventsDir, f));
          if (Date.now() - stat.mtimeMs < 30_000) {
            eventsDaemonAlive = true;
            break;
          }
        }
      }
    } catch { /* can't determine */ }

    return {
      system: {
        uptime: `${Math.round(uptime)}s`,
        cpu: cpu.map(v => v.toFixed(2)),
        memory: { heapUsedMB: Math.round(mem.heapUsed / 1024 / 1024), rssMB: Math.round(mem.rss / 1024 / 1024) },
        apiResponding: true,
        eventsDaemonAlive,
      },
      knowledge: {
        total: entries.length,
        byType,
        byLayer,
        byMaturity,
        staleDesignDocs: staleDocs.length,
      },
      flags: {
        needsColdStart: entries.length < 10 && !byLayer?.['system'],
        needsDecay: byMaturity?.['archived'] === undefined || (byMaturity?.['archived'] || 0) === 0,
        healthy: eventsDaemonAlive,
      },
    };
  },
};

const emitEvent: MCPTool = {
  name: 'emitEvent',
  description: 'Agent 向事件管线发射结构化事件（写入 ~/events/studio.jsonl，由 events-daemon 路由到 Discord）。用于 Agent 间的异步通信和系统级通知。类型以 "agent:" 为前缀。',
  inputSchema: {
    type: 'object',
    properties: {
      eventType: { type: 'string', description: '事件类型 (如 agent:analysis_done, agent:review_blocked, agent:deploy_complete)' },
      message: { type: 'string', description: '事件消息' },
      severity: { type: 'string', description: '严重度', enum: ['info', 'warning', 'critical'], default: 'info' },
      details: { type: 'object', description: '附加上下文 (goalId, taskId, score 等)' },
    },
    required: ['eventType', 'message'],
  },
  handler: async (input) => {
    const fs = await import('fs');
    const path = await import('path');
    const os = await import('os');

    const eventsDir = path.join(os.homedir(), 'events');
    try { if (!fs.existsSync(eventsDir)) fs.mkdirSync(eventsDir, { recursive: true }); } catch { /* best-effort */ }

    const event = {
      type: input.eventType,
      message: input.message,
      severity: input.severity || 'info',
      details: input.details || {},
      timestamp: new Date().toISOString(),
    };

    try {
      fs.appendFileSync(path.join(eventsDir, 'studio.jsonl'), JSON.stringify(event) + '\n');
    } catch { /* non-blocking */ }

    return {
      emitted: true,
      eventType: input.eventType,
      routedTo: 'events-daemon → Discord (if goal:/monitor:/agent: prefix)',
    };
  },
};

const publishPackage: MCPTool = {
  name: 'publishPackage',
  description: '发布 npm 包到 registry + 创建 GitHub Release。包含完整流水线：tsc 编译 → dist 完整性验证 → npm version patch → git commit+tag → git push → npm publish → gh release create。Agent 应在 harness 源码变更已提交后调用。不可逆操作，执行前应确认。',
  inputSchema: {
    type: 'object',
    properties: {
      packagePath: { type: 'string', description: '包的绝对路径 (如 /root/projects/harness)' },
      bumpType: { type: 'string', description: '版本递增类型', enum: ['patch', 'minor', 'major'], default: 'patch' },
      dryRun: { type: 'string', description: '仅模拟执行不实际发布（跳过 npm publish + git push + gh release）', enum: ['true', 'false'], default: 'false' },
    },
    required: ['packagePath'],
  },
  handler: async (input) => {
    const { execSync } = await import('child_process');
    const path = await import('path');
    const fs = await import('fs');
    const steps: Array<{ step: string; status: 'ok' | 'fail' | 'skip'; output?: string }> = [];
    const pkgPath = input.packagePath;
    const dryRun = input.dryRun === 'true';

    // 0. Derive GitHub repo from git remote
    let repoUrl = '';
    try {
      const remoteUrl = execSync('git remote get-url origin', { cwd: pkgPath, encoding: 'utf-8', stdio: 'pipe', timeout: 5_000 }).trim();
      // Extract owner/repo from: https://github.com/owner/repo.git, git@github.com:owner/repo.git, etc.
      const m = remoteUrl.match(/github\.com[:/]([^/]+)\/([^/\s.]+?)(?:\.git)?$/);
      if (m) repoUrl = `https://github.com/${m[1]}/${m[2]}`;
    } catch { /* no remote — skip release URL */ }

    // 1. 验证路径
    if (!fs.existsSync(path.join(pkgPath, 'package.json'))) {
      return { success: false, error: `Not a package: ${pkgPath}`, steps };
    }
    const pkgJson = JSON.parse(fs.readFileSync(path.join(pkgPath, 'package.json'), 'utf-8'));
    const pkgName = pkgJson.name;
    const pkgVersion = pkgJson.version;
    steps.push({ step: `package: ${pkgName}@${pkgVersion}`, status: 'ok' });

    // 2. Check uncommitted changes
    try {
      const stat = execSync('git status --porcelain -uno', { cwd: pkgPath, encoding: 'utf-8', stdio: 'pipe', timeout: 10_000 });
      const hasChanges = stat.trim().length > 0;
      if (hasChanges) {
        return { success: false, error: `Uncommitted changes in ${pkgPath}. Commit or stash before publishing.`, steps };
      }
      steps.push({ step: 'git status: clean', status: 'ok' });
    } catch (e: any) {
      return { success: false, error: `Not a git repo: ${pkgPath} (${e.message})`, steps };
    }

    // 3. tsc build
    try {
      execSync('npx tsc', { cwd: pkgPath, encoding: 'utf-8', stdio: 'pipe', timeout: 60_000 });
      steps.push({ step: 'tsc: build', status: 'ok' });
    } catch (e: any) {
      const errMsg = e.stderr || e.message || String(e);
      steps.push({ step: 'tsc: failed', status: 'fail', output: errMsg.slice(0, 500) });
      return { success: false, error: 'TypeScript compilation failed', steps, compileErrors: errMsg.slice(0, 1000) };
    }

    // 4. Verify dist integrity — check known critical files
    const criticalFiles = ['dist/core/constraints/prompt-injection.js', 'dist/knowledge/doctor.js', 'dist/index.js'];
    const missing: string[] = [];
    for (const f of criticalFiles) {
      if (!fs.existsSync(path.join(pkgPath, f))) missing.push(f);
    }
    if (missing.length > 0) {
      steps.push({ step: `dist verify: ${missing.length} missing`, status: 'fail', output: missing.join(', ') });
      // Allow proceed with warning — not all packages have doctor.js
    } else {
      steps.push({ step: 'dist verify: all critical files present', status: 'ok' });
    }

    // 5. Bump version
    const bumpType = input.bumpType || 'patch';
    if (dryRun) {
      const [major, minor, patch] = pkgVersion.split('.').map(Number);
      let newVer: string;
      if (bumpType === 'major') newVer = `${major + 1}.0.0`;
      else if (bumpType === 'minor') newVer = `${major}.${minor + 1}.0`;
      else newVer = `${major}.${minor}.${patch + 1}`;
      steps.push({ step: `version: ${pkgVersion} → ${newVer} (dry-run, would be ${bumpType})`, status: 'skip' });
      steps.push({ step: 'npm publish: skipped (dry-run)', status: 'skip' });
      steps.push({ step: 'git push: skipped (dry-run)', status: 'skip' });
      steps.push({ step: 'gh release: skipped (dry-run)', status: 'skip' });
      return { success: true, dryRun: true, wouldPublish: `${pkgName}@${newVer}`, steps };
    }

    try {
      const newVers = execSync(`npm version ${bumpType} --no-git-tag-version`, {
        cwd: pkgPath, encoding: 'utf-8', stdio: 'pipe', timeout: 10_000,
      }).trim();
      steps.push({ step: `version: ${pkgVersion} → ${newVers}`, status: 'ok' });
    } catch (e: any) {
      return { success: false, error: `npm version failed: ${e.message}`, steps };
    }

    // 6. Git commit + tag
    const updatedPkg = JSON.parse(fs.readFileSync(path.join(pkgPath, 'package.json'), 'utf-8'));
    const newVersion = updatedPkg.version;
    const tag = `v${newVersion}`;

    try {
      execSync(`git add package.json && git commit -m "release: ${tag}" && git tag ${tag}`, {
        cwd: pkgPath, encoding: 'utf-8', stdio: 'pipe', timeout: 15_000,
      });
      steps.push({ step: `git: committed + tagged ${tag}`, status: 'ok' });
    } catch (e: any) {
      return { success: false, error: `git commit/tag failed: ${e.message}`, steps };
    }

    // 7. Git push (detect default branch)
    try {
      const branch = (() => {
        try { return execSync('git rev-parse --abbrev-ref HEAD', { cwd: pkgPath, encoding: 'utf-8', stdio: 'pipe', timeout: 5_000 }).trim(); }
        catch { return 'main'; }
      })();
      execSync(`git push origin ${branch}`, { cwd: pkgPath, encoding: 'utf-8', stdio: 'pipe', timeout: 30_000 });
      execSync(`git push origin ${tag}`, { cwd: pkgPath, encoding: 'utf-8', stdio: 'pipe', timeout: 30_000 });
      steps.push({ step: 'git push: main + tag', status: 'ok' });
    } catch (e: any) {
      return { success: false, error: `git push failed: ${e.message}`, steps };
    }

    // 8. npm publish
    try {
      const pubOut = execSync('npm publish', { cwd: pkgPath, encoding: 'utf-8', stdio: 'pipe', timeout: 120_000 });
      steps.push({ step: `npm: published ${pkgName}@${newVersion}`, status: 'ok', output: pubOut.trim() });
    } catch (e: any) {
      const errMsg = e.stderr || e.message || String(e);
      // If "already exists" → not a failure, just already published
      if (errMsg.includes('previously published') || errMsg.includes('EPUBLISHCONFLICT')) {
        steps.push({ step: `npm: ${pkgName}@${newVersion} already published`, status: 'ok' });
      } else {
        return { success: false, error: `npm publish failed: ${errMsg.slice(0, 500)}`, steps };
      }
    }

    // 9. GitHub Release
    try {
      const ghOut = execSync(`gh release create ${tag} --generate-notes`, {
        cwd: pkgPath, encoding: 'utf-8', stdio: 'pipe', timeout: 30_000,
      });
      steps.push({ step: `gh release: ${tag}`, status: 'ok', output: ghOut.trim() });
    } catch (e: any) {
      // Release failure is non-fatal — package is already published
      steps.push({ step: `gh release: failed (non-fatal)`, status: 'fail', output: String(e.message || e).slice(0, 200) });
    }

    return {
      success: true,
      package: pkgName,
      version: newVersion,
      tag,
      npmUrl: `https://www.npmjs.com/package/${pkgName}/v/${newVersion}`,
      githubRelease: repoUrl ? `${repoUrl}/releases/tag/${tag}` : `tag ${tag} (no remote)`,
      steps,
    };
  },
};

// ─── Skill 按需加载 ───

const loadSkill: MCPTool = {
  name: 'loadSkill',
  description: '按需加载 Skill 完整内容。Agent 看到 skill 索引后，调用此工具获取具体工作流指令。',
  inputSchema: {
    type: 'object',
    properties: {
      skillName: { type: 'string', description: 'Skill 名称（从索引中获取）' },
    },
    required: ['skillName'],
  },
  handler: async (input) => {
    const { skillName } = input;

    // [Skill Discovery] Log Agent's skill selection
    const { logger } = await import('@dommaker/studio-shared');
    logger.info(`[SkillDiscovery] Agent selected skill: ${skillName}`);

    // 1. Try package SkillLoader (sync, cached, includes hardcoded + DB skills)
    const { skillLoader } = await import('@dommaker/studio-skill');
    const fullPrompt = skillLoader.getFullPrompt(skillName);
    if (fullPrompt) {
      return { skillName, content: fullPrompt, source: 'cache' };
    }

    // 2. Try file-based loading via SkillLoaderService
    const { skillLoaderService } = await import('../skills/skill-loader.js');
    const loaded = await skillLoaderService.loadSkill({
      sessionId: `mcp-${Date.now()}`,
      skillName,
    });
    if (loaded) {
      return { skillName, content: loaded.prompt, source: 'file' };
    }

    return { skillName, error: `Skill "${skillName}" not found` };
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
  // 经济 (3)
  getBalance,


  // 规格审查 (4)
  createSpec,
  approveSpec,
  getSpecStatus,
  listSpecs,
  // 安全 (3)
  checkConstraint,
  checkGuardrail,
  getSandboxLevel,
  // Agent-First 系统 (2)
  systemHealth,
  emitEvent,
  // DevOps (1)
  publishPackage,
  // Skill 按需加载 (1)
  loadSkill,
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
  seedDefaultPermissions(allTools.map(t => t.name)).catch((e) => {
    logger.warn('[MCP] seedDefaultPermissions failed — tools may lack default permissions', { error: String(e) });
  });
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

  // Permission check — default to 'executor' for local agents (Claude CLI)
  const effectiveRoleId = roleId || 'executor';
  const allowed = await mcpPermissionService.isAllowed(effectiveRoleId, name);
  if (!allowed) {
    throw new Error(`Permission denied: role ${effectiveRoleId} is not allowed to call tool "${name}"`);
  }

  logger.info('MCP tool execution', { tool: name, roleId: effectiveRoleId, ...traceCtx, input });
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
    const caller = traceCtx?.executionId || effectiveRoleId;
    toolRegistry.recordCall(name, success, duration, caller);
    // Async audit logging (don't block response)
    mcpPermissionService.logAudit({
      toolName: name,
      roleId: effectiveRoleId,
      input,
      output: success ? result : undefined,
      duration,
      success,
      error,
    }).catch(err => logger.warn('[MCP] Audit log failed', { error: String(err) }));
  }
}
