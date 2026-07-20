/**
 * MCP Tools — PMO 项目管理
 *
 * T3 拆分：自 tools.ts 原样提取（createProject / listProjects / getProjectStatus）。
 */

import type { RegisteredTool } from './tool-registry.js';

// ─── PMO 项目管理 ───

const createProject: RegisteredTool = {
  name: 'createProject',
  description: '创建新的 PMO 项目',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '项目标题' },
      description: { type: 'string', description: '项目描述' },
      requirement: { type: 'string', description: '需求描述' },
    },
    required: ['title'],
  },
  handler: async (input) => {
    const { projectService } = await import('../pmo/project.service.js');
    const project = await projectService.create({
      title: input.title,
      description: input.description,
      requirement: input.requirement,
    });
    return { projectId: project.id, pmoNumber: project.pmoNumber };
  },
};

const listProjects: RegisteredTool = {
  name: 'listProjects',
  description: '列出所有项目',
  inputSchema: {
    type: 'object',
    properties: {
      status: { type: 'string', description: '状态过滤' },
      limit: { type: 'number', description: '返回数量限制' },
    },
    required: [],
  },
  handler: async (input) => {
    const { projectService } = await import('../pmo/project.service.js');
    const projects = await projectService.list({
      status: input.status,
      limit: input.limit || 50,
    });
    return { projects, total: projects.length };
  },
};

const getProjectStatus: RegisteredTool = {
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
    const { projectService } = await import('../pmo/project.service.js');
    const project = await projectService.get(input.projectId);
    if (!project) throw new Error('Project not found');
    return project;
  },
};

export const pmoTools: RegisteredTool[] = [
  createProject,
  listProjects,
  getProjectStatus,
];
