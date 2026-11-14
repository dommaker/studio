// AgentLoop 输出解析与 prompt 构建纯函数区（2026-08 工单 28 从 agent-loop.ts 原样抽出，
// 行为不变）：ACTION 协议解析、REVIEW_RESULT 解析、TASK: 拆分行解析、目标选择、
// 动态间隔、进程/git 探针、continue/reply prompt 模板。
// agent-loop.ts re-export 公开导出保持对外语义不变。
import { existsSync } from 'fs';
import { join } from 'path';
import { studioPath } from '@dommaker/studio-shared/studio-dir';
import { extractToolCalls, type StepCommandRecord, type StepRecordDetails, type StreamEvent } from '@dommaker/studio-shared';
import { ANALYSIS_TASKS_MAX, INSPECTION_OPPORTUNITIES_MAX, type WorkUnitData } from '../workunit/index.js';
import { MAP_OPENING_FOG_MAX } from '../pmo/index.js';
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

/** B3b-i: worktrees 根目录解析（与 AgentRunner config 口径一致：WORKTREES_DIR > studioPath('worktrees')，契约 §8 双口径收编） */
export function resolveWorktreesDir(): string {
  return process.env.WORKTREES_DIR || studioPath('worktrees');
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
  const stepRecord = parseStepRecord(text);
  for (let i = lines.length - 1; i >= 0; i--) {
    // A2A §4.1: ACTION: DELEGATE:@<profileName>:<scope>（scope = 该行剩余内容，必填）。
    // 解析失败（@名字缺失、scope 为空、格式不对）落到下方默认 progress，与现有容错一致。
    const delegateMatch = lines[i].match(/ACTION:\s*DELEGATE:@([\w-]+):(\s*\S.*)$/);
    if (delegateMatch) {
      const scope = delegateMatch[2].trim();
      return { action: 'delegate', summary: scope, delegate: { targetName: delegateMatch[1], scope }, ...(stepRecord ? { stepRecord } : {}) };
    }
    const match = lines[i].match(/ACTION:\s*(PROGRESS|COMPLETE|NEED_INPUT):(.*)/);
    if (match) {
      const actionMap: Record<string, StepResult['action']> = {
        PROGRESS: 'progress',
        COMPLETE: 'complete',
        NEED_INPUT: 'need_input',
      };
      const result: StepResult = {
        action: actionMap[match[1]], summary: match[2].trim(),
        ...(stepRecord ? { stepRecord } : {}),
      };
      // #279（决策 #250 D3）：NEED_INPUT 行紧接着的下一行可选携带
      //   OPTIONS: [{"label":"方案 A","description":"说明","value":"a"},...]
      // 防御：OPTIONS 缺失 / JSON 损坏 / 元素缺 label → 静默忽略（options 为 undefined），
      // 绝不影响 NEED_INPUT 本体解析；只对 NEED_INPUT 生效。
      if (result.action === 'need_input') {
        const options = parseNeedInputOptions(lines[i + 1]);
        if (options) result.options = options;
        // #467：裁决轮——NEED_INPUT 紧随的 RULING: 行（可与 OPTIONS 共存）
        const rulings = parseRulingLines(lines.slice(i + 1));
        if (rulings) result.rulings = rulings;
        // #567：方向锁定——NEED_INPUT 紧随的 DIRECTION: 行（可与 OPTIONS/RULING 共存）
        const directions = parseDirectionLine(lines.slice(i + 1));
        if (directions) result.directions = directions;
      }
      return result;
    }
  }
  return { action: 'progress', summary: text.trim(), ...(stepRecord ? { stepRecord } : {}) };
}

/** #711：可选 STEP_RECORD JSON 行；逐字段校验，损坏记录不影响 ACTION 本体。 */
export function parseStepRecord(text: string): StepRecordDetails | undefined {
  for (const line of text.split('\n').reverse()) {
    const match = line.match(/^\s*STEP_RECORD:\s*(\{.*\})\s*$/);
    if (!match) continue;
    try {
      const value: unknown = JSON.parse(match[1]);
      if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
      const raw = value as Record<string, unknown>;
      const details: StepRecordDetails = {};
      if (Array.isArray(raw.acProgress)) {
        details.acProgress = raw.acProgress.flatMap(item => {
          if (!item || typeof item !== 'object') return [];
          const entry = item as Record<string, unknown>;
          if (typeof entry.ac !== 'string' || !entry.ac.trim()) return [];
          if (!['pending', 'in_progress', 'completed'].includes(String(entry.status))) return [];
          return [{
            ac: entry.ac.trim().slice(0, 500),
            status: entry.status as 'pending' | 'in_progress' | 'completed',
            ...(typeof entry.note === 'string' && entry.note.trim() ? { note: entry.note.trim().slice(0, 500) } : {}),
          }];
        }).slice(0, 50);
      }
      if (Array.isArray(raw.commands)) {
        details.commands = raw.commands.flatMap(item => {
          if (!item || typeof item !== 'object') return [];
          const entry = item as Record<string, unknown>;
          if (typeof entry.command !== 'string' || !entry.command.trim()) return [];
          const status = ['passed', 'failed', 'unknown'].includes(String(entry.status)) ? entry.status as StepCommandRecord['status'] : 'unknown';
          return [{ command: entry.command.trim().slice(0, 1000), status }];
        }).slice(0, 100);
      }
      if (raw.verification === null) details.verification = null;
      else if (raw.verification && typeof raw.verification === 'object' && !Array.isArray(raw.verification)) {
        const verification = raw.verification as Record<string, unknown>;
        if ((verification.status === 'passed' || verification.status === 'failed') && typeof verification.at === 'string') {
          details.verification = {
            status: verification.status,
            commands: stringList(verification.commands),
            at: verification.at,
          };
        }
      }
      for (const key of ['modifiedFiles', 'decisions', 'artifacts', 'transcriptRefs'] as const) {
        if (Array.isArray(raw[key])) details[key] = stringList(raw[key]);
      }
      if (typeof raw.nextStep === 'string' && raw.nextStep.trim()) details.nextStep = raw.nextStep.trim().slice(0, 500);
      return details;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** 从实际工具调用补充命令与修改文件；未配对结果保持 unknown。 */
export function stepActivityFromEvents(events: StreamEvent[]): StepRecordDetails {
  const commands: StepCommandRecord[] = [];
  const modifiedFiles: string[] = [];
  for (const tool of extractToolCalls(events)) {
    if (!tool.input || typeof tool.input !== 'object' || Array.isArray(tool.input)) continue;
    const input = tool.input as Record<string, unknown>;
    if (tool.name === 'Bash' && typeof input.command === 'string' && input.command.trim()) {
      commands.push({
        command: input.command.trim().slice(0, 1000),
        status: tool.success === true ? 'passed' : tool.success === false ? 'failed' : 'unknown',
      });
    }
    if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(tool.name)) {
      const file = typeof input.file_path === 'string' ? input.file_path : input.path;
      if (typeof file === 'string' && file.trim()) modifiedFiles.push(file.trim().slice(0, 1000));
    }
  }
  return { commands, modifiedFiles: [...new Set(modifiedFiles)] };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    .map(item => item.trim().slice(0, 1000)))].slice(0, 50);
}

/** #279：解析 NEED_INPUT 下一行的 OPTIONS: JSON 数组；非法输入一律返回 undefined */
function parseNeedInputOptions(line: string | undefined): StepResult['options'] {

  const match = line?.match(/^OPTIONS:\s*(.+)$/);
  if (!match) return undefined;
  try {
    const parsed = JSON.parse(match[1]) as unknown;
    if (!Array.isArray(parsed)) return undefined;
    const options = parsed
      .filter((o): o is Record<string, unknown> => o !== null && typeof o === 'object')
      .filter(o => typeof o.label === 'string')
      .map(o => ({
        label: o.label as string,
        ...(typeof o.description === 'string' ? { description: o.description } : {}),
        ...(typeof o.value === 'string' ? { value: o.value } : {}),
      }));
    return options.length > 0 ? options : undefined;
  } catch {
    return undefined;
  }
}

/**
 * #467：解析 NEED_INPUT 后续的 RULING: JSON 行（plan 裁决轮契约，见 prompt-composer
 * CONTRACT_TEMPLATES.plan）。每行一条 `RULING: {"question":"...","suggestion":"...","default":"..."（可省）}`；
 * 裁决行须连续紧随 NEED_INPUT（OPTIONS 行可夹杂，首个其他行即出区）；JSON 损坏行跳过、
 * question/suggestion 缺或非串的条目丢弃；封顶 MAP_OPENING_FOG_MAX 条、字段截 300 字符；
 * 无合法行返回 undefined（调用方据此不落 planRulings，NEED_INPUT 本体解析不受影响）。
 */
function parseRulingLines(lines: string[]): StepResult['rulings'] {
  const rulings: NonNullable<StepResult['rulings']> = [];
  for (const line of lines) {
    if (/^OPTIONS:/.test(line)) continue; // #279 选项行与裁决行可共存
    if (/^DIRECTION:/.test(line)) continue; // #567 方向锁定行与裁决行可共存
    if (!/^RULING:/.test(line)) break; // 裁决行连续紧随 NEED_INPUT；首个其他行即出区
    const match = line.match(/^RULING:\s*(\{.*\})\s*$/);
    if (!match) continue; // 形坏（非 JSON 对象形）跳过，不阻断后续裁决行
    try {
      const parsed = JSON.parse(match[1]) as { question?: unknown; suggestion?: unknown; default?: unknown };
      if (typeof parsed.question !== 'string' || !parsed.question.trim()) continue;
      if (typeof parsed.suggestion !== 'string' || !parsed.suggestion.trim()) continue;
      rulings.push({
        question: parsed.question.trim().slice(0, ANALYSIS_TASK_MAX_CHARS),
        suggestion: parsed.suggestion.trim().slice(0, ANALYSIS_TASK_MAX_CHARS),
        ...(typeof parsed.default === 'string' && parsed.default.trim()
          ? { default: parsed.default.trim().slice(0, ANALYSIS_TASK_MAX_CHARS) }
          : {}),
      });
      if (rulings.length >= MAP_OPENING_FOG_MAX) break;
    } catch { /* JSON 损坏行跳过 */ }
  }
  return rulings.length > 0 ? rulings : undefined;
}

/** #567：DIRECTION 载荷字段截断上限（与 pmo/plan-ruling.ts RULING_FIELD_MAX_CHARS 同口径） */
const DIRECTION_FIELD_MAX_CHARS = 500;
/** #567：方向候选条数区间（契约写 2~3 个，解析容忍至多 4） */
const DIRECTION_OPTIONS_MIN = 2;
const DIRECTION_OPTIONS_MAX = 4;

/**
 * #567：解析 NEED_INPUT 后续的 DIRECTION: JSON 行（plan 方向锁定契约，见 prompt-composer
 * PLAN_DIRECTION_SECTION）。每行一条 `DIRECTION: {"question":"...","options":[{name,summary,
 * tradeoffs,impact,recommended}]}`；方向行紧随 NEED_INPUT（OPTIONS/RULING 行可夹杂跳过，
 * 首个其他行即出区），第一条合法 DIRECTION 行生效。防御口径同 RULING：JSON 损坏静默跳过、
 * question/options 各必填字段缺或非串整条拒收、options 必须 2..4 条否则整条拒收、
 * 字段截 DIRECTION_FIELD_MAX_CHARS 字符；recommended 非恰好一个 → 归一（全部置 false
 * 后首条置 true）。无合法行返回 undefined（调用方据此不落 planDirections，NEED_INPUT
 * 本体解析不受影响）。
 */
function parseDirectionLine(lines: string[]): StepResult['directions'] {
  for (const line of lines) {
    if (/^OPTIONS:/.test(line) || /^RULING:/.test(line)) continue; // 选项行/裁决行与方向行可共存
    if (!/^DIRECTION:/.test(line)) break; // 方向行紧随 NEED_INPUT；首个其他行即出区
    const match = line.match(/^DIRECTION:\s*(\{.*\})\s*$/);
    if (!match) continue; // 形坏（非 JSON 对象形）跳过，不阻断后续行
    try {
      const parsed = JSON.parse(match[1]) as {
        question?: unknown;
        options?: unknown;
      };
      if (typeof parsed.question !== 'string' || !parsed.question.trim()) continue;
      if (!Array.isArray(parsed.options)) continue;
      if (parsed.options.length < DIRECTION_OPTIONS_MIN || parsed.options.length > DIRECTION_OPTIONS_MAX) continue;
      const options: NonNullable<StepResult['directions']>['options'] = [];
      let valid = true;
      for (const entry of parsed.options) {
        if (entry === null || typeof entry !== 'object') { valid = false; break; }
        const o = entry as Record<string, unknown>;
        const name = typeof o.name === 'string' ? o.name.trim() : '';
        const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
        const tradeoffs = typeof o.tradeoffs === 'string' ? o.tradeoffs.trim() : '';
        const impact = typeof o.impact === 'string' ? o.impact.trim() : '';
        if (!name || !summary || !tradeoffs || !impact) { valid = false; break; }
        options.push({
          name: name.slice(0, DIRECTION_FIELD_MAX_CHARS),
          summary: summary.slice(0, DIRECTION_FIELD_MAX_CHARS),
          tradeoffs: tradeoffs.slice(0, DIRECTION_FIELD_MAX_CHARS),
          impact: impact.slice(0, DIRECTION_FIELD_MAX_CHARS),
          recommended: o.recommended === true,
        });
      }
      if (!valid) continue;
      // recommended 恰好一个（契约硬约束）；非恰好一个 → 归一：全部置 false 后首条置 true
      if (options.filter(o => o.recommended).length !== 1) {
        for (const o of options) o.recommended = false;
        options[0].recommended = true;
      }
      return {
        question: parsed.question.trim().slice(0, DIRECTION_FIELD_MAX_CHARS),
        options,
      };
    } catch { /* JSON 损坏行跳过 */ }
  }
  return undefined;
}

/** Dynamic sleep interval based on result.
 *  2026-09 性能治理：步间 sleep 已可中断（#523 wakeIdle），唤醒只放行不裁决——
 *  progress/delegate/complete 的空睡纯属白等，收紧到近零地板（500ms 防 spin）；
 *  need_input（等人）与 failed（W-3 失败重试降速）保持原节奏。 */
export function dynamicInterval(result: { action: string }): number {
  switch (result.action) {
    case 'progress':   return 500;
    case 'delegate':   return 500; // A2A: 委派后父按 progress 继续
    case 'complete':   return 3_000;
    case 'need_input': return 30_000;
    case 'failed':     return 15_000; // W-3: 失败重试降速
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

/** #463：decisionSuggestion 截断上限（结论一句话，防模型刷长文） */
const DECISION_SUGGESTION_MAX_CHARS = 500;

/**
 * #463：解析 decision WU 输出末段的 `## 结论摘要`（契约见 prompt-composer
 * CONTRACT_TEMPLATES.decision）——段落正文（标题下一行起、到下一个 `##` 标题或
 * ACTION: 协议行为止）作为 agent 建议结论落 metadata.decisionSuggestion，供人工
 * 确认弹窗预填。无该段/段内空白 → null（不落档，确认弹窗空手填）。
 */
export function parseDecisionConclusion(text: string): string | null {
  const lines = text.split('\n');
  const start = lines.findIndex(l => /^##\s*结论摘要\s*$/.test(l.trim()));
  if (start === -1) return null;
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line.trim()) || /^ACTION:/.test(line.trim())) break;
    body.push(line);
  }
  const conclusion = body.join('\n').trim();
  if (!conclusion) return null;
  return conclusion.slice(0, DECISION_SUGGESTION_MAX_CHARS);
}

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

/**
 * #163（T8-E2，#130 决策 2）：解析巡检 WU 输出中的 OPPORTUNITY: 协议行
 * （约定见 prompt-composer 巡检契约段）。每行一条
 * `OPPORTUNITY: {"problem":"...","suggestion":"...","estimate":"..."（可省）}`；
 * problem/suggestion 缺或非串的条目丢弃，去重（problem+suggestion）/封顶
 * INSPECTION_OPPORTUNITIES_MAX 条/单字段截 300 字符；无合法行返回 []
 * （调用方据此不写 opportunities，不阻断 COMPLETE）。
 */
export interface ParsedOpportunity {
  problem: string;
  suggestion: string;
  estimate?: string;
}

export function parseOpportunities(text: string): ParsedOpportunity[] {
  const opps: ParsedOpportunity[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*OPPORTUNITY:\s*(\{.*\})\s*$/);
    if (!match) continue;
    try {
      const parsed = JSON.parse(match[1]) as { problem?: unknown; suggestion?: unknown; estimate?: unknown };
      if (typeof parsed.problem !== 'string' || !parsed.problem.trim()) continue;
      if (typeof parsed.suggestion !== 'string' || !parsed.suggestion.trim()) continue;
      const opp: ParsedOpportunity = {
        problem: parsed.problem.trim().slice(0, ANALYSIS_TASK_MAX_CHARS),
        suggestion: parsed.suggestion.trim().slice(0, ANALYSIS_TASK_MAX_CHARS),
      };
      if (typeof parsed.estimate === 'string' && parsed.estimate.trim()) {
        opp.estimate = parsed.estimate.trim().slice(0, ANALYSIS_TASK_MAX_CHARS);
      }
      const key = `${opp.problem}${opp.suggestion}`;
      if (seen.has(key)) continue;
      seen.add(key);
      opps.push(opp);
      if (opps.length >= INSPECTION_OPPORTUNITIES_MAX) break;
    } catch { /* JSON 损坏行跳过 */ }
  }
  return opps;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Prompt builders ───

const STEP_RECORD_PROMPT = `  ACTION 前输出一行 STEP_RECORD JSON（无内容的字段用空数组/null）：
  STEP_RECORD: {"acProgress":[{"ac":"<验收标准>","status":"pending|in_progress|completed","note":"可省"}],"modifiedFiles":[],"decisions":[],"artifacts":[],"nextStep":null}
  修改文件和命令由系统从工具事件补记；decisions 只写已经确认的决策，不写候选想法。`;

export function buildContinuePrompt(wu: WorkUnitData): string {
  return `## 当前工作

${wu.scope}

## 要求

继续上次工作。仓库根有 AGENTS.md/CLAUDE.md 时以它们为准。每步结束后输出：
${STEP_RECORD_PROMPT}
  ACTION: PROGRESS:<summary>      完成一步，继续中
  ACTION: COMPLETE:<summary>      全部完成
  ACTION: NEED_INPUT:<需要什么>   需要人类输入（有选项时下一行加 OPTIONS: [{"label":"方案 A","value":"a"},...]，value 可省）

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
${STEP_RECORD_PROMPT}
  ACTION: PROGRESS:<summary>      完成一步，继续中
  ACTION: COMPLETE:<summary>      全部完成
  ACTION: NEED_INPUT:<需要什么>   需要人类输入（有选项时下一行加 OPTIONS: [{"label":"方案 A","value":"a"},...]，value 可省）`;
}
