/**
 * Contract Test RED Check — Layer 4: 执行测试验证 RED 状态
 *
 * Analyst 写的 contractTests 必须是 RED 状态（测试失败），
 * 因为此时还没有任何实现代码。如果测试通过，说明：
 * - 测试没有实际断言（空壳测试）
 * - 测试的功能已经存在（不需要实现）
 * - 测试写错了
 *
 * 监控日志: CT-3 (RED Verification)
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@dommaker/studio-shared';

// ========================================
// Types
// ========================================

export interface RedCheckInput {
  /** acGroup ID */
  acGroupId: string;
  /** 测试文件列表 [{file, content}] */
  contractTests: Array<{ file: string; content: string }>;
  /** worktree 目录 */
  worktree: string;
  /** 超时时间（ms） */
  timeout?: number;
}

export interface RedCheckResult {
  /** acGroup ID */
  acGroupId: string;
  /** 每个测试文件的 RED 状态 */
  files: Array<{
    file: string;
    written: boolean;
    exitCode: number;
    isRed: boolean;
    failureType: 'passed' | 'failed' | 'error' | 'syntax_error' | 'timeout';
    testCount: number;
    failureCount: number;
    durationMs: number;
    errors: string[];
  }>;
  /** 整体是否 RED（所有文件都 should fail） */
  overallRed: boolean;
  /** 总测试数 */
  totalTests: number;
  /** 总失败数 */
  totalFailures: number;
}

// ========================================
// RED Verification
// ========================================

/**
 * 将 contractTest 文件写入 worktree 并执行 vitest，验证 RED 状态。
 *
 * @returns 每个文件的 RED 状态和整体结果
 */
export function verifyRedState(input: RedCheckInput): RedCheckResult {
  const { acGroupId, contractTests, worktree, timeout = 60_000 } = input;
  const startTime = Date.now();

  const fileResults: RedCheckResult['files'] = [];

  for (const test of contractTests) {
    const testPath = path.join(worktree, test.file);

    // 确保目录存在
    const testDir = path.dirname(testPath);
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }

    // 写入测试文件
    let written = false;
    try {
      fs.writeFileSync(testPath, test.content, 'utf-8');
      written = true;
    } catch (e) {
      fileResults.push({
        file: test.file,
        written: false,
        exitCode: -1,
        isRed: false,
        failureType: 'error',
        testCount: 0,
        failureCount: 0,
        durationMs: 0,
        errors: [`Failed to write test file: ${String(e)}`],
      });
      continue;
    }

    // 执行 vitest
    const fileStart = Date.now();
    let exitCode = 0;
    let stdout = '';
    let stderr = '';
    let failureType: RedCheckResult['files'][0]['failureType'] = 'failed';

    try {
      // vitest run: 退出码 0=全部通过, 1=有失败, 其他=错误
      stdout = execSync(
        `npx vitest run --reporter=json ${test.file} 2>&1`,
        {
          cwd: worktree,
          timeout,
          encoding: 'utf-8',
          stdio: 'pipe',
          env: { ...process.env, CI: 'true' },
        },
      );
      exitCode = 0;
      // 测试全部通过 → 不是 RED 状态
      failureType = 'passed';
    } catch (err: unknown) {
      const e = err as {
        status?: number;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      exitCode = e.status || 1;
      stdout = e.stdout || '';
      stderr = e.stderr || '';

      // 判断失败类型
      if (exitCode === 1) {
        // 正常测试失败 → RED 状态 ✓
        failureType = 'failed';
      } else if (stdout.includes('SyntaxError') || stderr.includes('SyntaxError')) {
        failureType = 'syntax_error';
      } else if (e.message?.includes('timeout') || exitCode === 124) {
        failureType = 'timeout';
      } else {
        failureType = 'error';
      }
    }

    const durationMs = Date.now() - fileStart;

    // 解析测试数量
    let testCount = 0;
    let failureCount = 0;
    try {
      const result = JSON.parse(stdout);
      testCount = result.numTotalTests || 0;
      failureCount = result.numFailedTests || 0;
    } catch {
      // 非 JSON 输出，尝试从 stdout 提取
      const testMatch = stdout.match(/Tests\s+(\d+)\s+failed/i);
      if (testMatch) {
        failureCount = parseInt(testMatch[1]) || 0;
      }
    }

    // RED 状态判断: exitCode !== 0 且 failureType === 'failed'
    const isRed = exitCode !== 0 && failureType === 'failed';

    fileResults.push({
      file: test.file,
      written,
      exitCode,
      isRed,
      failureType,
      testCount,
      failureCount,
      durationMs,
      errors: stderr ? [stderr.slice(0, 500)] : [],
    });

    // CT-3 monitoring: per-file RED verification
    logger.info('[ContractTest] RED Verification', {
      acGroupId,
      testFile: test.file,
      written,
      exitCode,
      isRed,
      failureType,
      testCount,
      failureCount,
      durationMs,
    });
  }

  const totalTests = fileResults.reduce((sum, f) => sum + f.testCount, 0);
  const totalFailures = fileResults.reduce((sum, f) => sum + f.failureCount, 0);
  const overallRed = fileResults.every(f => f.isRed);
  const totalDuration = Date.now() - startTime;

  // CT-3 monitoring: summary
  logger.info('[ContractTest] RED Verification', {
    acGroupId,
    summary: true,
    fileCount: fileResults.length,
    overallRed,
    totalTests,
    totalFailures,
    durationMs: totalDuration,
    files: fileResults.map(f => ({
      file: f.file,
      isRed: f.isRed,
      failureType: f.failureType,
    })),
  });

  return {
    acGroupId,
    files: fileResults,
    overallRed,
    totalTests,
    totalFailures,
  };
}

/**
 * 清理写入的测试文件（可选，在 revision 后需要清理）
 */
export function cleanupRedCheckFiles(worktree: string, contractTests: Array<{ file: string }>): void {
  for (const test of contractTests) {
    const testPath = path.join(worktree, test.file);
    try {
      if (fs.existsSync(testPath)) {
        fs.unlinkSync(testPath);
      }
    } catch {
      // non-blocking cleanup
    }
  }
}
