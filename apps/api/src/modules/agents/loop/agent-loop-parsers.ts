// AgentLoop 输出解析与 prompt 构建纯函数区（2026-08 工单 28 从 agent-loop.ts 原样抽出，
// 行为不变）：ACTION 协议解析、REVIEW_RESULT 解析、TASK: 拆分行解析、目标选择、
// 动态间隔、进程/git 探针、continue/reply prompt 模板。
// agent-loop.ts re-export 公开导出保持对外语义不变。
import { existsSync } from 'fs';
import { join } from 'path';
import * as os from 'os';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { ANALYSIS_TASKS_MAX, type WorkUnitData } from '../../workunit/workunit.service.js';
import type { ParsedReviewReport } from './review-contract.js';
import type { StepResult, Observations, Target } from './agent-loop.types.js';

/** Check if a process is alive by sending signal 0 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** B3b-i: 判断路径是否 git 仓库根（.git 存在即可，与 createWorktree 校验口径一致） */
export function isGitRepoRoot(root: string): boolean {
  try {
    return existsSync(join(root, '.git'));
  } catch {
    return false;
  }
}

/** B3b-i: worktrees 根目录解析（与 AgentRunner config 口径一致：WORKTREES_DIR > ~/worktrees） */
export function resolveWorktreesDir(): string {
  return process.env.WORKTREES_DIR || join(os.homedir(), 'worktrees');
}

/** Resolve target from observations (pure code, zero LLM) */
export function resolveTarget(obs: Observations): Target | null {
  // Priority 1: human reply (including blocked WorkUnit)
  if (obs.newReplies.length > 0) {
    const repliedWuId = obs.newReplies[0].workUnitId;
    const wu = obs.myActive.find(w => w.id === repliedWuId);
    if (wu) return { workUnit: wu, newReplies: obs.newReplies };
  }

  // Priority 2: active WorkUnit continues
  const activeWu = obs.myActive.find(w => w.status === 'active');
  if (activeWu) return { workUnit: activeWu };

  // Priority 3: idle, take earliest unassigned
  if (obs.unassigned.length > 0) {
    return { workUnit: obs.unassigned[0] };
  }

  // No target
  return null;
}

/** Parse agent output for ACTION protocol */
export function parseAgentOutput(text: string): StepResult {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    // A2A §4.1: ACTION: DELEGATE:@<profileName>:<scope>（scope = 该行剩余内容，必填）。
    // 解析失败（@名字缺失、scope 为空、格式不对）落到下方默认 progress，与现有容错一致。
    const delegateMatch = lines[i].match(/ACTION:\s*DELEGATE:@([\w-]+):(\s*\S.*)$/);
    if (delegateMatch) {
      const scope = delegateMatch[2].trim();
      return { action: 'delegate', summary: scope, delegate: { targetName: delegateMatch[1], scope } };
    }
    const match = lines[i].match(/ACTION:\s*(PROGRESS|COMPLETE|NEED_INPUT):(.*)/);
    if (match) {
      const actionMap: Record<string, StepResult['action']> = {
        PROGRESS: 'progress',
        COMPLETE: 'complete',
        NEED_INPUT: 'need_input',
      };
      return { action: actionMap[match[1]], summary: match[2].trim() };
    }
  }
  return { action: 'progress', summary: text.trim() };
}

/** Dynamic sleep interval based on result */
export function dynamicInterval(result: { action: string }): number {
  switch (result.action) {
    case 'progress':   return 3_000;
    case 'delegate':   return 3_000; // A2A: 委派后父按 progress 继续
    case 'complete':   return 10_000;
    case 'need_input': return 30_000;
    case 'failed':     return 15_000; // W-3: 失败重试降速（原误判 progress 时每 3s 重试）
    default:           return 15_000;
  }
}

/**
 * P0 修复（reviewReport 回传断链）：解析 reviewer 最终输出为结构化审查结论。
 * 约定格式（已写入 review 子 WU scope）：输出以
 *   REVIEW_RESULT: {"verdict":"pass"|"reject","summary":"...","issues":[...]}
 * 结尾的行。宽松策略：优先解析 REVIEW_RESULT 行 JSON；失败则从输出尾部提取
 * verdict 关键词；仍失败 → null（不写 reviewReport，由 ReviewDispatcher 转人工）。
 * verdict 词表归 review-contract.ts 所有（needs-info 无 legacy 等价 → 解析层不落档）；
 * 返回形状 ParsedReviewReport 同由契约模块定义。
 */
export function parseReviewReport(text: string): ParsedReviewReport | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const match = lines[i].match(/REVIEW_RESULT:\s*(\{.*\})\s*$/);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]) as { verdict?: unknown; summary?: unknown; issues?: unknown };
      if (parsed.verdict === 'pass' || parsed.verdict === 'reject') {
        return {
          approved: parsed.verdict === 'pass',
          reason: typeof parsed.summary === 'string' ? parsed.summary : undefined,
          issues: normalizeReviewIssues(parsed.issues),
        };
      }
    } catch { /* JSON 损坏 → 落到关键词兜底 */ }
    break; // 已找到（最末一条）REVIEW_RESULT 行，不再向上扫描更早的行
  }

  // 兜底：输出尾部 verdict 关键词（ reviewer 未按约定格式但给出了结论词）
  const tail = lines.slice(-10).join('\n');
  if (/verdict["'\s:]+reject/i.test(tail)) {
    return { approved: false, reason: '（关键词兜底判定）' };
  }
  if (/verdict["'\s:]+pass/i.test(tail)) {
    return { approved: true, reason: '（关键词兜底判定）' };
  }
  return null;
}

/** REVIEW_RESULT issues 字段归一化：只保留 { severity, message } 形状，非法项丢弃 */
function normalizeReviewIssues(raw: unknown): Array<{ severity: string; message: string }> | undefined {
  if (!Array.isArray(raw)) return undefined;
  const issues = raw
    .filter((i): i is Record<string, unknown> => i !== null && typeof i === 'object')
    .map(i => ({
      severity: typeof i.severity === 'string' ? i.severity : 'info',
      message: typeof i.message === 'string' ? i.message : JSON.stringify(i),
    }))
    .filter(i => i.message.length > 0);
  return issues.length > 0 ? issues : undefined;
}

/** analysis 任务拆分上限（防模型刷行刷屏；常量定义在 workunit.service，此处复用） */
const ANALYSIS_TASK_MAX_CHARS = 300;

/**
 * PMO 分析接力：解析 analysis WU 输出中的 TASK: 拆分行（约定见 publish 的 scope 契约）。
 * 每行一条 `TASK: <任务描述>`；去空白/去重/封顶 8 条/单条截 300 字符；
 * 无 TASK 行返回 []（调用方据此不写 analysisTasks，不阻断 COMPLETE）。
 */
export function parseTaskBreakdown(text: string): string[] {
  const tasks: string[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*TASK:\s*(\S.*)$/);
    if (!match) continue;
    const task = match[1].trim().slice(0, ANALYSIS_TASK_MAX_CHARS);
    if (!task || seen.has(task)) continue;
    seen.add(task);
    tasks.push(task);
    if (tasks.length >= ANALYSIS_TASKS_MAX) break;
  }
  return tasks;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Prompt builders ───

export function buildContinuePrompt(wu: WorkUnitData): string {
  return `## 当前工作

${wu.scope}

## 要求

继续上次工作。仓库根有 AGENTS.md/CLAUDE.md 时以它们为准。每步结束后输出：
  ACTION: PROGRESS:<summary>      完成一步，继续中
  ACTION: COMPLETE:<summary>      全部完成
  ACTION: NEED_INPUT:<需要什么>   需要人类输入

当做出设计决策（选型、架构选择、方案取舍）时，用 Write 工具追加到 ${studioPath('knowledge')}/decision-YYYY-MM-DD.md 记录：话题、候选方案、选择、理由。`;
}

export function buildReplyPrompt(wu: WorkUnitData, replies: string[]): string {
  const replyText = replies.join('\n');
  return `## 当前工作

${wu.scope}

## 人类新回复

${replyText}

## 要求

根据回复调整方案，继续工作。仓库根有 AGENTS.md/CLAUDE.md 时以它们为准。每步结束后输出：
  ACTION: PROGRESS:<summary>      完成一步，继续中
  ACTION: COMPLETE:<summary>      全部完成
  ACTION: NEED_INPUT:<需要什么>   需要人类输入`;
}
