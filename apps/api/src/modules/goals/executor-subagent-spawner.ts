/**
 * Executor Sub-agent Spawner — 组内波次并行实现。
 *
 * @deprecated Pipeline（Goal 系统）已废弃，由 Agent Network 替代。Phase 4 将删除整个 goals/ 目录。
 *
 * Parent = 系统代码（不做 LLM 推理），Sub-agent = Claude session（用 green-only-tdd Skill）。
 * 参考 reviewParallel() 模式：write prompt → pipe to `claude --print` → collect results。
 */

import { logger, buildSpawnEnv } from '@dommaker/studio-shared';
import { execSh } from '@dommaker/studio-shared/node';
import { analyzeWaves, canSpawnSubAgents, reserveSubAgentSlots, releaseSubAgentSlots, type WaveAC } from './scheduler-prompt.js';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

export interface SubAgentAC {
  id: string;
  acs: string[];
  files: string[];
  dependencies?: string[];
  implementationNotes?: string;
  architectureContext?: Record<string, unknown>;
}

export interface SubAgentResult {
  acId: string;
  success: boolean;
  changedFiles: string[];
  error?: string;
  durationMs: number;
}

export interface SpawnOptions {
  worktree: string;
  acs: SubAgentAC[];
  goalTitle: string;
  modelTier?: 'fast' | 'standard' | 'premium';
  timeoutMs?: number;
}

/**
 * Spawn Executor sub-agents per wave. 每波内并行，波次间串行。
 * 返回所有 AC 的执行结果。
 */
export async function spawnExecutorSubAgents(opts: SpawnOptions): Promise<SubAgentResult[]> {
  const waveAcs: WaveAC[] = opts.acs.map(ac => ({
    id: ac.id,
    files: ac.files,
    dependencies: ac.dependencies,
  }));

  const waves = analyzeWaves(waveAcs);
  const results: SubAgentResult[] = [];

  for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
    const wave = waves[waveIdx];
    const waveAcIds = wave.map(w => w.id);
    const waveAcsFull = wave.map(w => opts.acs.find(a => a.id === w.id)!).filter(Boolean);

    if (!canSpawnSubAgents(wave.length)) {
      logger.warn('[ExecutorSubAgent] MAX_SUB_AGENTS reached, waiting', {
        waveIdx, requested: wave.length,
      });
      // 简化实现：不排队，直接报错（让上层重试）
      throw new Error(`MAX_SUB_AGENTS limit: need ${wave.length} slots but global limit reached`);
    }

    reserveSubAgentSlots(wave.length);
    try {
      const waveResults = await Promise.all(
        waveAcsFull.map(ac => spawnSingleSubAgent(opts, ac, waveIdx)),
      );
      results.push(...waveResults);

      // 如果有失败，不继续后续波次
      const failed = waveResults.filter(r => !r.success);
      if (failed.length > 0) {
        logger.warn('[ExecutorSubAgent] Wave has failures, stopping', {
          waveIdx, failed: failed.map(r => r.acId),
        });
        break;
      }
    } finally {
      releaseSubAgentSlots(wave.length);
    }
  }

  return results;
}

async function spawnSingleSubAgent(
  opts: SpawnOptions,
  ac: SubAgentAC,
  waveIdx: number,
): Promise<SubAgentResult> {
  const startTime = Date.now();
  const prompt = buildSubAgentPromptForAC(ac, opts.goalTitle);
  const promptFile = path.join(opts.worktree, `.subagent-${ac.id}-prompt.md`);
  fs.writeFileSync(promptFile, prompt, 'utf-8');

  const model = opts.modelTier || 'fast';
  const cmd = [
    `cd "${opts.worktree}"`,
    `&&`,
    `cat '${promptFile}'`,
    `|`,
    `claude`,
    `--print`,
    `--output-format json`,
    `--allowedTools "Read,Write,Edit,Bash(vitest|npx vitest|npx tsc|tsc|git status|git diff|git add|git commit|ls|cat)"`,
    `2>&1`,
  ].join(' ');

  try {
    const { stdout } = await execSh(cmd, {
      cwd: opts.worktree,
      env: {
        ...buildSpawnEnv({ tier: model, role: 'executor' }),
        HOME: `/tmp/execution-subagent-${ac.id}-${Date.now()}`,
      },
      timeoutMs: opts.timeoutMs || 10 * 60 * 1000,
      maxBuffer: 5 * 1024 * 1024,
    });

    // Cleanup prompt file
    try { fs.unlinkSync(promptFile); } catch { /* best-effort */ }

    let envelope: { result?: string; is_error?: boolean };
    try {
      envelope = JSON.parse(stdout);
    } catch {
      envelope = { result: stdout, is_error: false };
    }

    const isError = envelope.is_error === true;
    const changedFiles = extractChangedFiles(envelope.result || '');

    return {
      acId: ac.id,
      success: !isError,
      changedFiles,
      error: isError ? (envelope.result || '').slice(0, 500) : undefined,
      durationMs: Date.now() - startTime,
    };
  } catch (err) {
    try { fs.unlinkSync(promptFile); } catch { /* best-effort */ }
    return {
      acId: ac.id,
      success: false,
      changedFiles: [],
      error: String(err).slice(0, 500),
      durationMs: Date.now() - startTime,
    };
  }
}

function buildSubAgentPromptForAC(ac: SubAgentAC, goalTitle: string): string {
  const acLines = ac.acs.map((a, i) => `${i + 1}. ${a}`).join('\n');
  const filesList = ac.files.map(f => `- ${f}`).join('\n');

  return [
    `## 你的任务`,
    `目标: ${goalTitle}`,
    `AC: ${ac.id}`,
    '',
    '## 验收标准',
    acLines,
    '',
    ...(ac.files.length > 0 ? ['## 预期改动文件', filesList, ''] : []),
    ...(ac.implementationNotes ? ['## 实现指南', ac.implementationNotes, ''] : []),
    '',
    '## 约束',
    '- 只改上述文件，不碰其他 AC 的文件',
    '- 不创建新 .test.ts 文件（契约测试已存在）',
    '- 改完后报告 changedFiles 列表',
    '',
    '## 工作流',
    '1. 读 __tests__/ 中的契约测试 → 理解预期行为',
    '2. 最小实现让测试通过',
    '3. 运行 vitest 确认通过',
    '4. 运行 tsc --noEmit 确认无类型错误',
    '5. 报告 changedFiles',
  ].join('\n');
}

function extractChangedFiles(output: string): string[] {
  // Sub-agent 输出的 changedFiles 解析（简单启发式）
  const match = output.match(/changedFiles[:\s]*\[([^\]]*)\]/i);
  if (match) {
    return match[1].split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
  }
  return [];
}

/**
 * 系统强制 commit — 不依赖 Agent 是否 commit。
 * 解决 P4: Executor 不 commit 但设 allComplete=true。
 *
 * @returns commit hash 或 null（无变更时）
 */
export function forceCommit(worktree: string, message: string): string | null {
  try {
    // 检查是否有变更
    const status = execSync('git status --porcelain', { cwd: worktree, encoding: 'utf-8' });
    if (!status.trim()) {
      logger.info('[ExecutorSubAgent] forceCommit: no changes to commit', { worktree });
      return null;
    }

    execSync('git add -A', { cwd: worktree, encoding: 'utf-8' });
    execSync(`git commit -m "${message.replace(/"/g, '\\"')}"`, {
      cwd: worktree,
      encoding: 'utf-8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Pipeline',
        GIT_AUTHOR_EMAIL: 'pipeline@studio.local',
        GIT_COMMITTER_NAME: 'Pipeline',
        GIT_COMMITTER_EMAIL: 'pipeline@studio.local',
      },
    });

    const hash = execSync('git rev-parse HEAD', { cwd: worktree, encoding: 'utf-8' }).trim();
    logger.info('[ExecutorSubAgent] forceCommit: committed', { worktree, hash, message });
    return hash;
  } catch (err) {
    logger.error('[ExecutorSubAgent] forceCommit failed', { worktree, error: String(err) });
    throw err;
  }
}
