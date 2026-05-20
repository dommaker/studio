/**
 * 任务分配服务 - 角色匹配 + Workflow 触发 + PR 创建
 */
import { execSync } from 'child_process';
import { prisma, logger } from './meeting-shared.js';
import { ReviewGate } from '@dommaker/harness';
import type { GateContext } from '@dommaker/harness';
import { afterPrCreated } from '@dommaker/studio-shared/harness/hooks';

const reviewGate = new ReviewGate({
  minReviewers: parseInt(process.env.REVIEW_GATE_MIN_REVIEWERS || '1'),
  requireApproval: process.env.REVIEW_GATE_REQUIRE_APPROVAL === 'true',
  blockOnChangesRequested: process.env.REVIEW_GATE_BLOCK_ON_CHANGES_REQUESTED === 'true',
});

/**
 * 获取项目工作目录
 */
function getProjectWorkDir(projectId: string, pmoNumber: string): string {
  const workDirs = process.env.PROJECT_WORKDIRS
    ? JSON.parse(process.env.PROJECT_WORKDIRS)
    : {};
  if (workDirs[projectId]) return workDirs[projectId];
  return process.env.PROJECTS_DIR
    ? `${process.env.PROJECTS_DIR}/${pmoNumber}`
    : `${path.join(os.homedir(), "projects")}/${pmoNumber}`;
}

/**
 * FL-017: 自动创建 Pull Request
 * AS-007: ReviewGate 验证审查状态
 *
 * 合并自 tasks/routes.ts 和 executions/routes.ts 的重复实现，
 * 新增 git push 逻辑（来自 executions/routes.ts）。
 */
export async function createPullRequest(project: {
  id: string;
  pmoNumber: string;
  gitBranch: string;
  gitRepo?: string;
}): Promise<{ url: string; number: number; reviewStatus?: unknown }> {
  const repo = project.gitRepo || 'openclaw/openclaw';
  const branch = project.gitBranch;

  // 1. git push（如果本地有 repo 目录）
  const localGitRepo = getProjectWorkDir(project.id, project.pmoNumber);
  try {
    const remoteCheck = execSync(`cd ${localGitRepo} && git remote -v 2>/dev/null`, { encoding: 'utf-8', timeout: 5000 });
    if (remoteCheck.includes('origin')) {
      execSync(`cd ${localGitRepo} && git push -u origin ${branch}`, { encoding: 'utf-8', timeout: 30000 });
      logger.info('[PR] Pushed branch to origin', { branch });
    }
  } catch {
    logger.warn('[PR] Push failed (non-blocking), PR creation may fail if branch not pushed');
  }

  // 2. diff 检查
  try {
    const diffResult = execSync(`git diff --stat origin/main ${branch}`, { encoding: 'utf-8' });
    if (!diffResult.trim()) {
      logger.info('[PR] No changes detected, skipping PR creation', { branch });
      return { url: '', number: 0 };
    }
  } catch {
    logger.warn('[PR] Branch may not exist, skipping', { branch });
    return { url: '', number: 0 };
  }

  // 3. gh pr create
  const title = `feat(${project.pmoNumber}): Implementation completed`;
  const body = `## 项目：${project.pmoNumber}

### 任务列表
所有任务已完成，请审查。

### Checklist
- [ ] 代码符合 Spec
- [ ] AC 覆盖完整
- [ ] 无明显问题`;

  const ghCommand = `gh pr create --repo ${repo} --head ${branch} --base main --title "${title}" --body "${body}"`;

  try {
    const result = execSync(ghCommand, { encoding: 'utf-8' });
    const match = result.match(/https:\/\/github\.com\/.+\/pull\/(\d+)/);

    if (match) {
      const prNumber = parseInt(match[1]);
      const url = match[0];

      // 4. ReviewGate 验证
      const projectPath = getProjectWorkDir(project.id, project.pmoNumber);
      const gateContext: GateContext = { projectId: project.id, projectPath, prNumber };
      const reviewResult = await reviewGate.check(gateContext);
      logger.info('[PR] ReviewGate checked', { prNumber, reviewResult });

      // Phase 4: PR 创建后 hook
      afterPrCreated().catch(err => logger.warn('[PR] afterPrCreated hook failed', { error: String(err) }));

      return { url, number: prNumber, reviewStatus: reviewResult };
    }
  } catch (e) {
    logger.error('[PR] gh pr create failed', { error: e instanceof Error ? e.message : String(e) });
    throw new Error('Failed to create PR with gh CLI');
  }

  return { url: '', number: 0 };
}
