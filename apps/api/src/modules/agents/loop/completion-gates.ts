/**
 * 收口守卫链（2026-08 从 agent-loop.recordResult 抽出，行为一字不改）：
 * recordResult 的 COMPLETE 收口判定 —— §10.5 提交守卫 → §6-2 子任务守卫 → 产出实双闸
 * （闸 1 代码类 diff 非空 / 闸 2 非代码类契约产物）→ B3b-i 自动验证守卫
 * → T7-E2 软观测段（#161，只观测不拦截：checker:soft_check 台账 + processCheckHint）。
 * 顺序即优先级：前面的守卫把 action 降级为 progress 后，后面的 COMPLETE 守卫自然不再触发。
 *
 * 职责边界：
 *   - 本模块 = 守卫政策（guard policy）：判定/降级/hint 写入/l1 台账写法/no-commit 计数。
 *   - agent-loop.recordResult = 编排：构建合并视图（持久化 + 本 step metadataUpdates）→
 *     调 runCompletionGuards → delegate/新鲜度/强制收口补跑 → 单次原子写 → 状态迁移与频道通知。
 *   - agent-loop.agentStep = hint 消费（读 metadata 注入 prompt 后清除），属 prompt 组装，不在本模块。
 *
 * 可测试性：git/验证/子任务查询全部经 deps 注入，单测用纯 ctx 对象驱动，无需 vi.mock 模块工厂。
 * 默认实现（hasUncommittedChanges/readHeadHash/runWuVerification）与原 AgentLoop 私有方法逐字一致。
 */

import { execFileSync, execSync } from 'child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { logger, withAttestation } from '@dommaker/studio-shared';
import {
  verifyTddChain,
  verifyPhaseFormat,
  verifyContractPresence,
  type CommitInput,
  type CompletionCheckersConfig,
  type ContractPresenceResult,
  type PhaseFormatResult,
  type TddChainResult,
} from '@dommaker/harness';
import { CODE_WORKTREE_TYPES, runWuVerification, type WuVerifyOutcome } from './wu-verification.js';
import type { WorkUnitData, WorkUnitMetadata } from '../../workunit/workunit.service.js';
import type { StepResult } from './agent-loop.js';
import { writeStudioEvent } from '../../../utils/studio-events.js';

/** §10.5 提交守卫：worktree 是否有未提交改动。
 *  git 调用失败返回 false —— 守卫静默跳过，绝不因基础设施故障阻断完成。 */
export function hasUncommittedChanges(cwd: string): boolean {
  try {
    const out = execSync('git status --porcelain', { cwd, timeout: 5000, encoding: 'utf-8' });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

/** §10.5: 读取 worktree 当前 HEAD hash（失败返回 null —— 无提交监视静默跳过） */
export function readHeadHash(cwd: string): string | null {
  try {
    return execSync('git rev-parse HEAD', { cwd, timeout: 5000, encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

/** 收口闸 1（产出实）: git rev-list --count <base>..HEAD —— 提交守卫已保证无未提交改动，
 *  这里判「有没有提交内容」。git 失败返回 null —— 静默跳过（基础设施故障不阻断完成）。 */
export function countBranchCommits(cwd: string, baseBranch: string): number | null {
  try {
    const out = execFileSync('git', ['rev-list', '--count', `${baseBranch}..HEAD`], {
      cwd, timeout: 5000, encoding: 'utf-8',
    }).trim();
    const n = Number.parseInt(out, 10);
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/** 收口闸 2（analysis）：契约报告落盘检查 —— <root>/.studio/research/ 下存在非空文件
 * （inspection 巡检变体只认 inspection-*.md）。目录不存在/读取失败 = 无产物（false）。 */
export function hasAnalysisReport(workspaceRoot: string, inspection: boolean): boolean {
  try {
    const dir = join(workspaceRoot, '.studio', 'research');
    for (const name of readdirSync(dir)) {
      if (inspection && !/^inspection-.+\.md$/.test(name)) continue;
      const st = statSync(join(dir, name));
      if (st.isFile() && st.size > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 闸 2 锚点分派（按 wu.type）：返回缺失产物的人话描述；null = 产物在或本类型不进闸。
 *  decision 的 `## 结论摘要` 解析落档已由 #463 提供（agent-loop → metadata.decisionSuggestion），
 *  本闸只验非空，不重复解析。 */
function missingContractArtifact(
  wu: WorkUnitData,
  metadata: WorkUnitMetadata,
  reportExists: (workspaceRoot: string, inspection: boolean) => boolean,
): string | null {
  switch (wu.type) {
    case 'review':
      return metadata.reviewReport ? null : '评审结论（REVIEW_RESULT 协议输出）';
    case 'plan':
      return Array.isArray(metadata.analysisTasks) && metadata.analysisTasks.length > 0
        ? null : '任务拆分清单（TASK: 协议行）';
    case 'spec':
      return Array.isArray(metadata.specTasks) && metadata.specTasks.length > 0
        ? null : '物化任务清单（TASK: 协议行）';
    case 'decision':
      return typeof metadata.decisionSuggestion === 'string' && metadata.decisionSuggestion.trim().length > 0
        ? null : '结论摘要（## 结论摘要 段）';
    case 'analysis': {
      if (metadata.prototype === true) return null; // 原型单契约是 prototype/<name> 分支代码，豁免本闸
      const root = typeof metadata.workspaceRoot === 'string' && metadata.workspaceRoot.length > 0
        ? metadata.workspaceRoot : null;
      if (!root) return null; // 无落盘根无法校验 → 静默跳过
      const inspection = metadata.inspection === true;
      return reportExists(root, inspection)
        ? null
        : inspection ? '巡检报告（.studio/research/inspection-<日期>.md）' : '调研报告（.studio/research/）';
    }
    default:
      return null; // 代码类由闸 1 覆盖，其余类型无契约产物锚点
  }
}

/** 守卫链输入。metadata 必须是「持久化 + 本 step metadataUpdates」的合并视图（调用方构建）：
 *  首个 step 的 worktreePath 等字段由 agentStep 经 result.metadataUpdates 传入、此刻尚未落库；
 *  只看持久化值会让首 step 的 COMPLETE 退到主仓库（干净）做检查而漏拦。 */
export interface CompletionGuardCtx {
  wu: WorkUnitData;
  wuId: string;
  metadata: WorkUnitMetadata;
  action: StepResult['action'];
  /** attestation.by 落档用（profile id） */
  roleId: string;
}

/** 守卫链外部依赖。git/验证默认实现即原 AgentLoop 私有方法/wu-verification，单测整体注入伪实现。 */
export interface CompletionGuardDeps {
  /** B3b-i: 提交守卫的 git cwd 解析（代码类 → 专属 worktree；否则回退 B3a/F6 共享根） */
  resolveExecutionCwd: (wu: WorkUnitData, metadata: WorkUnitMetadata) => Promise<string | null>;
  /** §6-2: 未完结（unassigned/active/blocked/in_review）子 WU 的 id 列表 */
  listUnfinishedChildren: (wuId: string) => Promise<string[]>;
  hasUncommittedChanges?: (cwd: string) => boolean;
  readHeadHash?: (cwd: string) => string | null;
  /** 收口闸 1: git rev-list --count <base>..HEAD（默认 execFileSync；失败返回 null = 静默跳过） */
  countBranchCommits?: (cwd: string, baseBranch: string) => number | null;
  /** 收口闸 2: analysis 契约报告落盘检查（默认 fs 实现；inspection 变体只认 inspection-*.md） */
  analysisReportExists?: (workspaceRoot: string, inspection: boolean) => boolean;
  runVerification?: (wu: WorkUnitData, metadata: WorkUnitMetadata, worktreePath: string) => Promise<WuVerifyOutcome>;
  /** T7-E2（#161）: harness 三纯函数（默认 = @dommaker/harness 静态导入，#425 去镜像；
   *  返回 null = 软观测段整体 fail-open 跳过） */
  loadCompletionCheckers?: () => Promise<CompletionCheckerFns | null>;
  /** T7-E2: 一次 git log 拉 WU 提交集（默认 execFileSync，2s 超时；失败返回 null = fail-open） */
  readWuCommits?: (worktreePath: string, baseBranch: string) => CommitInput[] | null;
  /** T7-E2: completion_checkers 配置（默认现读现解 <repoRoot>/.harness/custom-constraints.yml，不做缓存；
   *  文件/段缺失或解析失败 = {} —— 三 checker 全开 + 默认 glob） */
  loadCompletionCheckersConfig?: (repoRoot: string) => CompletionCheckersConfig;
  /** T7-E2: 台账事件写入（默认 writeStudioEvent('checker:soft_check')，fire-and-forget） */
  writeSoftCheckEvent?: (event: SoftCheckEvent) => void;
}

/** 守卫链产生的后续动作信号（recordResult 据此发频道通知/跑强制收口补验/转 blocked） */
export interface CompletionGuardNotices {
  /** §10.5: 连续 3 步无新提交 → 频道提醒一次（计数已归零） */
  noCommit: boolean;
  /** B3b-i: 验证全绿频道简报文案（仅当 action 最终仍为 complete 才发，recordResult 判定） */
  verifyPassed: string | null;
  /** B3b-i: verifyFailCount ≥3 → blocked 并频道说明 */
  verifyBlocked: boolean;
  /** 收口闸 1: diffEmptyCount ≥3 → blocked 并频道说明 */
  diffEmptyBlocked: boolean;
  /** 收口闸 2: contractArtifactCount ≥3 → blocked 并频道说明 */
  contractArtifactBlocked: boolean;
  /** F6-c：本 step COMPLETE 守卫是否已跑过验证 —— 步骤超限强制收口路径据此避免重复跑 */
  verifyGuardRan: boolean;
}

export interface CompletionGuardOutcome {
  action: StepResult['action'];
  /** 守卫写入的 metadata 增量（hint/计数/台账/verifyReport），由 recordResult 合进原子写 */
  guardUpdates: Partial<WorkUnitMetadata>;
  notices: CompletionGuardNotices;
}

// ─── T7-E2（#161）软观测段：消费 harness completion-checkers 三纯函数（#160） ───
//
// 定位：第四段「软观测」——只观测不拦截。action 未被前三张守卫降级（仍为 complete）才跑；
// pass/violation/waiver 落 checker:soft_check 台账事件（skip 不记），违规合并成
// processCheckHint 走 prompt-composer 一次性消费回路（COMPLETE 放行时 hint 沉睡，
// 返工时才被消费——可接受，不做跨 WU 投递）。一切故障（git/超时/解析）
// 一律 fail-open 静默跳过 + logger 留痕，绝不阻断 COMPLETE。
//
// 类型与三纯函数直接取自 @dommaker/harness ^1.2.3 公开导出（#425 去镜像——
// 0.19.0 时代的镜像类型 + loadHarness 特征检测随发版失去存续理由，已删）。

/** git log 拉取超时 2s：「单 checker 2s」上限落在段内唯一 I/O 上（三纯函数为同步纯计算） */
export const SOFT_CHECK_GIT_TIMEOUT_MS = 2_000;
/** 三张 checker 合计 5s 预算：每张跑前检查余量，耗尽即停（fail-open） */
export const SOFT_CHECK_TOTAL_BUDGET_MS = 5_000;

/** harness 三纯函数聚合（类型与实现直接取自 @dommaker/harness ^1.2.3 公开导出，#425 去镜像）；
 *  保留聚合接口仅为 deps 注入 seam（单测伪实现驱动软观测段） */
export interface CompletionCheckerFns {
  verifyTddChain: typeof verifyTddChain;
  verifyPhaseFormat: typeof verifyPhaseFormat;
  verifyContractPresence: typeof verifyContractPresence;
}

/** checker:soft_check 台账事件 payload（聚合归 #132，本段只产出） */
export interface SoftCheckEvent {
  wuId: string;
  checker: string;
  verdict: 'pass' | 'violation' | 'waiver';
  detail: string;
}

/** 默认：直接返回 harness 静态导入的三纯函数（^1.2.3 公开导出，#425 去镜像后无特征检测） */
async function defaultLoadCompletionCheckers(): Promise<CompletionCheckerFns | null> {
  return { verifyTddChain, verifyPhaseFormat, verifyContractPresence };
}

/**
 * 解析 `git log --format='%x1e%H%x1f%s%x1f%P%x1f%(trailers)' --name-only` 输出。
 * 记录以 \x1e 分隔；首行 = sha/subject/parents/首条 trailer（\x1f 分隔）；
 * trailer 段内部无空行，首个空行之后为 --name-only 文件清单。
 * 用 %(trailers) 而非 %b：协议（Tested-By/Tests: none）本就是 trailer，
 * 全量 body 的空行边界对行式解析有歧义（对票面 '%H||%s||%b' 格式的稳健化偏离）。
 */
export function parseWuGitLog(output: string): CommitInput[] {
  const commits: CommitInput[] = [];
  for (const record of output.split('\x1e')) {
    if (!record.trim()) continue;
    const lines = record.split('\n');
    const fields = lines[0].split('\x1f');
    const sha = (fields[0] ?? '').trim();
    if (!sha) continue;
    const parents = (fields[2] ?? '').trim().split(/\s+/).filter(Boolean);
    const trailerLines: string[] = [];
    if (fields[3]) trailerLines.push(fields[3]);
    let i = 1;
    while (i < lines.length && lines[i] !== '') {
      trailerLines.push(lines[i]);
      i++;
    }
    const files = lines.slice(i).filter(l => l.trim().length > 0);
    commits.push({
      sha,
      subject: fields[1] ?? '',
      body: trailerLines.join('\n'),
      files,
      isMerge: parents.length > 1,
    });
  }
  return commits.reverse(); // git log 为降序（新→旧），harness 输入约定 base..HEAD 升序
}

/** 默认：一次 git log 拉 base..HEAD 有序提交集（2s 超时；任何失败 → null = fail-open） */
function defaultReadWuCommits(worktreePath: string, baseBranch: string): CommitInput[] | null {
  try {
    const out = execFileSync('git', [
      'log', `${baseBranch}..HEAD`,
      "--format=%x1e%H%x1f%s%x1f%P%x1f%(trailers)",
      '--name-only',
    ], {
      cwd: worktreePath,
      timeout: SOFT_CHECK_GIT_TIMEOUT_MS,
      encoding: 'utf-8',
      maxBuffer: 8 * 1024 * 1024,
    });
    return parseWuGitLog(out);
  } catch {
    return null;
  }
}

/** 默认：现读现解 <repoRoot>/.harness/custom-constraints.yml 的 `completion_checkers:` 顶层键
 *  （不做缓存；文件名不跟 config.yml 覆盖约定——票面写死 custom-constraints.yml）。
 *  文件/段缺失或解析失败 → {}（三 checker 全开 + harness 默认 glob）。 */
export function loadCompletionCheckersConfig(repoRoot: string): CompletionCheckersConfig {
  try {
    const file = join(repoRoot, '.harness', 'custom-constraints.yml');
    if (!existsSync(file)) return {};
    const raw = (yaml.load(readFileSync(file, 'utf-8')) as Record<string, unknown> | null) ?? {};
    const section = raw['completion_checkers'];
    if (!section || typeof section !== 'object' || Array.isArray(section)) return {};
    return section as CompletionCheckersConfig;
  } catch {
    return {};
  }
}

/** 默认：台账事件落 studio-events.jsonl（writeStudioEvent 永不抛出，.catch 双保险） */
function defaultWriteSoftCheckEvent(event: SoftCheckEvent): void {
  void writeStudioEvent('checker:soft_check', event, { source: 'completion-gates' }).catch(() => {});
}

/** commit 级结论聚合成事件口径：violation 优先，否则有 waiver 记 waiver，否则 pass */
function emitCommitCheckerEvent(
  emit: (event: SoftCheckEvent) => void,
  wuId: string,
  result: TddChainResult | PhaseFormatResult,
): string | null {
  const violations = result.commits.filter(c => c.verdict === 'violation');
  const waivers = result.commits.filter(c => c.verdict === 'waiver');
  if (result.verdict === 'violation') {
    const detail = violations.map(v => `${v.sha.slice(0, 7)}: ${v.reason ?? '违规'}`).join('；').slice(0, 500);
    emit({ wuId, checker: result.checker, verdict: 'violation', detail });
    return `[${result.checker}] ${detail}`;
  }
  if (waivers.length > 0) {
    emit({
      wuId, checker: result.checker, verdict: 'waiver',
      detail: waivers.map(w => `${w.sha.slice(0, 7)}: ${w.reason ?? '豁免'}`).join('；').slice(0, 500),
    });
  } else {
    emit({ wuId, checker: result.checker, verdict: 'pass', detail: `${result.commits.length} commit(s) checked` });
  }
  return null;
}

/** T7-E2 软观测段本体：返回待写入的 processCheckHint（无违规 → null）。永不抛出。 */
async function runSoftObservation(
  wu: WorkUnitData,
  wuId: string,
  metadata: WorkUnitMetadata,
  deps: CompletionGuardDeps,
): Promise<{ hint: string | null }> {
  const deadline = Date.now() + SOFT_CHECK_TOTAL_BUDGET_MS;
  const loadCheckers = deps.loadCompletionCheckers ?? defaultLoadCompletionCheckers;
  const loadConfig = deps.loadCompletionCheckersConfig ?? loadCompletionCheckersConfig;
  const emit = deps.writeSoftCheckEvent ?? defaultWriteSoftCheckEvent;

  let fns: CompletionCheckerFns | null = null;
  try {
    fns = await loadCheckers();
  } catch {
    fns = null;
  }
  if (!fns) {
    logger.info(`[AgentLoop] Soft check: harness completion-checkers unavailable for ${wuId}, segment skipped`);
    return { hint: null };
  }

  const violationBlocks: string[] = [];

  // commit 类两 checker（tdd-chain / phase-format）仅圈定 CODE_WORKTREE_TYPES；
  // 无 worktreePath/baseBranch = 无提交集可判，静默跳过（不记事件）
  if (CODE_WORKTREE_TYPES.has(wu.type)
    && typeof metadata.worktreePath === 'string' && metadata.worktreePath.length > 0
    && typeof metadata.worktreeBaseBranch === 'string' && metadata.worktreeBaseBranch.length > 0) {
    const config = loadConfig(metadata.worktreePath);
    const readCommits = deps.readWuCommits ?? defaultReadWuCommits;
    let commits: CommitInput[] | null = null;
    try {
      commits = readCommits(metadata.worktreePath, metadata.worktreeBaseBranch);
    } catch {
      commits = null;
    }
    if (commits === null) {
      logger.info(`[AgentLoop] Soft check: git log failed for ${wuId}, commit checkers skipped`);
    } else {
      const commitCheckers: Array<() => TddChainResult | PhaseFormatResult> = [
        () => fns.verifyTddChain(commits, config),
        () => fns.verifyPhaseFormat(commits, config),
      ];
      for (const run of commitCheckers) {
        if (Date.now() >= deadline) {
          logger.info(`[AgentLoop] Soft check: total budget exhausted for ${wuId}, remaining checkers skipped`);
          break;
        }
        try {
          const result = run();
          if (result.verdict === 'skip') continue; // 配置禁用 = skip，不记事件
          const block = emitCommitCheckerEvent(emit, wuId, result);
          if (block) violationBlocks.push(block);
        } catch (e) {
          logger.info(`[AgentLoop] Soft check: commit checker threw for ${wuId}, skipped`, { error: String(e) });
        }
      }
    }
  }

  // contract-presence：通用引擎，类型不在 yml contracts 清单内 = skip（不记事件）。
  // 配置根：代码类 = 本 WU worktree；review 等无 worktree 类型回退 baseRepo / 执行 cwd 解析
  // （review 评审的是父 WU worktree 所在的仓，其 .harness 才是契约清单的归属地）。
  if (Date.now() < deadline) {
    let configRoot = metadata.worktreePath ?? metadata.worktreeBaseRepo ?? null;
    if (!configRoot) {
      try {
        configRoot = await deps.resolveExecutionCwd(wu, metadata);
      } catch {
        configRoot = null;
      }
    }
    const config = configRoot ? loadConfig(configRoot) : {};
    try {
      const result = fns.verifyContractPresence(wu.type, { reviewReport: metadata.reviewReport }, config);
      if (result.verdict !== 'skip') {
        const detail = result.detail ?? '';
        emit({ wuId, checker: 'contract-presence', verdict: result.verdict, detail });
        if (result.verdict === 'violation') violationBlocks.push(`[contract-presence] ${detail || '契约标记缺失'}`);
      }
    } catch (e) {
      logger.info(`[AgentLoop] Soft check: contract-presence threw for ${wuId}, skipped`, { error: String(e) });
    }
  }

  const hint = violationBlocks.length > 0
    ? [
      '过程软观测发现以下提交/契约违规（不阻断本次完成；若被打回返工，请一并修正）：',
      ...violationBlocks.map(b => `- ${b}`),
    ].join('\n')
    : null;
  return { hint };
}

/**
 * 依次跑收口守卫（顺序即优先级，前面的守卫任一降级后后续 COMPLETE 守卫不再触发）：
 *  1. §10.5 提交守卫：COMPLETE + 未提交改动 → 降级 progress + commitGuardHint；
 *     PROGRESS 无提交监视（lastCommitHash/noCommitSteps，≥3 → noCommit notice + 归零）。
 *     review WU 整体豁免（评审职责是读不是写）；路径解析/git 失败一律静默跳过。
 *  2. §6-2 子任务守卫：存在未完结子 WU → 降级 progress + childGuardHint。
 *  3. 收口闸 1（产出实）：代码类 COMPLETE 但 base..HEAD 无提交内容 → 降级 progress + diffEmptyHint，
 *     diffEmptyCount ≥3 → diffEmptyBlocked；有提交 → 计数归零。
 *  4. 收口闸 2（产出实）：非代码类契约产物锚点缺失 → 降级 progress + contractArtifactHint，
 *     contractArtifactCount ≥3 → contractArtifactBlocked。
 *  5. B3b-i 自动验证守卫：代码类 WU 有 worktreePath 才跑（runWuVerification）；
 *     失败 → verifyFailCount++/verifyFailHint/l1 rejected 台账/降级，≥3 → verifyBlocked；
 *     全绿 → verifyReport + l1 approved 台账 + verifyPassed 简报。
 *  6. T7-E2 软观测段：仅 action 仍为 complete 才跑；不降级不阻断，违规落台账 +
 *     processCheckHint（详见 runSoftObservation）。
 */
export async function runCompletionGuards(
  ctx: CompletionGuardCtx,
  deps: CompletionGuardDeps,
): Promise<CompletionGuardOutcome> {
  const { wu, wuId, metadata, roleId } = ctx;
  const dirty = deps.hasUncommittedChanges ?? hasUncommittedChanges;
  const headHash = deps.readHeadHash ?? readHeadHash;
  const verify = deps.runVerification ?? runWuVerification;

  let action = ctx.action;
  const guardUpdates: Partial<WorkUnitMetadata> = {};
  const notices: CompletionGuardNotices = {
    noCommit: false,
    verifyPassed: null,
    verifyBlocked: false,
    diffEmptyBlocked: false,
    contractArtifactBlocked: false,
    verifyGuardRan: false,
  };

  // §10.5 提交守卫（发生在状态迁移之前，与 stepCount 守卫同层 —— 不动 VALID_TRANSITIONS）。
  // 路径解析或 git 调用失败一律静默跳过，绝不因基础设施故障阻断完成。
  // B3b-i: cwd 走 resolveExecutionCwd —— 代码类 WU 在专属 worktree 下跑 git status。
  // review WU 整体豁免：评审职责是读不是写（cwd 解析到父 WU worktree，dev 的提交/
  // 工具产物与评审无关），工作区洁净不是它的责任——否则 COMPLETE 被反复打回空转。
  const workspaceRoot = wu.type === 'review' ? null : await deps.resolveExecutionCwd(wu, metadata);
  if (workspaceRoot) {
    if (action === 'complete' && dirty(workspaceRoot)) {
      // COMPLETE 守卫：有未提交改动 → 打回按 PROGRESS 处理，提示注入下一轮 prompt
      action = 'progress';
      guardUpdates.commitGuardHint = '有未提交改动，请先 git add/commit 再报告完成';
      logger.info(`[AgentLoop] Commit guard: COMPLETE downgraded for ${wuId} (uncommitted changes)`);
    }
    if (action === 'progress') {
      // PROGRESS 无提交监视：HEAD 不变 → 累计；连续 3 步发一次频道提醒并归零
      const head = headHash(workspaceRoot);
      if (head) {
        if (metadata.lastCommitHash === head) {
          const next = (metadata.noCommitSteps ?? 0) + 1;
          if (next >= 3) {
            notices.noCommit = true;
            guardUpdates.noCommitSteps = 0;
          } else {
            guardUpdates.noCommitSteps = next;
          }
        } else {
          guardUpdates.lastCommitHash = head;
          guardUpdates.noCommitSteps = 0;
        }
      }
    }
  }

  // §6-2 父 complete 守卫（与提交守卫同层，同一降级为 progress 的模式）：
  // 存在未完结（unassigned/active/blocked/in_review）子 WU 时不允许 complete ——
  // 父一旦抢先 in_review，聚合的状态序防回退会让「子后完成」无法改写父状态（收口顺序：父必须等子）。
  if (action === 'complete') {
    const unfinishedChildren = await deps.listUnfinishedChildren(wuId);
    if (unfinishedChildren.length > 0) {
      action = 'progress';
      guardUpdates.childGuardHint = `存在未完结子任务（${unfinishedChildren.join(', ')}），等待其全部完成后再报告 COMPLETE`;
      logger.info(`[AgentLoop] Child guard: COMPLETE downgraded for ${wuId} (unfinished children: ${unfinishedChildren.length})`);
    }
  }

  // 收口闸 1（产出实）：代码类 WU 声称完成但 base..HEAD 无任何提交内容 → 降级 progress + diffEmptyHint。
  // 提交守卫已保证工作区干净，这里判「有没有提交内容」——空 diff 不许进 in_review。
  // review 不在 CODE_WORKTREE_TYPES（diff-only 不改代码），天然不覆盖；
  // 缺 worktreeBaseBranch / git 失败 → 静默跳过（基础设施故障不阻断完成）。
  // diffEmptyCount ≥3 → blocked（模式同 verifyFailCount）。
  if (action === 'complete'
    && CODE_WORKTREE_TYPES.has(wu.type)
    && typeof metadata.worktreePath === 'string' && metadata.worktreePath.length > 0
    && typeof metadata.worktreeBaseBranch === 'string' && metadata.worktreeBaseBranch.length > 0) {
    const countCommits = deps.countBranchCommits ?? countBranchCommits;
    let commitCount: number | null = null;
    try {
      commitCount = countCommits(metadata.worktreePath, metadata.worktreeBaseBranch);
    } catch {
      commitCount = null;
    }
    if (commitCount === 0) {
      const failCount = (metadata.diffEmptyCount ?? 0) + 1;
      guardUpdates.diffEmptyCount = failCount;
      guardUpdates.diffEmptyHint = `你报告了完成，但相对 ${metadata.worktreeBaseBranch} 没有任何提交内容（第 ${failCount} 次）。请实现并 commit，或说明为何无需改动`;
      action = 'progress';
      notices.diffEmptyBlocked = failCount >= 3;
      logger.info(`[AgentLoop] Diff guard: COMPLETE downgraded for ${wuId} (no commits since ${metadata.worktreeBaseBranch}, count ${failCount})`);
    } else if (commitCount !== null && (metadata.diffEmptyCount ?? 0) > 0) {
      guardUpdates.diffEmptyCount = 0; // 有提交内容 → 计数归零（与 verifyFailCount 同模式）
    }
  }

  // 收口闸 2（产出实）：非代码类 WU 契约产物锚点缺失 → 降级 progress + contractArtifactHint。
  // 锚点分派见 missingContractArtifact（review→reviewReport、plan→analysisTasks、spec→specTasks、
  // decision→decisionSuggestion、analysis→调研报告落盘）；代码类不进本闸（由闸 1 覆盖）。
  // contractArtifactCount ≥3 → blocked（模式同 verifyFailCount）。
  if (action === 'complete') {
    const reportExists = deps.analysisReportExists ?? hasAnalysisReport;
    let missingAnchor: string | null = null;
    try {
      missingAnchor = missingContractArtifact(wu, metadata, reportExists);
    } catch {
      missingAnchor = null; // 检查故障静默跳过，绝不因基础设施故障阻断完成
    }
    if (missingAnchor) {
      const failCount = (metadata.contractArtifactCount ?? 0) + 1;
      guardUpdates.contractArtifactCount = failCount;
      guardUpdates.contractArtifactHint = `契约产物缺失：${missingAnchor}（第 ${failCount} 次）。请补齐产物后再报告完成`;
      action = 'progress';
      notices.contractArtifactBlocked = failCount >= 3;
      logger.info(`[AgentLoop] Contract-artifact guard: COMPLETE downgraded for ${wuId} (missing: ${missingAnchor}, count ${failCount})`);
    }
  }

  // B3b-i（决策 D3 前半）: COMPLETE 前自动验证 —— 仅代码类 WU（有专属 worktree）。
  // 提交守卫/子任务守卫已通过（action 仍为 complete）才跑；命令解析：覆盖 > 约定（见 resolveVerifyCommands）。
  // 全绿 → verifyReport 落档 + 频道简报；任一失败 → 降级 progress，失败命令+输出尾部注入下一轮 prompt，
  // verifyFailCount ≥3 → blocked。无 worktree / 无命令可跑 → 跳过（维持现状）。
  if (action === 'complete'
    && CODE_WORKTREE_TYPES.has(wu.type)
    && typeof metadata.worktreePath === 'string' && metadata.worktreePath.length > 0) {
    const outcome = await verify(wu, metadata, metadata.worktreePath);
    notices.verifyGuardRan = true;
    if (outcome.failure) {
      const failCount = (metadata.verifyFailCount ?? 0) + 1;
      guardUpdates.verifyFailCount = failCount;
      guardUpdates.verifyFailHint = [
        `自动验证未通过（第 ${failCount} 次），请先修复再报告完成`,
        `失败命令: ${outcome.failure.command}`,
        `输出尾部:\n${outcome.failure.tail}`,
      ].join('\n');
      // F6（决策 1）：验证失败同样落台账 l1（rejected 留痕，后续全绿 approved 覆盖）
      guardUpdates.attestations = withAttestation(metadata.attestations, 'l1', {
        verdict: 'rejected',
        by: roleId,
        at: new Date().toISOString(),
        kind: 'verify',
        summary: `失败命令: ${outcome.failure.command}`.slice(0, 300),
      });
      action = 'progress';
      notices.verifyBlocked = failCount >= 3;
      logger.info(`[AgentLoop] Verify guard: COMPLETE downgraded for ${wuId} (command failed: ${outcome.failure.command}, count ${failCount})`);
    } else {
      guardUpdates.verifyFailCount = 0;
      if (outcome.ran.length > 0) {
        guardUpdates.verifyReport = {
          commands: outcome.ran,
          source: outcome.source,
          passedAt: new Date().toISOString(),
        };
        // F6（决策 1）：验证全绿落台账 l1
        guardUpdates.attestations = withAttestation(metadata.attestations, 'l1', {
          verdict: 'approved',
          by: roleId,
          at: new Date().toISOString(),
          kind: 'verify',
          summary: outcome.ran.join('；').slice(0, 300),
        });
        notices.verifyPassed = `✅ 自动验证通过（${outcome.ran.length} 条）：${outcome.ran.join('；')}`;
        logger.info(`[AgentLoop] Verify guard: all passed for ${wuId}`, { commands: outcome.ran, source: outcome.source });
      }
    }
  }

  // T7-E2（#161）第四段：软观测守卫 —— 仅 action 仍为 complete（未被降级）时跑。
  // 只观测不拦截：结果落 checker:soft_check 台账 + processCheckHint（走 prompt-composer
  // 一次性消费回路），不降级、不阻断 COMPLETE；任何故障 fail-open 静默跳过。
  if (action === 'complete') {
    const soft = await runSoftObservation(wu, wuId, metadata, deps);
    if (soft.hint) guardUpdates.processCheckHint = soft.hint;
  }

  return { action, guardUpdates, notices };
}
