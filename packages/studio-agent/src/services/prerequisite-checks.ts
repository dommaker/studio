/**
 * Prerequisite Checks — 执行前置检查（session-manager.ts 拆分模块）
 *
 * 2026-08-04: 从 session-manager.ts 按职责拆出的前置检查：
 *   provider CLI 健康探测 / 磁盘空间 / worktrees 目录可写 / git repo 校验
 *
 * 零行为变更：函数体自 AgentExecutor.checkPrerequisites() 平移；实例 config 经参数传入。
 */

import * as fs from 'fs/promises';
import { logger } from '@dommaker/studio-shared';
import { execSh, resolveProviderDefinition, buildHealthProbeCommand, type ProviderId } from '@dommaker/studio-shared/node';

import type { ExecutorConfig } from './session-manager.js';

// ─── 前置检查结果 ───

export interface PrerequisiteCheck {
  name: string;
  passed: boolean;
  message: string;
  isWarning?: boolean;
}

export async function checkPrerequisites(config: Pick<ExecutorConfig, 'repoDir' | 'worktreesDir'>, provider: ProviderId = 'claude'): Promise<PrerequisiteCheck[]> {
  const checks: PrerequisiteCheck[] = [];
  logger.info('[AgentExecutor] Checking prerequisites', { repoDir: config.repoDir });

  // F4: provider CLI health probe from the registry (claude keeps the old message/shape)
  const providerDef = resolveProviderDefinition(provider);
  const probeCmd = buildHealthProbeCommand(provider);
  const cliCheckName = `${providerDef.displayName} CLI`;
  const cliUnavailable = `${providerDef.binaries[0]} 命令不可用`;
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

  // 磁盘空间
  try {
    const { stdout } = await execSh("df -h . | tail -1 | awk '{print $4}'", {
      cwd: config.worktreesDir,
      timeoutMs: 5_000,
    });
    const cleaned = stdout.trim().replace(/[^0-9.]/g, '');
    const availableGB = parseInt(cleaned, 10);
    if (isNaN(availableGB)) {
      checks.push({ name: '磁盘空间', passed: true, message: `无法解析: "${stdout.trim()}"`, isWarning: true });
    } else {
      checks.push({
        name: '磁盘空间', passed: availableGB >= 5,
        message: `磁盘空间: ${availableGB}GB`,
        isWarning: availableGB < 5 && availableGB >= 2,
      });
    }
  } catch {
    checks.push({ name: '磁盘空间', passed: true, message: '无法检测', isWarning: true });
  }

  // worktrees 目录
  try {
    await fs.mkdir(config.worktreesDir, { recursive: true });
    checks.push({ name: 'worktrees 目录', passed: true, message: `目录可写: ${config.worktreesDir}` });
  } catch {
    checks.push({ name: 'worktrees 目录', passed: false, message: `目录不可写: ${config.worktreesDir}` });
  }

  // git repo
  try {
    await execSh('git rev-parse --git-dir', {
      cwd: config.repoDir,
      timeoutMs: 5_000,
    });
    checks.push({ name: 'Git Repo', passed: true, message: `主仓库: ${config.repoDir}` });
  } catch {
    checks.push({ name: 'Git Repo', passed: false, message: `${config.repoDir} 不是 git 仓库` });
  }

  return checks;
}
