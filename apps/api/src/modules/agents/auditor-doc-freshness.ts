/**
 * Auditor Agent — Doc Freshness Issue 处理
 *
 * 从 auditor-agent.service.ts 拆分（审计规则/执行/报告分离，零行为变更）。
 * 本模块负责处理 CI 创建的 doc-freshness issues：
 *   - numeric/status 差异: 自动修复 + 创建 PR
 *   - narrative 差异: 添加分析评论，保持 issue open
 *
 * 依赖 `gh` CLI (GitHub Actions runner 或服务器上可用)。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '@dommaker/studio-shared';

/**
 * 处理 CI 创建的 doc-freshness issues:
 * - numeric/status 差异: 自动修复 + 创建 PR
 * - narrative 差异: 添加分析评论，保持 issue open
 *
 * 依赖 `gh` CLI (GitHub Actions runner 或服务器上可用)。
 */
export async function handleDocFreshnessIssues(): Promise<void> {
  try {
    const { execSync } = await import('child_process');

    // 1. 搜索 open 的 doc-freshness issues
    let issues: Array<{ number: number; title: string; body: string; labels: string[] }>;
    try {
      const raw = execSync(
        'gh issue list --label doc-freshness --state open --json number,title,body,labels --limit 10',
        { encoding: 'utf-8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      issues = JSON.parse(raw);
    } catch (e) {
      logger.warn('[AuditorAgent] gh issue list failed (gh CLI not available?)', { error: String(e).slice(0, 200) });
      return;
    }

    if (issues.length === 0) {
      logger.info('[AuditorAgent] No open doc-freshness issues');
      return;
    }

    logger.info('[AuditorAgent] Processing doc-freshness issues', { count: issues.length });

    for (const issue of issues) {
      try {
        await processDocFreshnessIssue(issue, execSync);
      } catch (e) {
        logger.warn('[AuditorAgent] Failed to process doc-freshness issue', {
          issueNumber: issue.number,
          error: String(e).slice(0, 200),
        });
      }
    }
  } catch (e) {
    logger.warn('[AuditorAgent] handleDocFreshnessIssues failed', { error: String(e) });
  }
}

/**
 * 处理单个 doc-freshness issue:
 * 1. 解析 issue body 中的差异报告
 * 2. numeric/status → 运行 ci-doc-freshness-check 重新检测 → 如果仍有差异，自动修复文档
 * 3. narrative → 添加分析评论
 */
export async function processDocFreshnessIssue(
  issue: { number: number; title: string; body: string; labels: string[] },
  execSync: typeof import('child_process').execSync,
): Promise<void> {
  const repoDir = process.env.REPO_DIR || process.cwd();

  // 从 issue body 解析差异类型
  const body = issue.body || '';
  const hasNumeric = /\|\s*numeric\s*\|\s*([1-9]\d*)\s*\|/.test(body);
  const hasStatus = /\|\s*status\s*\|\s*([1-9]\d*)\s*\|/.test(body);
  const hasNarrative = /\|\s*narrative\s*\|\s*([1-9]\d*)\s*\|/.test(body);

  if (!hasNumeric && !hasStatus && !hasNarrative) {
    // 无法解析 — 添加提示评论并关闭
    try {
      execSync(
        `gh issue comment ${issue.number} --body "无法解析差异报告。手动检查文档新鲜度。"`,
        { cwd: repoDir, encoding: 'utf-8', timeout: 15_000, stdio: 'pipe' },
      );
      execSync(`gh issue close ${issue.number}`, {
        cwd: repoDir, encoding: 'utf-8', timeout: 15_000, stdio: 'pipe',
      });
    } catch { /* non-blocking */ }
    return;
  }

  // 重新运行检测确认差异仍然存在
  let reportJson: any;
  try {
    const reportRaw = execSync(
      `bash ${os.homedir()}/.studio/skills/always/doc-freshness/scripts/ci-doc-freshness-check.sh --project-path "${repoDir}" 2>/dev/null || true`,
      { encoding: 'utf-8', timeout: 120_000, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    reportJson = JSON.parse(reportRaw);
  } catch {
    reportJson = null;
  }

  if (!reportJson || reportJson.summary?.totalDiffs === 0) {
    // 差异已消失 — 关闭 issue
    try {
      execSync(
        `gh issue comment ${issue.number} --body "重新检测：差异已消失（可能已被其他提交修复）。关闭此 issue。"`,
        { cwd: repoDir, encoding: 'utf-8', timeout: 15_000, stdio: 'pipe' },
      );
      execSync(`gh issue close ${issue.number}`, {
        cwd: repoDir, encoding: 'utf-8', timeout: 15_000, stdio: 'pipe',
      });
      logger.info('[AuditorAgent] Doc-freshness issue closed (diffs resolved)', { issueNumber: issue.number });
    } catch { /* non-blocking */ }
    return;
  }

  // 处理 numeric/status 差异 — 尝试自动修复
  const autoFixableDiffs = (reportJson.diffs || []).filter(
    (d: any) => d.type === 'numeric' || d.type === 'status',
  );
  const narrativeDiffs = (reportJson.diffs || []).filter(
    (d: any) => d.type === 'narrative',
  );

  let autoFixSummary = '';

  if (autoFixableDiffs.length > 0) {
    try {
      const fixResult = await autoFixDocDiffs(autoFixableDiffs, repoDir);
      autoFixSummary = fixResult;

      if (fixResult) {
        // 创建 PR
        const date = new Date().toISOString().slice(0, 10);
        const branchName = `doc-freshness/auto-fix/${date}`;

        try {
          execSync(
            `gh pr create --title "[doc-freshness] 自动修复 ${date}" --body "${fixResult}" --label doc-freshness`,
            { cwd: repoDir, encoding: 'utf-8', timeout: 30_000, stdio: 'pipe' },
          );
          autoFixSummary += '\n\nPR 已创建。';
        } catch (e) {
          logger.warn('[AuditorAgent] PR creation failed', { error: String(e).slice(0, 200) });
          autoFixSummary += '\n\nPR 创建失败，需手动提交修复。';
        }
      }
    } catch (e) {
      logger.warn('[AuditorAgent] Auto-fix failed', { error: String(e).slice(0, 200) });
      autoFixSummary = '自动修复失败，需手动处理。';
    }
  }

  // 构建评论
  const commentParts: string[] = ['## Auditor 自动处理报告', ''];

  if (autoFixableDiffs.length > 0) {
    commentParts.push('### Numeric/Status 差异（自动修复）');
    commentParts.push(autoFixSummary || '无修复摘要');
    commentParts.push('');
  }

  if (narrativeDiffs.length > 0) {
    commentParts.push('### Narrative 差异（需人工审查）');
    for (const d of narrativeDiffs) {
      commentParts.push(`- **${d.doc}** (L${d.line || '?'}): ${d.claim}`);
      commentParts.push(`  - 代码实际值: \`${d.actual || 'N/A'}\``);
    }
    commentParts.push('');
    commentParts.push('叙述性差异需要人工判断是否需要更新文档措辞。请审查后手动修复或关闭此 issue。');
  }

  // 发布评论
  try {
    const commentBody = commentParts.join('\n').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    execSync(
      `gh issue comment ${issue.number} --body "$(echo -e '${commentBody}')"`,
      { cwd: repoDir, encoding: 'utf-8', timeout: 15_000, stdio: 'pipe' },
    );
  } catch (e) {
    logger.warn('[AuditorAgent] Failed to comment on issue', {
      issueNumber: issue.number,
      error: String(e).slice(0, 200),
    });
  }

  // 如果只有 narrative 差异且无 auto-fix，保持 issue open
  // 如果 auto-fix 成功且无 narrative，关闭 issue
  if (autoFixableDiffs.length > 0 && narrativeDiffs.length === 0 && autoFixSummary) {
    try {
      execSync(`gh issue close ${issue.number}`, {
        cwd: repoDir, encoding: 'utf-8', timeout: 15_000, stdio: 'pipe',
      });
      logger.info('[AuditorAgent] Doc-freshness issue closed (auto-fixed)', { issueNumber: issue.number });
    } catch { /* non-blocking */ }
  }

  logger.info('[AuditorAgent] Doc-freshness issue processed', {
    issueNumber: issue.number,
    autoFixable: autoFixableDiffs.length,
    narrative: narrativeDiffs.length,
  });
}

/**
 * 自动修复 numeric/status 类型的文档差异
 * 返回修复摘要，空字符串表示无修复
 */
export async function autoFixDocDiffs(diffs: Array<{
  doc: string; type: string; claim: string; expected: string; actual: string; line?: number;
}>, repoDir: string): Promise<string> {
  const fixed: string[] = [];
  const failed: string[] = [];

  for (const diff of diffs) {
    try {
      if (!diff.doc || !diff.actual || !diff.expected) {
        failed.push(`${diff.doc}: 缺少 expected/actual 值`);
        continue;
      }

      // 读取文档
      const fullPath = path.isAbsolute(diff.doc)
        ? diff.doc
        : path.join(repoDir, diff.doc);

      if (!fs.existsSync(fullPath)) {
        failed.push(`${diff.doc}: 文件不存在`);
        continue;
      }

      const content = fs.readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n');

      // 定位目标行: 优先用 line，否则搜索 actual 值
      let targetLine = -1;
      if (diff.line && diff.line > 0 && diff.line <= lines.length) {
        targetLine = diff.line - 1; // 0-indexed
      } else {
        // 搜索包含 actual 值的行
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].includes(diff.actual)) {
            targetLine = i;
            break;
          }
        }
      }

      if (targetLine < 0) {
        failed.push(`${diff.doc}: 无法定位 "${diff.actual}"`);
        continue;
      }

      // 替换 actual → expected
      lines[targetLine] = lines[targetLine].replace(diff.actual, diff.expected);
      fs.writeFileSync(fullPath, lines.join('\n'), 'utf-8');
      fixed.push(`${diff.doc} L${targetLine + 1}: "${diff.actual}" → "${diff.expected}"`);
    } catch (e) {
      failed.push(`${diff.doc}: ${String(e).slice(0, 100)}`);
    }
  }

  if (fixed.length === 0) return '';

  // Git commit
  try {
    const { execSync } = await import('child_process');
    const date = new Date().toISOString().slice(0, 10);
    const branchName = `doc-freshness/auto-fix/${date}`;

    execSync(`git checkout -b "${branchName}"`, { cwd: repoDir, timeout: 10_000, stdio: 'pipe' });
    execSync(`git add -A`, { cwd: repoDir, timeout: 10_000, stdio: 'pipe' });
    execSync(`git commit -m "fix(doc-freshness): auto-fix ${fixed.length} numeric/status diffs"`, {
      cwd: repoDir, timeout: 10_000, stdio: 'pipe',
    });
  } catch (e) {
    logger.warn('[AuditorAgent] Git commit for doc-freshness fix failed', { error: String(e).slice(0, 200) });
  }

  const parts = [`已自动修复 ${fixed.length} 处差异:`];
  for (const f of fixed) parts.push(`- ${f}`);
  if (failed.length > 0) {
    parts.push('', `${failed.length} 处修复失败:`);
    for (const f of failed) parts.push(`- ${f}`);
  }
  return parts.join('\n');
}
