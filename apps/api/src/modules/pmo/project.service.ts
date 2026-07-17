/**
 * Project Service - PMO 项目管理
 *
 * GEN-005: PMO 号生成 + 项目 CRUD
 * Spec 3: 迁移到 FileStore (~/.studio/projects/{id}.json)
 */

import { FileStore } from '@dommaker/studio-shared';
import { logger } from '../../utils/logger.js';
import { channelMessageService } from '../channels/channel-message.service.js';
import { WorkUnitService } from '../workunit/workunit.service.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const PROJECTS_DIR = path.join(os.homedir(), '.studio', 'projects');

const fileStore = new FileStore();

export interface CreateProjectInput {
  companyId?: string;
  title: string;
  description?: string;
  requirement?: string;
  okrId?: string;
  priority?: string;
  gitBranch?: string;
  gitRepo?: string;
  requirementsDocId?: string;
}

export interface UpdateProjectInput {
  title?: string;
  description?: string;
  requirement?: string;
  okrId?: string;
  status?: string;
  priority?: string;
  progress?: number;
  gitBranch?: string;
  gitRepo?: string;
  startedAt?: string | null;
  completedAt?: string | null;
}

export interface ProjectListOptions {
  status?: string;
  priority?: string;
  okrId?: string;
  limit?: number;
  offset?: number;
}

export interface ProjectData {
  id: string;
  pmoNumber: string;
  title: string;
  description: string | null;
  requirement: string | null;
  companyId: string | null;
  okrId: string | null;
  status: string;
  priority: string;
  progress: number;
  gitBranch: string | null;
  gitRepo: string | null;
  specFilePath: string | null;
  requirementsDocId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================
// FL-018: Project 状态机
// ============================================

export const PROJECT_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  IN_REVIEW: 'in_review',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
} as const;

export type ProjectStatus = typeof PROJECT_STATUS[keyof typeof PROJECT_STATUS];

const VALID_TRANSITIONS: Record<string, string[]> = {
  [PROJECT_STATUS.PENDING]: [PROJECT_STATUS.ACTIVE, PROJECT_STATUS.CANCELLED],
  [PROJECT_STATUS.ACTIVE]: [PROJECT_STATUS.IN_REVIEW, PROJECT_STATUS.CANCELLED],
  [PROJECT_STATUS.IN_REVIEW]: [PROJECT_STATUS.COMPLETED, PROJECT_STATUS.CANCELLED],
  [PROJECT_STATUS.COMPLETED]: [],
  [PROJECT_STATUS.CANCELLED]: [PROJECT_STATUS.PENDING],
};

export function validateTransition(currentStatus: string, newStatus: string): boolean {
  const allowed = VALID_TRANSITIONS[currentStatus] || [];
  return allowed.includes(newStatus);
}

// ============================================
// 内部工具
// ============================================

function projectPath(projectId: string): string {
  return path.join(PROJECTS_DIR, `${projectId}.json`);
}

function generateId(): string {
  return `proj_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

async function readAllProjects(): Promise<ProjectData[]> {
  try {
    const dirents = await fs.promises.readdir(PROJECTS_DIR, { withFileTypes: true });
    const files = dirents.filter(d => d.isFile() && d.name.endsWith('.json'));
    const projects: ProjectData[] = [];
    for (const f of files) {
      const data = await fileStore.readJson<ProjectData>(path.join(PROJECTS_DIR, f.name));
      if (data) projects.push(data);
    }
    return projects;
  } catch (err: unknown) {
    if (isErrnoError(err) && err.code === 'ENOENT') return [];
    throw err;
  }
}

function isErrnoError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

// ============================================
// PMO 号生成（全局递增）
// ============================================

export async function generatePmoNumber(): Promise<string> {
  const projects = await readAllProjects();

  let maxNum = 0;
  for (const proj of projects) {
    const match = proj.pmoNumber?.match(/PM-(\d+)/);
    if (match) {
      const num = parseInt(match[1]);
      if (num > maxNum) maxNum = num;
    }
  }

  const nextNumber = maxNum + 1;
  const pmoNumber = `PM-${nextNumber.toString().padStart(3, '0')}`;
  logger.info({ pmoNumber }, 'Generated PMO number');

  return pmoNumber;
}

export function parsePmoNumberFromCommand(command: string): {
  type: 'link' | 'create' | 'auto';
  pmoNumber?: string;
} {
  const linkMatch = command.match(/@PM-(\d{3})/);
  if (linkMatch) {
    return { type: 'link', pmoNumber: `PM-${linkMatch[1]}` };
  }
  if (command.includes('#新项目')) {
    return { type: 'create' };
  }
  return { type: 'auto' };
}

// ============================================
// Project CRUD
// ============================================

export const projectService = {
  async create(input: CreateProjectInput) {
    const pmoNumber = await generatePmoNumber();
    const id = generateId();
    const now = new Date().toISOString();

    const project: ProjectData = {
      id,
      pmoNumber,
      title: input.title,
      description: input.description || null,
      requirement: input.requirement || null,
      companyId: input.companyId || null,
      okrId: input.okrId || null,
      status: 'pending',
      priority: input.priority || 'normal',
      progress: 0,
      gitBranch: input.gitBranch || null,
      gitRepo: input.gitRepo || null,
      specFilePath: null,
      requirementsDocId: input.requirementsDocId || null,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    await fileStore.writeJson(projectPath(id), project);
    logger.info({ projectId: id, pmoNumber }, 'Project created');
    return project;
  },

  async get(projectId: string): Promise<ProjectData | null> {
    return fileStore.readJson<ProjectData>(projectPath(projectId));
  },

  async getByPmoNumber(pmoNumber: string): Promise<ProjectData | null> {
    const projects = await readAllProjects();
    return projects.find(p => p.pmoNumber === pmoNumber) || null;
  },

  async list(options: ProjectListOptions = {}): Promise<ProjectData[]> {
    let projects = await readAllProjects();

    if (options.status) {
      projects = projects.filter(p => p.status === options.status);
    }
    if (options.priority) {
      projects = projects.filter(p => p.priority === options.priority);
    }
    if (options.okrId) {
      projects = projects.filter(p => p.okrId === options.okrId);
    }

    // Sort by createdAt desc
    projects.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    const offset = options.offset || 0;
    const limit = options.limit || 20;
    return projects.slice(offset, offset + limit);
  },

  async update(projectId: string, input: UpdateProjectInput): Promise<ProjectData> {
    const current = await fileStore.readJson<ProjectData>(projectPath(projectId));
    if (!current) {
      throw new Error('Project not found');
    }

    const updated: ProjectData = {
      ...current,
      ...input,
      id: current.id, // never change id
      pmoNumber: current.pmoNumber, // never change PMO number
      createdAt: current.createdAt, // preserve
      updatedAt: new Date().toISOString(),
    };

    await fileStore.writeJson(projectPath(projectId), updated);
    logger.info({ projectId, updates: input }, 'Project updated');
    return updated;
  },

  async updateStatus(projectId: string, status: string, skipValidation = false) {
    const now = new Date();
    const current = await fileStore.readJson<ProjectData>(projectPath(projectId));

    if (!current) {
      throw new Error('Project not found');
    }

    if (!skipValidation && !validateTransition(current.status, status)) {
      logger.warn({ projectId, currentStatus: current.status, newStatus: status }, 'Invalid status transition');
      throw new Error(`Invalid status transition: ${current.status} → ${status}`);
    }

    const updateData: Record<string, unknown> = { status };

    if (status === PROJECT_STATUS.ACTIVE && !current.startedAt) {
      updateData.startedAt = now.toISOString();
    }
    if (status === PROJECT_STATUS.COMPLETED) {
      updateData.completedAt = now.toISOString();
      updateData.progress = 100;
    }

    logger.info({ projectId, from: current.status, to: status }, 'Project status transition');
    return this.update(projectId, updateData);
  },

  async tryActivate(projectId: string): Promise<boolean> {
    const current = await fileStore.readJson<ProjectData>(projectPath(projectId));

    if (!current || current.status !== PROJECT_STATUS.PENDING) {
      return false;
    }

    await this.updateStatus(projectId, PROJECT_STATUS.ACTIVE, true);
    logger.info({ projectId, pmoNumber: current.pmoNumber }, 'Project activated (pending → active)');
    return true;
  },

  async delete(projectId: string) {
    const current = await fileStore.readJson<ProjectData>(projectPath(projectId));

    if (!current) {
      throw new Error('Project not found');
    }

    if (current.status !== 'pending' && current.status !== 'cancelled') {
      throw new Error('Can only delete pending or cancelled projects');
    }

    await fs.promises.unlink(projectPath(projectId));
    logger.info({ projectId }, 'Project deleted');
    return { success: true };
  },

  async calculateProgress(projectId: string): Promise<number> {
    const project = await fileStore.readJson<ProjectData>(projectPath(projectId));
    if (!project) {
      return 0;
    }

    const tasksPath = path.join(PROJECTS_DIR, projectId, 'tasks.jsonl');
    const tasks = await fileStore.readJsonl<{ status?: string }>(tasksPath);

    if (tasks.length === 0) {
      return project.progress;
    }

    const completed = tasks.filter(t => t.status === 'completed').length;
    return Math.round((completed / tasks.length) * 100);
  },

  async publish(input: { projectId: string; channelId: string }) {
    const project = await this.get(input.projectId);
    if (!project) throw new Error('Project not found');
    if (project.status !== 'pending') throw new Error('Project must be pending to publish');

    const content = `📋 ${project.pmoNumber}: ${project.title}\n\n${project.requirement || ''}`;
    const message = await channelMessageService.createHumanMessage(input.channelId, content);
    await channelMessageService.updateMessageMeta(message.id, { pmoId: project.id });

    const workUnitService = new WorkUnitService();
    const workUnit = await workUnitService.create({
      type: 'analysis',
      scope: `分析需求 ${project.pmoNumber}: ${project.title}\n\n${project.requirement || ''}`,
      channelId: input.channelId,
      metadata: { pmoId: project.id, pmoNumber: project.pmoNumber },
    });

    const updatedProject = await this.updateStatus(input.projectId, 'active');

    return { message, workUnit, project: updatedProject };
  },

  async getLinkedSDDs(projectId: string): Promise<{ sddEntries: Array<{ slug: string; pmoNumber: string; status: string; title: string; tags: string }> }> {
    const project = await this.get(projectId);
    if (!project) throw new Error('Project not found');

    const indexPath = path.join(process.cwd(), 'docs/sdd/_index.md');
    if (!fs.existsSync(indexPath)) {
      logger.warn({ projectId }, 'SDD index file not found');
      return { sddEntries: [] };
    }

    const content = fs.readFileSync(indexPath, 'utf-8');
    const entries = content
      .split('\n')
      .filter(line => line.includes(project.pmoNumber) && !line.startsWith('#'))
      .map(line => {
        const parts = line.split('|').map(s => s.trim());
        return {
          slug: parts[0] || '',
          pmoNumber: parts[1] || '',
          status: parts[2] || '',
          title: parts[3] || '',
          tags: parts[4] || '',
        };
      });

    return { sddEntries: entries };
  },
};
