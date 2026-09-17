/**
 * Runner Params — 参数构建（agent-runner.ts 拆分模块）
 *
 * 从 agent-runner.ts 按职责拆出的 spawn/prompt 参数构建逻辑：
 *   - prompt 增强（buildAugmentedPrompt）
 *   - spawn 命令构建（cmd 组装 / env）
 *   - 前置检查（checkPrerequisites）
 *
 * cmd/env 组装块原为 loop / lightweight 两模式共享抽取；#562 删 loop、#587 删其
 * 遗留的 session flag / --add-dir 构建 helper 后，只剩 lightweight 消费方。
 * #155：SDD task 层解析（resolveSddTaskData）已随 SDD 体系退役删除——
 * contractTests/testFiles 只取 task.parameters（DB 值）。
 */

import * as fs from 'fs/promises';
import { logger } from '@dommaker/studio-shared';
import { execSh, resolveProviderDefinition, buildHealthProbeCommand, getSupportedFlags } from '@dommaker/studio-shared/node';
import { buildSpawnArgs, type Provider, type SpawnParams } from '../cli-adapter.js';
import { kimiCodeHomePath, kimiCodeHomeReady } from './provider-hooks.js';

import type { ExecutorConfig, AgentTask, PrerequisiteCheck } from './types.js';

// ========================================
// Prerequisites
// ========================================

export async function checkPrerequisites(config: Pick<ExecutorConfig, 'repoDir' | 'worktreesDir'>, provider: string = 'claude'): Promise<PrerequisiteCheck[]> {
  const checks: PrerequisiteCheck[] = [];
  logger.info('[AgentRunner] Checking prerequisites', { repoDir: config.repoDir });

  // F4: provider CLI health probe from the registry (claude keeps the old message/shape)
  const providerDef = resolveProviderDefinition(provider);
  const probeCmd = buildHealthProbeCommand(provider);
  const cliCheckName = `${providerDef.displayName} CLI`;
  const cliUnavailable = `${providerDef.binaries[0]} \u547d\u4ee4\u4e0d\u53ef\u7528`;
  try {
    const { stdout } = await execSh(`${probeCmd} 2>&1 || echo "NOT_FOUND"`, {
      cwd: '/tmp',
      timeoutMs: 10_000,
    });
    if (stdout.includes('NOT_FOUND')) {
      checks.push({ name: cliCheckName, passed: false, message: cliUnavailable });
    } else {
      checks.push({ name: cliCheckName, passed: true, message: stdout.trim().slice(0, 80) });
    }
  } catch {
    checks.push({ name: cliCheckName, passed: false, message: cliUnavailable });
  }

  try {
    const { stdout } = await execSh("df -h . | tail -1 | awk '{print $4}'", {
      cwd: config.worktreesDir,
      timeoutMs: 5_000,
    });
    const cleaned = stdout.trim().replace(/[^0-9.]/g, '');
    const availableGB = parseInt(cleaned, 10);
    if (isNaN(availableGB)) {
      checks.push({ name: '\u78c1\u76d8\u7a7a\u95f4', passed: true, message: `\u65e0\u6cd5\u89e3\u6790: "${stdout.trim()}"`, isWarning: true });
    } else {
      checks.push({
        name: '\u78c1\u76d8\u7a7a\u95f4', passed: availableGB >= 5,
        message: `\u78c1\u76d8\u7a7a\u95f4: ${availableGB}GB`,
        isWarning: availableGB < 5 && availableGB >= 2,
      });
    }
  } catch {
    checks.push({ name: '\u78c1\u76d8\u7a7a\u95f4', passed: true, message: '\u65e0\u6cd5\u68c0\u6d4b', isWarning: true });
  }

  try {
    await fs.mkdir(config.worktreesDir, { recursive: true });
    checks.push({ name: 'worktrees \u76ee\u5f55', passed: true, message: `\u76ee\u5f55\u53ef\u5199: ${config.worktreesDir}` });
  } catch {
    checks.push({ name: 'worktrees \u76ee\u5f55', passed: false, message: `\u76ee\u5f55\u4e0d\u53ef\u5199: ${config.worktreesDir}` });
  }

  try {
    await execSh('git rev-parse --git-dir', {
      cwd: config.repoDir,
      timeoutMs: 5_000,
    });
    checks.push({ name: 'Git Repo', passed: true, message: `\u4e3b\u4ed3\u5e93: ${config.repoDir}` });
  } catch {
    checks.push({ name: 'Git Repo', passed: false, message: `${config.repoDir} \u4e0d\u662f git \u4ed3\u5e93` });
  }

  return checks;
}


// ========================================
// Prompt building
// ========================================

/**
 * Build augmented prompt by prepending knowledge context.
 *
 * Pure function — no side effects.
 *
 * @param basePrompt - Original prompt text
 * @param knowledgeContext - Optional knowledge context to prepend
 * @returns Augmented prompt with knowledge context, or original prompt if no context
 */
export function buildAugmentedPrompt(basePrompt: string, knowledgeContext?: string): string {
  const trimmed = knowledgeContext?.trim();
  if (!trimmed) return basePrompt;
  return trimmed + '\n\n---\n\n' + basePrompt;
}

// ========================================
// Spawn command building
// ========================================

export interface SessionCommandOptions {
  /** CLI provider id */
  provider: Provider;
  /** Passed through to buildSpawnArgs（仅 worktreeDir / sessionId / sessionResume / maxTurns） */
  spawnParams: SpawnParams;
  /** 工作目录（cmd 以 cd "<worktree>" 开头） */
  worktree: string;
  /** prompt 文件路径（promptViaStdin / promptFlag 都引用它） */
  promptFile: string;
}

/**
 * Assemble the full shell command for one session spawn.
 * AC1.1: stream-json output format 来自 cli-adapter 的 registry 模板。
 */
export function buildSessionCommand(opts: SessionCommandOptions): string {
  const providerDef = resolveProviderDefinition(opts.provider);
  // #565: 能力探测——目标 CLI 不认识的 conditionalFlags 在 spawn 前剔除；
  // 探测失败/未声明探测返回 undefined = fail-open 全量传参，行为与现状一致。
  const supportedFlags = getSupportedFlags(opts.provider);
  const spawnArgs = buildSpawnArgs(opts.provider, { ...opts.spawnParams, supportedFlags });
  // --verbose already ships in claude's registry template; literal kept for the legacy cmd shape
  const verboseArg = spawnArgs.args.includes('--verbose') ? '' : (opts.provider === 'claude' ? `--verbose` : '');
  const promptArg = providerDef.spawn.promptViaStdin
    ? `< "${opts.promptFile}"`
    : providerDef.spawn.promptFlag
      ? `${providerDef.spawn.promptFlag} "$(cat "${opts.promptFile}")"`
      : `"$(cat "${opts.promptFile}")"`;
  return [
    `cd "${opts.worktree}"`,
    `&&`,
    spawnArgs.command,
    ...spawnArgs.args,
    verboseArg,
    promptArg,
    `2>&1`,
  ].filter(Boolean).join(' ');
}

export interface SessionEnvOptions {
  task: AgentTask;
  role: 'analyst' | 'executor';
  /** lightweight 模式追加注入 STUDIO_WORKUNIT_ID + parameters.extraEnv（loop 模式不注入） */
  withWorkUnitEnv?: boolean;
  /** 执行目录：provider=kimi 且 per-worktree home 已生成时注入 KIMI_CODE_HOME（#147 P1） */
  worktree?: string;
}

/** Spawn env: process.env 透传（token/base_url/model 均由 env 继承，无需 settings.json 搬运）。 */
export function buildSessionEnv(opts: SessionEnvOptions): NodeJS.ProcessEnv {
  const { task } = opts;
  // #147 P1：kimi 多 WU 隔离——KIMI_CODE_HOME 指向 per-worktree home（provider-hooks
  // ensureKimiHookHome 生成：host config 复制 + hook 追加 + 凭证软链）。home 未生成
  // （kimi 未安装/生成失败）则不注入，kimi 回落全局 home，不因隔离失败阻断 spawn。
  const kimiCodeHome = opts.worktree && task.provider === 'kimi' && kimiCodeHomeReady(opts.worktree)
    ? kimiCodeHomePath(opts.worktree)
    : null;
  return {
    ...process.env,
    // root 下 claude --resume 自愈（2026-07-30 走查实锤）：cwd 的 .claude/settings.json
    // 声明 bypassPermissions 时，CLI 续用会话会自注入 --dangerously-skip-permissions，
    // 而 root guard（getuid===0 && IS_SANDBOX!=="1"）直接 exit 1 —— 同 WU 第 2+ step
    // 全部秒败。IS_SANDBOX=1 是 CLI 预留的沙箱声明：不放宽任何权限（settings 本就
    // 声明 bypassPermissions），只让 root guard 放行。已实测复现并验证。
    IS_SANDBOX: process.env.IS_SANDBOX ?? '1',
    STUDIO_EXECUTION_ID: task.executionId,
    ...(kimiCodeHome ? { KIMI_CODE_HOME: kimiCodeHome } : {}),
    ...(task.parameters?.goalId ? { STUDIO_GOAL_ID: task.parameters.goalId as string } : {}),
    ...(opts.withWorkUnitEnv && task.parameters?.workUnitId ? { STUDIO_WORKUNIT_ID: task.parameters.workUnitId as string } : { STUDIO_WORKUNIT_ID: undefined }),
    ...(opts.withWorkUnitEnv ? (task.parameters?.extraEnv as Record<string, string> || {}) : {}),
  };
}
