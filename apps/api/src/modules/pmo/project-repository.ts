/** PMO 项目 FileStore 仓储：编号、CRUD 与状态写口；物理存储/缓存/锁保持原实现。 */
import { generateId } from '@dommaker/studio-shared';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { logger } from '../../utils/logger.js';
import { getStore } from '../../core/store.js';
import {
  parsePmoSeq,
  PROJECT_STATUS,
  resolveDeliveries,
  validateTransition,
  type CreateProjectInput,
  type ProjectData,
  type ProjectListOptions,
  type UpdateProjectInput,
} from './model.js';

const PROJECTS_DIR = studioPath('projects');
const REQUIREMENTS_DIR = studioPath('data', 'requirements');
// PMO/REQ 共用统一序号；项目写入也复用既有 REQ 锁，避免引入新的数据区布局。
const PROJECTS_LOCK_DIR = path.join(REQUIREMENTS_DIR, 'lock');

function projectPath(projectId: string): string {
  return path.join(PROJECTS_DIR, `${projectId}.json`);
}

function withReadDefaults(project: ProjectData): ProjectData {
  return { ...project, deliveries: resolveDeliveries(project) };
}

async function readAllProjects(): Promise<ProjectData[]> {
  const projects = await getStore().listJsonInDir<ProjectData>(PROJECTS_DIR);
  return projects.map(withReadDefaults);
}

/** 存量 REQ 最大序号（文件 + index.json nextSeq-1；目录不存在/读取失败 → 0）。 */
async function scanMaxRequirementSeq(): Promise<number> {
  try {
    const entries = await fs.promises.readdir(REQUIREMENTS_DIR);
    let max = 0;
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : (entry as { name?: string }).name ?? '';
      const m = name.match(/^REQ-(\d+)\.json$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    const idx = await getStore().readJson<{ nextSeq?: number }>(path.join(REQUIREMENTS_DIR, 'index.json'));
    if (typeof idx?.nextSeq === 'number' && idx.nextSeq > 1) max = Math.max(max, idx.nextSeq - 1);
    return max;
  } catch {
    return 0;
  }
}

/** 新编号 = max(PM/PMO, REQ 两序列) + 1；REQ-x 与 PMO-x 同号同对象。 */
export async function generatePmoNumber(): Promise<string> {
  const projects = await readAllProjects();
  let maxNum = 0;
  for (const proj of projects) {
    const num = parsePmoSeq(proj.pmoNumber);
    if (num !== null && num > maxNum) maxNum = num;
  }
  maxNum = Math.max(maxNum, await scanMaxRequirementSeq());
  const pmoNumber = `PMO-${maxNum + 1}`;
  logger.info({ pmoNumber }, 'Generated PMO number (unified sequence)');
  return pmoNumber;
}

async function writeProjectUpdate(
  store: ReturnType<typeof getStore>,
  current: ProjectData,
  input: UpdateProjectInput,
): Promise<ProjectData> {
  const updated: ProjectData = {
    ...current,
    ...input,
    id: current.id,
    pmoNumber: current.pmoNumber,
    createdAt: current.createdAt,
    updatedAt: new Date().toISOString(),
  };
  await store.writeJson(projectPath(current.id), updated);
  logger.info({ projectId: current.id, updates: input }, 'Project updated');
  return updated;
}

export const projectRepository = {
  async create(input: CreateProjectInput) {
    const store = getStore();
    return store.withLock(PROJECTS_LOCK_DIR, async () => {
      const pmoNumber = await generatePmoNumber();
      const id = generateId('proj');
      const now = new Date().toISOString();
      const seq = parsePmoSeq(pmoNumber);
      const reqAlias = seq !== null ? `REQ-${String(seq).padStart(4, '0')}` : null;
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
        gitBranch: input.gitBranch || pmoNumber,
        gitRepo: input.gitRepo || null,
        specFilePath: null,
        requirementsDocId: input.requirementsDocId || null,
        startedAt: null,
        completedAt: null,
        createdAt: now,
        updatedAt: now,
        reqAlias,
        deliveryPolicy: input.deliveryPolicy ?? 'branch-only',
        ...(input.isChore ? { isChore: true, channelId: input.channelId ?? null } : {}),
      };

      const repos = (input.gitRepos ?? []).map(r => r.trim()).filter(Boolean);
      if (repos.length > 0) {
        project.gitRepo = repos[0];
        project.deliveries = repos.map(repo => ({ gitRepo: repo, branch: project.gitBranch, status: 'pending' }));
      }

      await store.writeJson(projectPath(id), project);
      logger.info({ projectId: id, pmoNumber, reqAlias }, 'Project created');
      return project;
    });
  },

  async get(projectId: string): Promise<ProjectData | null> {
    const data = await getStore().readJson<ProjectData>(projectPath(projectId));
    return data ? withReadDefaults(data) : null;
  },

  async getByReqAlias(reqId: string): Promise<ProjectData | null> {
    const projects = await readAllProjects();
    return projects.find(p => p.reqAlias === reqId) || null;
  },

  /** 杂务项目只查不建；找不到返回 null。 */
  async findChoreProject(channelId: string): Promise<ProjectData | null> {
    const projects = await readAllProjects();
    return projects.find(p => p.isChore === true && p.channelId === channelId) || null;
  },

  async getByPmoNumber(pmoNumber: string): Promise<ProjectData | null> {
    const projects = await readAllProjects();
    const exact = projects.find(p => p.pmoNumber === pmoNumber);
    if (exact) return exact;
    const seq = parsePmoSeq(pmoNumber);
    if (seq === null) return null;
    return projects.find(p => parsePmoSeq(p.pmoNumber) === seq) || null;
  },

  async list(options: ProjectListOptions = {}): Promise<ProjectData[]> {
    let projects = await readAllProjects();
    if (options.status) projects = projects.filter(p => p.status === options.status);
    if (options.priority) projects = projects.filter(p => p.priority === options.priority);
    if (options.okrId) projects = projects.filter(p => p.okrId === options.okrId);
    projects.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const offset = options.offset || 0;
    const limit = options.limit || 20;
    return projects.slice(offset, offset + limit);
  },

  async countByOkr(): Promise<Map<string, number>> {
    const projects = await readAllProjects();
    const counts = new Map<string, number>();
    for (const p of projects) {
      if (p.okrId) counts.set(p.okrId, (counts.get(p.okrId) ?? 0) + 1);
    }
    return counts;
  },

  async listByOkrId(okrId: string): Promise<ProjectData[]> {
    const projects = await readAllProjects();
    return projects
      .filter(p => p.okrId === okrId)
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  },

  async unlinkOkr(okrId: string): Promise<number> {
    const linked = (await readAllProjects()).filter(p => p.okrId === okrId);
    for (const p of linked) await this.update(p.id, { okrId: null });
    return linked.length;
  },

  async update(projectId: string, input: UpdateProjectInput): Promise<ProjectData> {
    const store = getStore();
    return store.withLock(PROJECTS_LOCK_DIR, async () => {
      const current = await store.readJsonUncached<ProjectData>(projectPath(projectId));
      if (!current) throw new Error('Project not found');
      return writeProjectUpdate(store, current, input);
    });
  },

  async updateStatus(projectId: string, status: string, skipValidation = false, extra: Record<string, unknown> = {}) {
    const store = getStore();
    return store.withLock(PROJECTS_LOCK_DIR, async () => {
      const now = new Date();
      const current = await store.readJsonUncached<ProjectData>(projectPath(projectId));
      if (!current) throw new Error('Project not found');
      if (!skipValidation && !validateTransition(current.status, status)) {
        logger.warn({ projectId, currentStatus: current.status, newStatus: status }, 'Invalid status transition');
        throw new Error(`Invalid status transition: ${current.status} → ${status}`);
      }
      const updateData: UpdateProjectInput = { status, ...extra };
      if (status === PROJECT_STATUS.ACTIVE && !current.startedAt) updateData.startedAt = now.toISOString();
      if (status === PROJECT_STATUS.COMPLETED) {
        updateData.completedAt = now.toISOString();
        updateData.progress = 100;
      }
      logger.info({ projectId, from: current.status, to: status }, 'Project status transition');
      return writeProjectUpdate(store, current, updateData);
    });
  },

  async tryActivate(projectId: string): Promise<boolean> {
    const store = getStore();
    return store.withLock(PROJECTS_LOCK_DIR, async () => {
      const current = await store.readJsonUncached<ProjectData>(projectPath(projectId));
      if (!current || current.status !== PROJECT_STATUS.PENDING) return false;
      logger.info({ projectId, from: current.status, to: PROJECT_STATUS.ACTIVE }, 'Project status transition');
      await writeProjectUpdate(store, current, {
        status: PROJECT_STATUS.ACTIVE,
        startedAt: current.startedAt ?? new Date().toISOString(),
      });
      logger.info({ projectId, pmoNumber: current.pmoNumber }, 'Project activated (pending → active)');
      return true;
    });
  },

  async delete(projectId: string) {
    const current = await getStore().readJson<ProjectData>(projectPath(projectId));
    if (!current) throw new Error('Project not found');
    if (current.status !== 'pending' && current.status !== 'cancelled') {
      throw new Error('Can only delete pending or cancelled projects');
    }
    await fs.promises.unlink(projectPath(projectId));
    logger.info({ projectId }, 'Project deleted');
    return { success: true };
  },

  async calculateProgress(projectId: string): Promise<number> {
    const project = await getStore().readJson<ProjectData>(projectPath(projectId));
    if (!project) return 0;
    const tasksPath = path.join(PROJECTS_DIR, projectId, 'tasks.jsonl');
    const tasks = await getStore().readJsonl<{ status?: string }>(tasksPath);
    if (tasks.length === 0) return project.progress;
    const completed = tasks.filter(t => t.status === 'completed').length;
    return Math.round((completed / tasks.length) * 100);
  },
};
