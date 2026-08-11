/**
 * Project Service - PMO 项目管理
 *
 * GEN-005: PMO 号生成 + 项目 CRUD
 * Spec 3: 迁移到 FileStore (~/.studio/projects/{id}.json)
 */

import { FileStore, generateId } from '@dommaker/studio-shared';
import { logger } from '../../utils/logger.js';
import { channelMessageService } from '../channels/channel-message.service.js';
import { WorkUnitService } from '../workunit/workunit.service.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { studioPath } from '@dommaker/studio-shared/studio-dir';

const PROJECTS_DIR = studioPath('projects');

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
  /**
   * #114 T8：多工程入参（创建表单多选）。每个选中工程落一条交付腿
   * （branch 按现有 pmo-<n> 规则合成，显式 gitBranch 可覆盖全腿）；
   * 缺省/空数组 = 旧单选行为（不落 deliveries，读取时合成单腿）。
   */
  gitRepos?: string[];
  requirementsDocId?: string;
  /** F6/PMO-a：交付策略（默认 branch-only——不碰合并与发布链路，只标记证据齐缺） */
  deliveryPolicy?: DeliveryPolicy;
  /** 决策 2：杂务 PMO 标记与归属频道（长期分支，小活归集） */
  isChore?: boolean;
  channelId?: string | null;
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
  deliveryPolicy?: DeliveryPolicy;
  requirementsDocId?: string | null;
  /** PMO-b：交付落档（deliverProject 写入） */
  deliveredAt?: string | null;
  deliveredBy?: string | null;
  deliverCommit?: string | null;
  /** #107 T1：探路地图（M7 开图机制写入；null = 非探路型） */
  map?: PmoMap | null;
  /** #107 T1：多交付腿（缺省读取时合成单腿，写入则按显式多腿） */
  deliveries?: DeliveryLeg[];
}

export interface ProjectListOptions {
  status?: string;
  priority?: string;
  okrId?: string;
  limit?: number;
  offset?: number;
}

/** PMO 交付策略：auto-merge=studio 执行合并（缺证据硬拒）；branch-only=默认，只标证据齐缺 */
export type DeliveryPolicy = 'auto-merge' | 'branch-only';

// ============================================
// #107 T1（#106 spec）：探路地图 + 多交付腿
// 两个字段均可选、缺省零迁移——老项目 JSON 读出行为与现状一致。
// ============================================

/** 决策落地记录（M1：decision 单人工确认时填写的一句话结论，机制原样存） */
export interface PmoDecision {
  wuId: string;
  summary: string;
  resolvedAt: string;
}

export type FogStatus = 'open' | 'in-discussion' | 'resolved';

/** 雾条目（待决问题）；wuId = 认领该问题的 decision WU，未认领为 null */
export interface FogItem {
  id: string;
  question: string;
  wuId: string | null;
  status: FogStatus;
}

/** 探路地图。缺省 null = 非探路型需求，行为与现状一致 */
export interface PmoMap {
  destination: string;
  decisions: PmoDecision[];
  fog: FogItem[];
  /** #110 T4：雾全清后 spec 成文单已派生时间戳（幂等哨兵，照 analysisTasksSpawnedAt 先例先落档） */
  specSpawnedAt?: string;
  /** #110 T4：自动建成的 spec 单 id（溯源回写；幂等判定只看 specSpawnedAt） */
  specWuId?: string | null;
}

/** 交付腿（多腿交付按腿独立台账/合并/状态，T7 起消费） */
export interface DeliveryLeg {
  gitRepo: string | null;
  branch: string | null;
  status: string;
  /** #113 T7：auto-merge 逐腿交付落档（branch-only 永不写；合成单腿不落盘） */
  deliveredAt?: string | null;
  deliverCommit?: string | null;
}

/**
 * #113 T7 腿状态词表（progress-rollup 按腿独立演进；仅显式多腿项目回写）：
 *   pending → active（腿内有在途 WU）
 *   pending/active → in_review（腿内 WU 全完结但证据有缺口，等验收）
 *   → completed（腿内 WU 全完结且证据齐）→ delivered（auto-merge 已合，终态）
 * delivered 不被回写；零 WU 腿状态不动、不阻断整体翻转（无活可交视为满足）。
 * #115：completed/in_review 可回摆 active——派生物化（spec-materialization）/人工补单
 * 会让已完结腿重新出现在途 WU，腿状态随真实工作量回摆（delivered 终态除外）。
 */
export const LEG_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  IN_REVIEW: 'in_review',
  COMPLETED: 'completed',
  DELIVERED: 'delivered',
} as const;

export type DeliveryLegStatus = typeof LEG_STATUS[keyof typeof LEG_STATUS];

/**
 * 交付腿缺省解析：未设置 deliveries 时由现有 gitRepo/gitBranch 合成单腿
 * （读取时合成、不落盘，老项目零迁移；单腿 = 现状行为）。
 * 合成腿 status 从 deliveredAt 派生（已交付的老项目读出 'delivered' 而非硬编码 'pending'）；
 * 显式多腿的 status 词表 = LEG_STATUS（#113 T7，progress-rollup 逐腿回写、deliverProject 逐腿落档）。
 */
export function resolveDeliveries(
  project: Pick<ProjectData, 'gitRepo' | 'gitBranch' | 'deliveredAt'> & { deliveries?: DeliveryLeg[] },
): DeliveryLeg[] {
  if (Array.isArray(project.deliveries) && project.deliveries.length > 0) return project.deliveries;
  return [{
    gitRepo: project.gitRepo ?? null,
    branch: project.gitBranch ?? null,
    status: project.deliveredAt ? 'delivered' : 'pending',
  }];
}

/** 读取默认视图：deliveries 缺省合成单腿（map 缺省即非探路型，无需合成）。所有读取路径统一走此口径 */
function withReadDefaults(project: ProjectData): ProjectData {
  return { ...project, deliveries: resolveDeliveries(project) };
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
  /** PMO-a（决策 4）：REQ 只读别名（REQ-XXXX），统一编号对象才有；存量 legacy 项目为 null/缺省 */
  reqAlias?: string | null;
  /** PMO-a：交付策略（缺省 = branch-only，见 resolveDeliveryPolicy） */
  deliveryPolicy?: DeliveryPolicy;
  /** 决策 2：杂务 PMO（频道常青小活归集），isChore + channelId 联合标识 */
  isChore?: boolean;
  channelId?: string | null;
  /** PMO-b：auto-merge 交付记录（人确认交付后落档；branch-only 永不写） */
  deliveredAt?: string | null;
  deliveredBy?: string | null;
  deliverCommit?: string | null;
  /** #107 T1：探路地图（缺省 null = 非探路型，行为同现状） */
  map?: PmoMap | null;
  /** #107 T1：多交付腿（缺省 = 读取时由 gitRepo/gitBranch 合成单腿，见 resolveDeliveries） */
  deliveries?: DeliveryLeg[];
}

/** 交付策略缺省解析：未设置一律 branch-only（不碰合并/发布链路是默认姿态） */
export function resolveDeliveryPolicy(project: Pick<ProjectData, 'deliveryPolicy'>): DeliveryPolicy {
  return project.deliveryPolicy ?? 'branch-only';
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

async function readAllProjects(): Promise<ProjectData[]> {
  try {
    const dirents = await fs.promises.readdir(PROJECTS_DIR, { withFileTypes: true });
    const files = dirents.filter(d => d.isFile() && d.name.endsWith('.json'));
    const projects: ProjectData[] = [];
    for (const f of files) {
      const data = await fileStore.readJson<ProjectData>(path.join(PROJECTS_DIR, f.name));
      if (data) projects.push(withReadDefaults(data));
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

/** 从 pmoNumber 提取数字（兼容 PM-001 与 PMO-42 两种格式）；无法解析返回 null */
export function parsePmoSeq(pmoNumber: string | null | undefined): number | null {
  const m = pmoNumber?.match(/^PMO?-(\d+)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** REQ 序号目录（决策 4：统一编号需把 REQ 序列纳入 max 扫描） */
const REQUIREMENTS_DIR = studioPath('data', 'requirements');

/** 存量 REQ 最大序号（文件 + index.json nextSeq-1；目录不存在/读取失败 → 0） */
async function scanMaxRequirementSeq(): Promise<number> {
  try {
    // 不带 withFileTypes 时返回文件名字符串；防御 mock/异常返回 Dirent 的情形
    const entries = await fs.promises.readdir(REQUIREMENTS_DIR);
    let max = 0;
    for (const entry of entries) {
      const name = typeof entry === 'string' ? entry : (entry as { name?: string }).name ?? '';
      const m = name.match(/^REQ-(\d+)\.json$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    const idx = await fileStore.readJson<{ nextSeq?: number }>(path.join(REQUIREMENTS_DIR, 'index.json'));
    if (typeof idx?.nextSeq === 'number' && idx.nextSeq > 1) max = Math.max(max, idx.nextSeq - 1);
    return max;
  } catch {
    return 0;
  }
}

/**
 * 统一编号（决策 4 修正版）：新编号 = max(PM/PMO 两序列, REQ 序列) + 1，
 * 新格式 PMO-<n>（不补零，即分支名；存量 PM-XXX 格式保留不迁移）。
 * REQ-x 与 PMO-x 同号同对象（REQ 退化为只读别名，见 requirement.service 别名层）。
 */
export async function generatePmoNumber(): Promise<string> {
  const projects = await readAllProjects();

  let maxNum = 0;
  for (const proj of projects) {
    const num = parsePmoSeq(proj.pmoNumber);
    if (num !== null && num > maxNum) maxNum = num;
  }
  maxNum = Math.max(maxNum, await scanMaxRequirementSeq());

  const nextNumber = maxNum + 1;
  const pmoNumber = `PMO-${nextNumber}`;
  logger.info({ pmoNumber }, 'Generated PMO number (unified sequence)');

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
    const id = generateId('proj');
    const now = new Date().toISOString();
    // 决策 4：REQ 别名与 PMO 同号（REQ-0042 ↔ PMO-42）；决策 3/§4.5：分支名 = PMO id
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
      gitBranch: input.gitBranch || pmoNumber,  // 分支名 = PMO id（显式指定可覆盖）
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

    // #114 T8：多工程入参——每选中工程一条腿（gitRepo 兼容字段取首工程；
    // 空白项剔除后为空 = 旧单选行为，不落 deliveries）
    const repos = (input.gitRepos ?? []).map(r => r.trim()).filter(Boolean);
    if (repos.length > 0) {
      project.gitRepo = repos[0];
      project.deliveries = repos.map(repo => ({
        gitRepo: repo,
        branch: project.gitBranch,
        status: 'pending',
      }));
    }

    await fileStore.writeJson(projectPath(id), project);
    logger.info({ projectId: id, pmoNumber, reqAlias }, 'Project created');
    return project;
  },

  async get(projectId: string): Promise<ProjectData | null> {
    const data = await fileStore.readJson<ProjectData>(projectPath(projectId));
    // #107 T1：读取时合成单腿（不落盘，老项目零迁移）；map 缺省即非探路型，无需合成
    return data ? withReadDefaults(data) : null;
  },

  /** 决策 4 别名层：按 REQ 别名反查 PMO（REQ-XXXX → 统一编号对象）；存量无别名 → null */
  async getByReqAlias(reqId: string): Promise<ProjectData | null> {
    const projects = await readAllProjects();
    return projects.find(p => p.reqAlias === reqId) || null;
  },

  /**
   * 决策 2：频道杂务 PMO —— find-or-create（同频道幂等）。
   * 小活归集的长期分支；deliveryPolicy 固定 branch-only，状态直接 active。
   */
  async ensureChoreProject(channelId: string, channelName?: string | null): Promise<ProjectData> {
    const projects = await readAllProjects();
    const existing = projects.find(p => p.isChore === true && p.channelId === channelId);
    if (existing) return existing;
    const project = await this.create({
      title: `杂务 · ${channelName ?? channelId}`,
      description: '频道杂务 PMO（决策 2）：小活归集的常青容器，需求级工作请单建 PMO',
      deliveryPolicy: 'branch-only',
      isChore: true,
      channelId,
    });
    // 杂务 PMO 直接 active（不等 publish；进度回写不读 pending，但 active 语义更正）
    return this.updateStatus(project.id, PROJECT_STATUS.ACTIVE, true);
  },

  /** 决策 2 读取路径：只查不建（热路径零副作用——找不到返回 null 走 legacy） */
  async findChoreProject(channelId: string): Promise<ProjectData | null> {
    const projects = await readAllProjects();
    return projects.find(p => p.isChore === true && p.channelId === channelId) || null;
  },

  async getByPmoNumber(pmoNumber: string): Promise<ProjectData | null> {
    const projects = await readAllProjects();
    const exact = projects.find(p => p.pmoNumber === pmoNumber);
    if (exact) return exact;
    // 数字归一匹配（#PMO-42 / #PM-042 / #PM-42 同号；决策 4 统一编号后新旧格式并存）
    const seq = parsePmoSeq(pmoNumber);
    if (seq === null) return null;
    return projects.find(p => parsePmoSeq(p.pmoNumber) === seq) || null;
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
    // #112 T6 多腿分析单：显式多腿（deliveries > 1）时 scope 注入全部仓库路径
    // （只读约束不变、无 worktree 隔离）。单腿（无 deliveries 时读取合成的单腿）
    // 不注入——scope 与现状逐字节一致（回归硬要求）。
    const legs = resolveDeliveries(project);
    const multiLegSection = legs.length > 1
      ? `\n\n## 多交付腿（只读范围）\n本需求跨 ${legs.length} 个仓库交付，分析须覆盖以下全部仓库路径（均为只读，约束同上，不做 worktree 隔离）：\n`
        + legs.map(leg => `- ${leg.gitRepo ?? '（未设置仓库路径）'}${leg.branch ? `（分支 ${leg.branch}）` : ''}`).join('\n')
      : '';
    const workUnit = await workUnitService.create({
      type: 'analysis',
      scope: `分析需求 ${project.pmoNumber}: ${project.title}

${project.requirement || ''}
${multiLegSection}
## 工作方式约束（只读分析，重要）
你是分析角色，只读不改：禁止创建/修改/删除任何文件（不使用 Edit/Write/NotebookEdit），禁止执行会改变工作区状态的命令（git commit/checkout/clean、包管理器 install、写临时脚本等）。只用 Read/Grep/Glob 和只读 Bash（git log/diff/status、ls、cat、grep 等）。分析结论直接以 markdown 输出在回复里，不落盘。

## 输出约定（分析接力）

分析完成后，除 ACTION 行外，逐行输出拆分后的实现任务（每条一行，3~8 条，每条可被独立认领、独立完成）：
TASK: <任务描述>
需求很小无需拆分时可不输出 TASK 行。结论由人工确认后，系统按 TASK 行自动建任务并派工。`,
      channelId: input.channelId,
      metadata: {
        pmoId: project.id,
        pmoNumber: project.pmoNumber,
        // B3a 归属链接线：gitRepo 落 metadata.workspaceRoot，agent-loop 执行根解析
        // （resolveExecutionWorkspaceRoot）优先消费——analysis 及其派生 task WU
        // （analysis-handoff 继承该字段）才能走 per-WU worktree + PMO 分支，
        // 否则直接在共享开发仓落地、review 审的也不是隔离分支。
        ...(project.gitRepo ? { workspaceRoot: project.gitRepo } : {}),
      },
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
