/**
 * transcript-archive — transcript 归档器（#97，#88 子票）
 *
 * 会话原文落盘到数据区（经 studioDir()/studioPath()），供三个消费方共用：
 *   - #99 WU 收尾批量提取（要全文）
 *   - handoff 摘要（要对话）
 *   - #85 执行质量评估（要执行痕迹）
 *
 * 数据源选型：agent-loop 每步 `result.rawOutput`（raw CLI stdout，provider 无关）。
 * 单一来源同时满足三方：rawOutput 含完整对话 + 工具调用/执行痕迹，非摘要级截断，
 * 也不依赖 provider 的 CLI session jsonl 路径（claude ~/.claude/projects/... 等）。
 *
 * 归档时机/格式/路径/保留策略（最简，实现期定）：
 *   - 时机：每步成功执行后追加一行（会话结束即完整，天然可检索）
 *   - 格式：JSONL，一行一步（append-friendly；损坏行读时跳过）
 *   - 路径：studioPath('transcripts', '<workUnitId>.jsonl')——按任务（workUnitId）定位
 *   - 会话定位：每行携带 sessionId（metadata.sessionId 已维护 WU→session 映射）
 *   - 保留策略：不主动 GC（后续由 ops 按需清理）
 *
 * 测试隔离：与 studio-log-path 同一约定 —— VITEST/NODE_ENV=test 时改写到
 * os.tmpdir()/studio-test-transcripts（文件名格式不变），防测试写生产 ~/.studio/transcripts
 * （agent-loop 集成测试会触发本写入，须隔离）。生产路径不变。
 *
 * 不落 metadata、不建独立索引：路径由 workUnitId 确定性推导（transcriptPath 纯函数），
 * 无需在 WorkUnitMetadata 冗余存 archive 路径。
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { FileStore } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';

const store = new FileStore();

/** 归档根目录名（studioDir() 下单层目录名） */
export const TRANSCRIPTS_DIR = 'transcripts';

/** 是否测试环境（vitest 设置 VITEST=true；CI/脚本常用 NODE_ENV=test），同 studio-log-path */
export function isTestEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.VITEST) || env.NODE_ENV === 'test';
}

/**
 * 归档根目录：测试 → os.tmpdir()/studio-test-transcripts；生产 → studioPath('transcripts')
 * （经 studioDir() 读 STUDIO_HOME，dev/prod 隔离，禁硬编码 ~/.studio）。
 */
export function transcriptsDir(env: NodeJS.ProcessEnv = process.env): string {
  return isTestEnv(env)
    ? path.join(os.tmpdir(), 'studio-test-transcripts')
    : studioPath(TRANSCRIPTS_DIR);
}

/** 归档文件路径：<根目录>/<workUnitId>.jsonl（按任务 workUnitId 定位） */
export function transcriptPath(workUnitId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(transcriptsDir(env), `${workUnitId}.jsonl`);
}

/** 单步归档条目（JSONL 一行） */
export interface TranscriptEntry {
  workUnitId: string;
  /** 本步会话号（WU 内可能因重建/续用切换，逐行记录） */
  sessionId?: string;
  /** 1 基步号（与 agent-loop recordResult 的 stepCount 同口径） */
  step: number;
  /** 本步 ACTION 结论（progress/complete/need_input/failed） */
  action?: string;
  /** 本步原文（raw CLI stdout；provider 无关，全文保留不截断） */
  rawOutput?: string;
  /** 归档时间 ISO 8601 */
  createdAt: string;
}

export interface AppendTranscriptStepArgs {
  workUnitId: string;
  sessionId?: string;
  step: number;
  action?: string;
  rawOutput?: string;
  createdAt?: string;
}

/**
 * 追加一步原文（JSONL 一行）。写盘失败抛出，调用方按 fire-and-forget 兜底。
 */
export async function appendTranscriptStep(args: AppendTranscriptStepArgs): Promise<void> {
  const entry: TranscriptEntry = {
    workUnitId: args.workUnitId,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    step: args.step,
    ...(args.action ? { action: args.action } : {}),
    ...(args.rawOutput ? { rawOutput: args.rawOutput } : {}),
    createdAt: args.createdAt ?? new Date().toISOString(),
  };
  await store.appendJsonl(transcriptPath(args.workUnitId), entry);
}

/**
 * 按任务（workUnitId）读取全文 transcript。文件不存在 → []（不抛出）。
 */
export async function readTranscript(workUnitId: string): Promise<TranscriptEntry[]> {
  return store.readJsonl<TranscriptEntry>(transcriptPath(workUnitId));
}
