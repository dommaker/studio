/**
 * transcript-archive — transcript 归档器（#97，#88 子票）
 *
 * 会话原文落盘到数据区（经 studioDir()/studioPath()），供四个消费方共用：
 *   - #99 WU 收尾批量提取（要全文）
 *   - handoff 摘要（要对话）
 *   - #85 执行质量评估（要执行痕迹）
 *   - skill 度量地基票 B：skill 使用扫描（skills/skill-usage-scan.ts）
 *
 * 数据源选型：agent-loop 每步 `result.rawOutput`（raw CLI stdout，provider 无关）。
 * 单一来源同时满足三方：rawOutput 含完整对话 + 工具调用/执行痕迹，非摘要级截断，
 * 也不依赖 provider 的 CLI session jsonl 路径（claude ~/.claude/projects/... 等）。
 *
 * 归档时机/格式/路径/保留策略：
 *   - 时机：每步成功执行后 await 落盘；Assignment 终止后补 terminal，之前不算 committed
 *   - 格式：JSONL 同文件记录 step/terminal/consumer watermark（append-friendly）
 *   - 路径：studioPath('transcripts', '<workUnitId>.jsonl')——按任务（workUnitId）定位
 *   - 会话定位：每行携带 sessionId（metadata.sessionId 已维护 WU→session 映射）
 *   - 保留策略：不主动 GC（后续由 ops 按需清理）
 *
 * 测试隔离：与 shared log-path 同一约定 —— VITEST/NODE_ENV=test 时改写到
 * os.tmpdir()/studio-test-transcripts/<per-进程子目录>（文件名格式不变），防测试写生产
 * ~/.studio/transcripts（agent-loop 集成测试会触发本写入，须隔离）；per-进程子目录防
 * vitest 并行测试文件互踩（#135）。生产路径不变。
 *
 * 不落 metadata、不建独立索引：路径由 workUnitId 确定性推导（transcriptPath 纯函数），
 * 无需在 WorkUnitMetadata 冗余存 archive 路径。
 */
import { createHash } from 'node:crypto';
import * as path from 'node:path';

import { testTmpRoot } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { getStore } from '../../core/store.js';



/** 归档根目录名（studioDir() 下单层目录名） */
export const TRANSCRIPTS_DIR = 'transcripts';

/** 是否测试环境（vitest 设置 VITEST=true；CI/脚本常用 NODE_ENV=test），同 shared log-path */
export function isTestEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === 'test';
}

/**
 * 归档根目录：测试 → os.tmpdir()/studio-test-transcripts/<per-进程子目录>（testTmpRoot，#135）；
 * 生产 → studioPath('transcripts')（经 studioDir() 读 STUDIO_HOME，dev/prod 隔离，禁硬编码 ~/.studio）。
 */
export function transcriptsDir(env: NodeJS.ProcessEnv = process.env): string {
  return isTestEnv(env)
    ? testTmpRoot('studio-test-transcripts')
    : studioPath(TRANSCRIPTS_DIR);
}

/** 归档文件路径：<根目录>/<workUnitId>.jsonl（按任务 workUnitId 定位） */
export function transcriptPath(workUnitId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(transcriptsDir(env), `${workUnitId}.jsonl`);
}

const TERMINAL_STATUSES = ['succeeded', 'waiting', 'failed', 'superseded', 'cancelled'] as const;
export type TranscriptTerminalStatus = typeof TERMINAL_STATUSES[number];

function isTerminalStatus(status: string): status is TranscriptTerminalStatus {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** 本模块 transcript 引用的唯一构造/解析口。 */
export function transcriptStepRef(workUnitId: string, step: number): string {
  return `${transcriptPath(workUnitId)}#step=${step}`;
}

export function parseTranscriptStepRef(workUnitId: string, ref: string): number | null {
  const prefix = `${transcriptPath(workUnitId)}#step=`;
  if (!ref.startsWith(prefix)) return null;
  const step = Number(ref.slice(prefix.length));
  return Number.isSafeInteger(step) && step > 0 ? step : null;
}

/** 步骤或 Assignment 终止标记；无 kind 的历史步骤保持兼容。 */
export interface TranscriptEntry {
  workUnitId: string;
  assignmentId?: string;
  /** 本步会话号（WU 内可能因重建/续用切换，逐行记录） */
  sessionId?: string;
  /** 1 基步号（与 agent-loop recordResult 的 stepCount 同口径） */
  step: number;
  /** 本步 ACTION 结论（progress/complete/need_input/failed） */
  action?: string;
  /** 本步原文（raw CLI stdout；provider 无关，全文保留不截断） */
  rawOutput?: string;
  /** 内容身份；重试追加在读侧按此去重。 */
  contentId?: string;
  kind?: 'step' | 'terminal';
  status?: TranscriptTerminalStatus;
  reason?: string;
  /** 归档时间 ISO 8601 */
  createdAt: string;
}

export interface AppendTranscriptStepArgs {
  workUnitId: string;
  assignmentId?: string;
  sessionId?: string;
  step: number;
  action?: string;
  rawOutput?: string;
  createdAt?: string;
}

export interface FinalizeTranscriptAssignmentArgs {
  workUnitId: string;
  assignmentId: string;
  status: TranscriptTerminalStatus;
  /** false 表示上游已发现步骤缺失；即使 Assignment 成功也不能提交其内容。 */
  contentComplete?: boolean;
  createdAt?: string;
}

function contentIdentity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * 追加一步原文（JSONL 一行）。写盘失败抛出，调用方必须保留可重试事实。
 * 有 assignmentId 的新步骤显式标 kind=step，在 terminal 前不属于 committed prefix。
 */
export async function appendTranscriptStep(args: AppendTranscriptStepArgs): Promise<TranscriptEntry> {
  const contentId = contentIdentity({
    workUnitId: args.workUnitId,
    assignmentId: args.assignmentId,
    sessionId: args.sessionId,
    step: args.step,
    action: args.action,
    rawOutput: args.rawOutput,
  });
  const entry: TranscriptEntry = {
    workUnitId: args.workUnitId,
    ...(args.assignmentId ? { assignmentId: args.assignmentId, kind: 'step' as const } : {}),
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    step: args.step,
    ...(args.action ? { action: args.action } : {}),
    ...(args.rawOutput ? { rawOutput: args.rawOutput } : {}),
    contentId,
    createdAt: args.createdAt ?? new Date().toISOString(),
  };
  await getStore().appendJsonl(transcriptPath(args.workUnitId), entry);
  return entry;
}

/** 追加 Assignment 终止标记；重复终止由读侧 contentId 去重。 */
export async function finalizeTranscriptAssignment(args: FinalizeTranscriptAssignmentArgs): Promise<TranscriptEntry> {
  const rows = await getStore().readJsonl<TranscriptEntry>(transcriptPath(args.workUnitId));
  const step = rows.filter(row =>
    row.assignmentId === args.assignmentId && (row.kind === 'step' || row.kind === undefined))
    .reduce((latest, row) => Math.max(latest, row.step), 0);
  const status = args.contentComplete === false ? 'failed' : args.status;
  const contentId = contentIdentity({
    workUnitId: args.workUnitId,
    assignmentId: args.assignmentId,
    step,
    status,
    reason: args.contentComplete === false ? 'incomplete-write' : undefined,
  });
  const terminal: TranscriptEntry = {
    workUnitId: args.workUnitId,
    assignmentId: args.assignmentId,
    step,
    kind: 'terminal',
    status,
    ...(args.contentComplete === false ? { reason: 'incomplete-write' } : {}),
    contentId,
    createdAt: args.createdAt ?? new Date().toISOString(),
  };
  await getStore().appendJsonl(transcriptPath(args.workUnitId), terminal);
  return terminal;
}

interface TranscriptWatermark {
  kind: 'watermark';
  workUnitId: string;
  consumer: string;
  throughContentId: string;
  createdAt: string;
}

type TranscriptRow = TranscriptEntry | TranscriptWatermark;

/** 默认读口只暴露 committed prefix；旧的无 kind 步骤视为历史已提交内容。 */
function committedProjection(rows: TranscriptRow[]): TranscriptEntry[] {
  const committed: TranscriptEntry[] = [];
  const pending = new Map<string, TranscriptEntry[]>();
  const failedAssignments = new Set<string>();
  for (const row of rows) {
    if (row.kind === 'watermark') continue;
    if (row.kind === 'terminal' && row.assignmentId) {
      const segment = pending.get(row.assignmentId) ?? [];
      if (row.status === 'succeeded' || row.status === 'waiting') committed.push(...segment, row);
      else failedAssignments.add(row.assignmentId);
      pending.delete(row.assignmentId);
      continue;
    }
    if (row.kind === 'step' && row.assignmentId) {
      const segment = pending.get(row.assignmentId) ?? [];
      segment.push(row);
      pending.set(row.assignmentId, segment);
      continue;
    }
    committed.push(row);
  }
  const seen = new Set<string>();
  return committed.filter(row => {
    if (row.assignmentId && failedAssignments.has(row.assignmentId)) return false;
    const id = row.contentId ?? contentIdentity(row);
    if (seen.has(id)) return false;
    seen.add(id);
    if (!row.contentId) row.contentId = id;
    return true;
  });
}

async function readTranscriptRows(workUnitId: string): Promise<TranscriptRow[]> {
  return getStore().readJsonl<TranscriptRow>(transcriptPath(workUnitId));
}

/**
 * 按任务读取 committed transcript。写入中/失败段不返回；文件不存在 → []。
 */
export async function readTranscript(workUnitId: string): Promise<TranscriptEntry[]> {
  return committedProjection(await readTranscriptRows(workUnitId));
}

export interface ConsumeTranscriptOptions {
  /** 恢复包需要全量稳定引用时重放 committed 内容，仍记录本 consumer 的最新水位。 */
  replay?: boolean;
}

export interface ConsumeTranscriptResult<T> {
  value: T;
  consumed: number;
  /** 是否仍存在写入中或失败段；调用方不得把它们当作完成消费。 */
  hasUncommitted: boolean;
  /** 是否有没有任何 terminal 的写入中段；即使有其他 committed 增量也不得提前完成。 */
  hasWriting: boolean;
}

/** 处理成功后推进本 consumer 的独立水位；callback/水位写失败均可重试。 */
export async function consumeTranscript<T>(
  workUnitId: string,
  consumer: string,
  consume: (entries: TranscriptEntry[]) => Promise<T>,
  options: ConsumeTranscriptOptions = {},
): Promise<ConsumeTranscriptResult<T>> {
  if (!consumer.trim()) throw new Error('transcript consumer is required');
  const rows = await readTranscriptRows(workUnitId);
  const committed = committedProjection(rows);
  const watermark = [...rows].reverse().find((row): row is TranscriptWatermark =>
    row.kind === 'watermark' && row.consumer === consumer);
  const watermarkIndex = watermark
    ? committed.findIndex(row => row.contentId === watermark.throughContentId)
    : -1;
  const entries = options.replay ? committed : committed.slice(watermarkIndex + 1);
  const value = await consume(entries);

  const throughContentId = committed.at(-1)?.contentId;
  if (throughContentId && watermark?.throughContentId !== throughContentId) {
    await getStore().appendJsonl(transcriptPath(workUnitId), {
      kind: 'watermark',
      workUnitId,
      consumer,
      throughContentId,
      createdAt: new Date().toISOString(),
    } satisfies TranscriptWatermark);
  }
  const committedIds = new Set(committed.map(row => row.contentId));
  const hasUncommitted = rows.some(row =>
    (row.kind === 'step' || row.kind === 'terminal') && !committedIds.has(row.contentId));
  const terminatedAssignments = new Set(rows.flatMap(row =>
    row.kind === 'terminal' && row.assignmentId ? [row.assignmentId] : []));
  const hasWriting = rows.some(row =>
    row.kind === 'step' && row.assignmentId
    && !committedIds.has(row.contentId) && !terminatedAssignments.has(row.assignmentId));
  return { value, consumed: entries.length, hasUncommitted, hasWriting };
}

/** WorkUnit 当前快照中与 transcript 对账有关的最小事实。 */
export interface TranscriptAssignmentSnapshot {
  id: string;
  assignments?: Array<{
    id: string;
    status: string;
    transcriptCount?: number;
  }>;
  stepRecords?: Array<{
    assignmentId?: string;
    transcriptRefs?: string[];
  }>;
}

/** 按已持久化的 Assignment/StepRecord 补写终止标记；缺步骤时 fail-closed。 */
export async function reconcileTranscriptAssignments(snapshot: TranscriptAssignmentSnapshot): Promise<void> {
  const rows = await readTranscriptRows(snapshot.id);
  for (const assignment of snapshot.assignments ?? []) {
    if (!isTerminalStatus(assignment.status)) continue;
    if (rows.some(row => row.kind === 'terminal' && row.assignmentId === assignment.id)) continue;

    const steps = rows.filter((row): row is TranscriptEntry =>
      (row.kind === 'step' || row.kind === undefined) && row.assignmentId === assignment.id);
    const stepNumbers = new Set(steps.map(step => step.step));
    const expectedSteps = new Set((snapshot.stepRecords ?? [])
      .filter(record => record.assignmentId === assignment.id)
      .flatMap(record => record.transcriptRefs ?? [])
      .map(ref => parseTranscriptStepRef(snapshot.id, ref))
      .filter((step): step is number => step !== null));
    const uniqueStepCount = new Set(steps.map(step => step.contentId ?? contentIdentity(step))).size;
    const contentComplete = uniqueStepCount >= (assignment.transcriptCount ?? 0)
      && [...expectedSteps].every(step => stepNumbers.has(step));
    await finalizeTranscriptAssignment({
      workUnitId: snapshot.id,
      assignmentId: assignment.id,
      status: assignment.status,
      contentComplete,
    });
  }
}
