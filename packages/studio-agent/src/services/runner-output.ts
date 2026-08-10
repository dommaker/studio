/**
 * Runner Output — 输出解析（agent-runner.ts 拆分模块）
 *
 * 从 agent-runner.ts 按职责拆出的执行输出/状态解析逻辑：
 *   - processSessionOutput: spawn 尾部管线（写 .agent.log → stream-json 解析 →
 *     tool/file 事件 → session 指标 → session:end），runner-execution 与
 *     runner-lightweight 共用（Wave-4 抽取，原为两处近乎逐字的副本）
 *   - hasRecentActivity: worktree 文件 mtime 探测（stuck 判定的延期依据）
 *   - queryResolutionHints: RKB 已知解法查询（session 错误输出 → resolutionHint）
 *
 * isError 的告警/分支语义两个调用方不同（execution 继续循环、lightweight 返回失败），
 * 故保留在调用方；跨 session token 累计亦由调用方基于返回的 streamUsage 完成。
 */

import * as path from 'path';
import * as fsSync from 'fs';
import {
  FileStore,
  parseStreamEvents,
  extractToolCalls,
  extractFilePath as extractFilePathShared,
  extractResult,
  extractUsage,
} from '@dommaker/studio-shared';
import type { StreamEvent } from '@dommaker/studio-shared';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import {
  recordSessionMetrics,
  emitSessionEnd,
  emitToolCall,
  emitFileChange,
  getConstraintMeta,
} from './output-capture.js';

const fileStore = new FileStore();

/** extractUsage 的聚合 token 用量类型（CLI 未回报时各项为 0）。 */
export type StreamUsage = ReturnType<typeof extractUsage>;

/** processSessionOutput 的调用上下文（两个执行路径的差异项全部由 ctx 传入）。 */
export interface ProcessSessionOutputContext {
  logFile: string;
  sessionId: string;
  executionId: string;
  sessionCount: number;
  isFirstSession: boolean;
  /** 调用方算好的 session 耗时（Date.now() - sessionStart）。 */
  sessionMs: number;
  agentRole: string;
  stage?: string;
  promptSize: number;
}

export interface ProcessedSessionOutput {
  text: string;
  isError: boolean;
  streamUsage: StreamUsage;
  events: StreamEvent[];
}

/**
 * Spawn 尾部管线：落盘原始 stdout → 解析 stream-json → 发射 tool:call/file:change →
 * 记录 session 指标 → 发射 session:end。
 *
 * 返回解析结果供调用方分支：execution 路径据此累计跨 session token 并续接循环，
 * lightweight 路径据此组装 ExecutionResult。isError 的告警/失败分支留在调用方
 * （两处语义不同，见模块头注释）。
 */
export async function processSessionOutput(
  stdout: string,
  ctx: ProcessSessionOutputContext,
): Promise<ProcessedSessionOutput> {
  fsSync.writeFileSync(ctx.logFile, stdout, 'utf-8');

  // AC1.1 + AC1.3: Parse stream-json line by line
  const events = parseStreamEvents(stdout);
  const { text, isError } = extractResult(events);
  const streamUsage = extractUsage(events);

  // AC1.3: Emit tool:call and file:change events
  const tools = extractToolCalls(events);
  for (const tool of tools) {
    await emitToolCall(tool.name, tool.input, ctx.sessionId, ctx.executionId);
    const filePath = extractFilePathShared(tool.name, tool.input);
    if (filePath) {
      await emitFileChange(filePath, ctx.sessionId, ctx.executionId);
    }
  }

  // Record session metrics
  const { hash, size } = await getConstraintMeta();
  await recordSessionMetrics({
    stdout,
    executionId: ctx.executionId,
    agentRole: ctx.agentRole,
    stage: ctx.stage,
    sessionCount: ctx.sessionCount,
    isFirstSession: ctx.isFirstSession,
    sessionMs: ctx.sessionMs,
    promptSize: ctx.promptSize,
    constraintHash: hash,
    constraintSize: size,
    streamUsage,
  });

  await emitSessionEnd(ctx.sessionId, ctx.executionId, ctx.sessionCount);

  return { text, isError, streamUsage, events };
}

/** Files excluded from mtime check (agent writes these regardless of real progress) */
const MTIME_EXCLUDED_FILES = new Set(['.progress.json', '.agent.log']);

/**
 * Check if any file in the worktree was modified within the threshold.
 * Used to defer stuck detection during I/O waits (npm install, tsc, vitest).
 *
 * Scans top-level files + src/ directory (recursive). Excludes node_modules,
 * .progress.json, .agent.log, and all dot-prefixed entries.
 * Caps at 200 stat calls to keep check under 100ms.
 */
export function hasRecentActivity(worktreePath: string, thresholdMs = 3 * 60 * 1000): boolean {
  const cutoff = Date.now() - thresholdMs;
  let statCalls = 0;
  const MAX_STATS = 200;

  if (!fsSync.existsSync(worktreePath)) {
    return false;
  }

  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync(worktreePath, { withFileTypes: true });
  } catch {
    return false;
  }

  /** Check a single file's mtime. Returns true if recent. */
  function isRecent(filePath: string): boolean {
    if (statCalls >= MAX_STATS) return false;
    statCalls++;
    try {
      return fsSync.statSync(filePath).mtimeMs > cutoff;
    } catch {
      return false;
    }
  }

  /** Recursively check directory entries (skips excluded dirs). */
  function checkDir(dirPath: string): boolean {
    if (statCalls >= MAX_STATS) return false;
    let dirEntries: fsSync.Dirent[];
    try {
      dirEntries = fsSync.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of dirEntries) {
      if (statCalls >= MAX_STATS) return false;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        if (isRecent(fullPath)) return true;
      } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        if (checkDir(fullPath)) return true;
      }
    }
    return false;
  }

  for (const entry of entries) {
    if (statCalls >= MAX_STATS) break;
    const name = entry.name;

    // Skip excluded: dotfiles, node_modules
    if (name.startsWith('.') || name === 'node_modules') continue;

    const fullPath = path.join(worktreePath, name);

    if (entry.isFile() && !MTIME_EXCLUDED_FILES.has(name)) {
      if (isRecent(fullPath)) return true;
    }

    // Recurse into src/
    if (entry.isDirectory() && name === 'src') {
      if (checkDir(fullPath)) return true;
    }
  }

  return false;
}

/**
 * RKB: query known resolutions for a session error message.
 * 返回可注入下一轮 prompt 的 resolutionHint；无匹配或查询失败返回 ''（调用方保留旧值）。
 */

/** RKB 知识条目（~/.studio/knowledge/resolution-* 文档的 meta 摘要） */
interface ResolutionEntry {
  id: string;
  pattern: string;
  title: string;
  fix: string;
  verifyCount: number;
  status: unknown;
}

export async function queryResolutionHints(errMsg: string): Promise<string> {
  try {
    const knowledgeDir = studioPath('knowledge');
    const allKeys = await fileStore.listDocs(knowledgeDir);
    const resKeys = allKeys.filter((k: string) => k.startsWith('resolution-'));
    const resolutions: ResolutionEntry[] = [];
    for (const key of resKeys) {
      const doc = await fileStore.readDoc(knowledgeDir, key);
      if (doc && (doc.meta.maturity === 'verified' || doc.meta.maturity === 'canonical')) {
        resolutions.push({
          id: key.replace('resolution-', ''),
          pattern: (doc.meta.pattern || '') as string,
          title: (doc.meta.title || '') as string,
          fix: (doc.body || '').replace(/^#.*\n/, '').replace(/^## Solution\n/, '').trim(),
          verifyCount: (doc.meta.verifyCount || 0) as number,
          status: doc.meta.maturity,
        });
      }
    }
    resolutions.sort((a, b) => (b.verifyCount || 0) - (a.verifyCount || 0));
    const matched: string[] = [];
    const lowerMsg = errMsg.toLowerCase();
    for (const r of resolutions) {
      try {
        if (new RegExp(r.pattern, 'i').test(errMsg)) {
          matched.push(`- **${r.title}**: ${r.fix}`);
        }
      } catch {
        if (lowerMsg.includes(r.pattern.toLowerCase())) {
          matched.push(`- **${r.title}**: ${r.fix}`);
        }
      }
    }
    if (matched.length > 0) {
      return '## \u5df2\u77e5\u89e3\u6cd5 (RKB)\n\u4ee5\u4e0b\u89e3\u6cd5\u66fe\u5728\u7c7b\u4f3c\u9519\u8bef\u4e0a\u9a8c\u8bc1\u6709\u6548\uff1a\n' + matched.join('\n');
    }
  } catch { /* non-blocking */ }
  return '';
}
