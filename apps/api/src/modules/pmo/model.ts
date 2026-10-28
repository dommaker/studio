/** PMO 项目领域模型与纯投影；不持有存储或跨域编排依赖。 */

export interface CreateProjectInput {
  companyId?: string;
  title: string;
  description?: string;
  requirement?: string;
  okrId?: string;
  priority?: string;
  gitBranch?: string;
  gitRepo?: string;
  /** 多工程入参：每个工程一条交付腿；缺省/空数组保持旧单腿行为。 */
  gitRepos?: string[];
  requirementsDocId?: string;
  deliveryPolicy?: DeliveryPolicy;
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
  deliveredAt?: string | null;
  deliveredBy?: string | null;
  deliverCommit?: string | null;
  map?: PmoMap | null;
  deliveries?: DeliveryLeg[];
}

export interface ProjectListOptions {
  status?: string;
  priority?: string;
  okrId?: string;
  limit?: number;
  offset?: number;
}

/** PMO 交付策略：auto-merge=studio 执行合并；branch-only=只标证据齐缺。 */
export type DeliveryPolicy = 'auto-merge' | 'branch-only';

export interface PmoDecision {
  wuId: string;
  summary: string;
  resolvedAt: string;
}

export type FogStatus = 'open' | 'in-discussion' | 'resolved';

export interface FogItem {
  id: string;
  question: string;
  wuId: string | null;
  status: FogStatus;
}

export interface PmoMap {
  destination: string;
  decisions: PmoDecision[];
  fog: FogItem[];
  specSpawnedAt?: string;
  specWuId?: string | null;
}

export interface DeliveryLeg {
  gitRepo: string | null;
  branch: string | null;
  status: DeliveryLegStatus;
  deliveredAt?: string | null;
  deliverCommit?: string | null;
}

/**
 * 腿状态：pending → active → in_review → completed → delivered。
 * delivered 不被回写；零 WU 腿不阻断整体翻转；未交付腿可随真实工作量回摆 active。
 */
export const LEG_STATUS = {
  PENDING: 'pending',
  ACTIVE: 'active',
  IN_REVIEW: 'in_review',
  COMPLETED: 'completed',
  DELIVERED: 'delivered',
} as const;

export type DeliveryLegStatus = typeof LEG_STATUS[keyof typeof LEG_STATUS];

/** 读取缺省视图：未设置 deliveries 时合成单腿，不落盘，老项目零迁移。 */
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
  reqAlias?: string | null;
  deliveryPolicy?: DeliveryPolicy;
  isChore?: boolean;
  channelId?: string | null;
  deliveredAt?: string | null;
  deliveredBy?: string | null;
  deliverCommit?: string | null;
  map?: PmoMap | null;
  deliveries?: DeliveryLeg[];
}

export function resolveDeliveryPolicy(project: Pick<ProjectData, 'deliveryPolicy'>): DeliveryPolicy {
  return project.deliveryPolicy ?? 'branch-only';
}

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

/** 从 pmoNumber 提取数字（兼容 PM-001 与 PMO-42）；无法解析返回 null。 */
export function parsePmoSeq(pmoNumber: string | null | undefined): number | null {
  const m = pmoNumber?.match(/^PMO?-(\d+)$/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function parsePmoNumberFromCommand(command: string): {
  type: 'link' | 'create' | 'auto';
  pmoNumber?: string;
} {
  const linkMatch = command.match(/@PM-(\d{3})/);
  if (linkMatch) return { type: 'link', pmoNumber: `PM-${linkMatch[1]}` };
  if (command.includes('#新项目')) return { type: 'create' };
  return { type: 'auto' };
}
