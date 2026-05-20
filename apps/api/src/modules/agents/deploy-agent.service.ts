// Deploy Agent Service — deploy readiness check + output generation
import { prisma } from '@dommaker/studio-prisma';
import { logger, eventBus } from '@dommaker/studio-shared';
import * as fs from 'fs';
import * as path from 'path';
import type { DeployParams, DeployFinding, DeployResult } from './types.js';

class DeployAgent {
  async deploy(params: DeployParams): Promise<DeployResult> {
    logger.info('[DeployAgent] Starting deploy check', { executionId: params.executionId });

    // Run all checks in parallel
    const [acFindings, sqlFindings, depFindings] = await Promise.all([
      this.checkAcCompletion(params.worktree),
      this.detectSqlChanges(params.worktree),
      this.detectDependencyChanges(params.worktree),
    ]);

    const findings = [...acFindings, ...sqlFindings, ...depFindings];

    // Blockers prevent deploy
    const hasBlockers = findings.some(f => f.severity === 'blocker');
    if (hasBlockers) {
      logger.warn('[DeployAgent] Blockers found, deploy blocked', {
        executionId: params.executionId,
        blockerCount: findings.filter(f => f.severity === 'blocker').length,
      });
      return {
        success: false,
        type: params.environment,
        findings,
        summary: `部署阻塞: ${findings.filter(f => f.severity === 'blocker').map(f => f.message).join('; ')}`,
      };
    }

    // Route to environment-specific preparation
    const result = params.environment === 'vps'
      ? await this.prepareVps(findings, params)
      : await this.prepareCompany(findings, params);

    eventBus.publish('deploy.completed', { executionId: params.executionId, result });
    logger.info('[DeployAgent] Deploy check completed', { executionId: params.executionId, success: result.success });
    return result;
  }

  // ── AC Completion Check ──

  private async checkAcCompletion(worktree: string): Promise<DeployFinding[]> {
    const findings: DeployFinding[] = [];
    const progressPath = path.join(worktree, '.progress.json');

    try {
      if (fs.existsSync(progressPath)) {
        const progress = JSON.parse(fs.readFileSync(progressPath, 'utf-8'));
        const completed = progress.completedSteps?.length || 0;
        const total = progress.totalSteps || 0;

        if (total > 0 && completed < total) {
          findings.push({
            severity: 'blocker',
            category: 'ac_completion',
            message: `AC 完成 ${completed}/${total}，未全部完成`,
          });
        } else if (total === 0) {
          findings.push({
            severity: 'warning',
            category: 'ac_completion',
            message: 'No AC tracking found in .progress.json',
          });
        } else {
          findings.push({
            severity: 'info',
            category: 'ac_completion',
            message: `All ${total} ACs completed`,
          });
        }
      } else {
        findings.push({
          severity: 'warning',
          category: 'ac_completion',
          message: '.progress.json not found — cannot verify AC completion',
        });
      }
    } catch (e) {
      findings.push({
        severity: 'warning',
        category: 'ac_completion',
        message: `Failed to read .progress.json: ${String(e)}`,
      });
    }

    return findings;
  }

  // ── SQL Change Detection ──

  private async detectSqlChanges(worktree: string): Promise<DeployFinding[]> {
    const findings: DeployFinding[] = [];

    try {
      const { execSync } = await import('child_process');
      const changed = execSync('git diff HEAD~1 --name-only 2>/dev/null || git diff --cached --name-only 2>/dev/null || echo ""', {
        cwd: worktree,
        timeout: 10000,
        encoding: 'utf-8',
      }).trim();

      if (!changed) return findings;

      const sqlFiles = changed.split('\n').filter(f =>
        f.includes('schema.prisma') || f.includes('prisma/migrations/') || f.endsWith('.sql')
      );

      if (sqlFiles.length > 0) {
        findings.push({
          severity: 'warning',
          category: 'sql_change',
          message: `检测到 ${sqlFiles.length} 个数据库变更: ${sqlFiles.join(', ')}`,
        });

        // Check if new migration files exist (require DBA ticket for company deploys)
        const migrationFiles = sqlFiles.filter(f => f.includes('prisma/migrations/'));
        if (migrationFiles.length > 0) {
          findings.push({
            severity: 'info',
            category: 'sql_change',
            message: `新迁移文件: ${migrationFiles.join(', ')}`,
          });
        }
      } else {
        findings.push({
          severity: 'info',
          category: 'sql_change',
          message: 'No database changes detected',
        });
      }
    } catch (e) {
      findings.push({
        severity: 'warning',
        category: 'sql_change',
        message: `SQL change detection failed: ${String(e)}`,
      });
    }

    return findings;
  }

  // ── Dependency Change Detection ──

  private async detectDependencyChanges(worktree: string): Promise<DeployFinding[]> {
    const findings: DeployFinding[] = [];

    try {
      const { execSync } = await import('child_process');
      const changed = execSync('git diff HEAD~1 --name-only 2>/dev/null || git diff --cached --name-only 2>/dev/null || echo ""', {
        cwd: worktree,
        timeout: 10000,
        encoding: 'utf-8',
      }).trim();

      if (!changed) return findings;

      const depFiles = changed.split('\n').filter(f =>
        f === 'package.json' || f === 'pnpm-lock.yaml' || f === 'package-lock.json' || f === 'yarn.lock'
      );

      if (depFiles.length > 0) {
        findings.push({
          severity: 'warning',
          category: 'dependency_change',
          message: `依赖变更: ${depFiles.join(', ')}，需要重新安装依赖`,
        });
      } else {
        findings.push({
          severity: 'info',
          category: 'dependency_change',
          message: 'No dependency changes detected',
        });
      }
    } catch (e) {
      findings.push({
        severity: 'warning',
        category: 'dependency_change',
        message: `Dependency change detection failed: ${String(e)}`,
      });
    }

    return findings;
  }

  // ── Environment-Specific Output ──

  private async prepareVps(findings: DeployFinding[], params: DeployParams): Promise<DeployResult> {
    const warnings = findings.filter(f => f.severity === 'warning');
    const hasDbChanges = findings.some(f => f.category === 'sql_change' && f.severity !== 'info');

    const steps: string[] = [];
    if (hasDbChanges) steps.push('1. pnpm db:migrate:prod');
    steps.push(hasDbChanges ? '2. pnpm build' : '1. pnpm build');
    steps.push(hasDbChanges ? '3. docker build -t studio-api:latest .' : '2. docker build -t studio-api:latest .');
    steps.push(hasDbChanges ? '4. docker push studio-api:latest' : '3. docker push studio-api:latest');
    steps.push(hasDbChanges ? '5. docker-compose up -d' : '4. docker-compose up -d');
    steps.push(hasDbChanges ? '6. curl -f http://localhost:3001/health' : '5. curl -f http://localhost:3001/health');

    const tag = `studio-api:${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${params.executionId.slice(0, 8)}`;

    return {
      success: true,
      type: 'vps',
      findings,
      artifact: tag,
      summary: `VPS Deploy:\n${steps.join('\n')}\n\n${warnings.length ? `⚠️ Warnings: ${warnings.map(w => w.message).join('; ')}` : ''}`,
    };
  }

  private async prepareCompany(findings: DeployFinding[], params: DeployParams): Promise<DeployResult> {
    const isBackend = params.environment === 'company_backend';
    const hasSqlChanges = findings.some(f => f.category === 'sql_change' && f.message.includes('migrations'));

    const lines: string[] = [
      `## 发布清单 — ${params.environment === 'company_frontend' ? '前端' : '后端'}`,
      '',
      `**执行 ID**: ${params.executionId.slice(0, 8)}`,
      `**分支**: ${path.basename(params.worktree)}`,
      `**时间**: ${new Date().toISOString()}`,
      '',
      '### 变更摘要',
    ];

    for (const f of findings) {
      lines.push(`- [${f.severity === 'info' ? 'i' : f.severity === 'warning' ? '!' : 'x'}] ${f.message}`);
    }

    if (hasSqlChanges && isBackend) {
      lines.push('', '### DBA 提交单', '', '请 DBA 团队审批以下数据库变更：', '- 检查 schema.prisma 变更', '- 检查 prisma/migrations/ 新增迁移', '- 在 staging 环境先执行并验证', '', '负责人: ________   日期: ________');
    }

    lines.push('', '### 回归测试建议', '- [ ] E2E 测试通过', '- [ ] API 集成测试通过', isBackend ? '- [ ] 数据库迁移回滚测试' : '- [ ] 前端冒烟测试');

    return {
      success: true,
      type: params.environment,
      findings,
      artifact: path.basename(params.worktree),
      summary: lines.join('\n'),
    };
  }
}

export const deployAgent = new DeployAgent();
