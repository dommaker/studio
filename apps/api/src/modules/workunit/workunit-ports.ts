/**
 * ARCH-02 WorkUnit 跨域端口。接口归调用方，bootstrap/module-sinks 装配实现；
 * 本文件不得 import channels/pmo/requirements/agent-loop/agents/ops/audit-logs。
 */
import type { FileStore, WorkUnitSnapshot } from '@dommaker/studio-shared';
import type { WuVerifyOutcome } from '../../core/wu-verification.js';
import type { WorkUnitData } from './workunit-crud.js';
import type { WorkUnitMetadata } from './workunit.types.js';

export interface WorkUnitMessageMeta {
  atHuman?: boolean;
  pmoId?: string;
  cardType?: string;
  options?: { label: string; description?: string; value?: string }[];
  [key: string]: unknown;
}

export interface WorkUnitMessageRecord {
  id: string;
  channelId: string;
  workUnitId: string | null;
  authorType: string;
  agentName: string | null;
  content: string;
  replyToId: string | null;
  meta: unknown;
  createdAt: Date;
}

export interface WorkUnitMessagePort {
  createAgentMessage(input: {
    fileStore: FileStore; channelId: string; agentName: string; content: string;
    replyToId?: string; meta?: WorkUnitMessageMeta; workUnitId?: string;
  }): Promise<WorkUnitMessageRecord>;
  createHumanMessage(input: {
    fileStore: FileStore; channelId: string; content: string; replyToId?: string; workUnitId?: string;
  }): Promise<WorkUnitMessageRecord>;
  updateMessage(input: {
    fileStore: FileStore; messageId: string; channelId: string; content?: string; meta?: WorkUnitMessageMeta;
  }): Promise<WorkUnitMessageRecord>;
  listByWorkUnitId(input: {
    fileStore: FileStore; workUnitId: string; channelId?: string; before?: Date; limit?: number;
  }): Promise<{ data: WorkUnitMessageRecord[]; total: number }>;
  linkWorkUnit(input: { fileStore: FileStore; messageId: string; workUnitId: string; channelId: string }): Promise<unknown>;
  resolveRouting(input: {
    fileStore: FileStore; channelId: string; stage: 'implement'; notConfiguredText: string;
  }): Promise<{
    resolution: { profileId: string | null; fallback?: string; profileName?: string };
    notice: string | null;
  }>;
}

export interface WorkUnitAuditActor { id: string; type: 'human' | 'agent' }
export interface WorkUnitAuditRecord {
  action: string;
  resource: string;
  resourceId?: string;
  actor?: WorkUnitAuditActor;
  status?: 'success' | 'failure';
  details?: Record<string, unknown>;
  requestId?: string;
}
export type WorkUnitAuditPort = (entry: WorkUnitAuditRecord) => void;

export interface WorkUnitProjectReadPort {
  resolvePmoId(wu: { reqId?: string | null; metadata?: string | null }, fileStore: FileStore): Promise<string | null>;
  selectProjectSnapshots(projectId: string, fileStore: FileStore, snapshots: WorkUnitSnapshot[]): Promise<WorkUnitSnapshot[]>;
  bindRequirementToProject(reqId: string, project: { name: string; path: string }, fileStore: FileStore): Promise<void>;
}

export interface WorkUnitVerificationPort {
  isCodeWorktreeType(type: string): boolean;
  resolveCommands(wu: WorkUnitData, metadata: WorkUnitMetadata, cwd: string): Promise<{ commands: string[]; source: 'override' | 'convention' }>;
  run(wu: WorkUnitData, metadata: WorkUnitMetadata, cwd: string, options?: { cwdProvenance: 'merge-target' }): Promise<WuVerifyOutcome>;
}

export interface WorkUnitPlanRulingItem { question: string; action: 'accept' | 'reopen'; conclusion?: string }
export interface WorkUnitPlanDirectionPick { choice: string; note?: string }
export interface WorkUnitReviewPort {
  dispatchReviewNow(workUnitId: string): Promise<{ id: string }>;
  validatePlanConfirm(workUnit: WorkUnitData, tasks: NonNullable<WorkUnitMetadata['analysisTaskDetails']>): Promise<unknown>;
  isPlanTaskLegError(error: unknown): boolean;
  validateRulingItems(raw: unknown): WorkUnitPlanRulingItem[];
  applyPlanRuling(workUnitId: string, items: WorkUnitPlanRulingItem[], fileStore: FileStore): Promise<WorkUnitData>;
  isPlanRulingError(error: unknown): boolean;
  validateDirectionPick(raw: unknown, directions: NonNullable<WorkUnitMetadata['planDirections']>): WorkUnitPlanDirectionPick;
  applyPlanDirection(workUnitId: string, pick: WorkUnitPlanDirectionPick, fileStore: FileStore): Promise<WorkUnitData>;
  isPlanDirectionError(error: unknown): boolean;
}

export interface WorkUnitExecutionPort {
  run(prompt: string, options: { systemPrompt: string; cwd: string; eventSource: 'merge-conflict-resolution' }): Promise<{ output: string; durationMs: number }>;
}

export interface WorkUnitReadPort {
  aggregateTreeTokens(rootId: string, fileStore: FileStore): Promise<unknown>;
}

export interface WorkUnitAlertPort {
  dispatch(alerts: Array<{ source: 'in_review_orphan'; level: 'warning'; subject: string; relatedTaskIds: string[]; message: string }>): void;
}

export interface WorkUnitPorts {
  message: WorkUnitMessagePort;
  audit: WorkUnitAuditPort;
  projectRead: WorkUnitProjectReadPort;
  verification: WorkUnitVerificationPort;
  review: WorkUnitReviewPort;
  execution: WorkUnitExecutionPort;
  read: WorkUnitReadPort;
  alert: WorkUnitAlertPort;
}

const ports: Partial<WorkUnitPorts> = {};

/** 装配/测试按类别注入；重复注册覆盖旧实现，resetWorkUnitPorts 全量复位。 */
export function registerWorkUnitPorts(next: Partial<WorkUnitPorts>): void {
  Object.assign(ports, next);
}

export function resetWorkUnitPorts(): void {
  for (const key of Object.keys(ports) as Array<keyof WorkUnitPorts>) delete ports[key];
  lazyPortLoader = null;
}

type WorkUnitPortLoader = (name: keyof WorkUnitPorts) => Promise<void>;
let lazyPortLoader: WorkUnitPortLoader | null = null;

/** 测试专用：首次取端口时才加载组合步骤；生产不注册 loader，保留组合根 fail-fast。 */
export function registerWorkUnitPortLoader(loader: WorkUnitPortLoader | null): void {
  lazyPortLoader = loader;
}

/** 必需跨域能力未装配 = 组合根错误，fail-fast，禁止生产动态 import 隐蔽兜底。 */
export async function workUnitPort<K extends keyof WorkUnitPorts>(name: K): Promise<WorkUnitPorts[K]> {
  if (!ports[name] && lazyPortLoader) await lazyPortLoader(name);
  const port = ports[name];
  if (!port) throw new Error(`WorkUnit ${name} port 未注册（bootstrap/module-sinks 应完成装配）`);
  return port;
}
