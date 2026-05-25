/**
 * SessionSummaryAgent — 会话级知识提取 (2026-05-25)
 *
 * 在 daemon 启动时运行，提取上次会话以来所有非 Goal 维度的知识：
 *   - git log 中的 fix/feat/refactor commits → KnowledgeBus patterns
 *   - journal 中的 error 模式 → KB
 *   - .agent.log 中的 session stats → KB
 *
 * 纯代码，不依赖 LLM。
 * 非阻塞，失败不影响 daemon 启动。
 */

import { execSync } from 'child_process';
import { logger } from '@dommaker/studio-shared';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const CHECKPOINT_FILE = path.join(os.homedir(), '.studio', 'session-checkpoint.json');
const REPO_DIR = process.env.REPO_DIR || process.cwd();

interface SessionCheckpoint {
  lastCommit: string;
  lastShutdown: string;
  updatedAt: string;
}

interface CommitInfo {
  hash: string;
  type: 'fix' | 'feat' | 'refactor' | 'test' | 'chore' | 'unknown';
  message: string;
  files: string[];
}

class SessionSummaryAgent {
  /**
   * 启动时调用。读取上次 checkpoint 以来的变更，提取知识。
   */
  async summarize(): Promise<{ commits: number; patterns: number }> {
    const startTime = Date.now();
    let commitCount = 0;
    let patternCount = 0;

    try {
      const cp = this.readCheckpoint();
      const commits = this.getNewCommits(cp.lastCommit);
      commitCount = commits.length;

      if (commits.length === 0) {
        logger.info('[SessionSummary] No new commits since last session');
        return { commits: 0, patterns: 0 };
      }

      // 分类
      const classified = commits.map(c => ({ ...c, type: this.classifyCommit(c.message) }));

      // 提取 fix patterns → KnowledgeBus
      patternCount = await this.extractFixPatterns(classified);

      // 提取 feat 摘要 → KnowledgeBus (用于下游 Agent 上下文注入)
      await this.extractFeatSummaries(classified);

      // 更新 checkpoint
      this.writeCheckpoint(commits[0].hash);

      const durationMs = Date.now() - startTime;
      logger.info('[SessionSummary] Complete', {
        commits: commitCount,
        patterns: patternCount,
        durationMs,
      });

    } catch (e) {
      logger.warn('[SessionSummary] Failed (non-blocking)', { error: String(e) });
    }

    return { commits: commitCount, patterns: patternCount };
  }

  // ── Checkpoint ──

  private readCheckpoint(): SessionCheckpoint {
    try {
      if (fs.existsSync(CHECKPOINT_FILE)) {
        return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf-8'));
      }
    } catch {}
    return { lastCommit: 'HEAD~50', lastShutdown: '', updatedAt: '' };
  }

  private writeCheckpoint(commit: string): void {
    const dir = path.dirname(CHECKPOINT_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CHECKPOINT_FILE, JSON.stringify({
      lastCommit: commit,
      lastShutdown: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    } satisfies SessionCheckpoint, null, 2), 'utf-8');
  }

  // ── Git ──

  private getNewCommits(sinceCommit: string): CommitInfo[] {
    try {
      const out = execSync(
        `git log ${sinceCommit}..HEAD --format="%H||%s" --name-only`,
        { cwd: REPO_DIR, encoding: 'utf-8', timeout: 10_000, stdio: 'pipe' },
      );
      return this.parseGitLog(out);
    } catch {
      return [];
    }
  }

  private parseGitLog(output: string): CommitInfo[] {
    const commits: CommitInfo[] = [];
    const blocks = output.split('\n\n');
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length === 0) continue;
      const [hash, ...msgParts] = lines[0].split('||');
      const message = msgParts.join('||');
      const files = lines.slice(1).filter(f => f.trim());
      if (hash && message) {
        commits.push({ hash: hash.trim(), message, files, type: 'unknown' });
      }
    }
    return commits;
  }

  // ── Classification ──

  private classifyCommit(message: string): CommitInfo['type'] {
    const m = message.toLowerCase();
    if (/^fix[:(\[]/.test(m) || m.startsWith('fix ')) return 'fix';
    if (/^feat[:(\[]/.test(m) || m.startsWith('feat ')) return 'feat';
    if (/^refactor[:(\[]/.test(m) || m.startsWith('refactor ')) return 'refactor';
    if (/^test[:(\[]/.test(m) || m.startsWith('test ')) return 'test';
    if (/^chore[:(\[]/.test(m) || m.startsWith('chore ')) return 'chore';
    return 'unknown';
  }

  // ── Pattern extraction ──

  private async extractFixPatterns(commits: Array<{ hash: string; type: string; message: string; files: string[] }>): Promise<number> {
    let count = 0;
    try {
      const { knowledgeBus } = await import('../knowledge/knowledge-bus.service.js');

      for (const c of commits) {
        if (c.type !== 'fix') continue;

        const gap = this.extractGapFromMessage(c.message);
        const trigger = this.extractTrigger(c.message, c.files);

        await knowledgeBus.recordPattern({
          source: 'session-summary',
          type: 'pattern',
          title: `[Session Fix] ${c.message.slice(0, 120)}`,
          content: `Commit: ${c.hash.slice(0, 8)}\nMessage: ${c.message}\nFiles: ${c.files.join(', ')}\nPattern: ${gap}\nTriggers: ${trigger}`,
          severity: 'info',
          timestamp: Date.now(),
        });
        count++;
      }
    } catch (e) {
      logger.warn('[SessionSummary] Pattern extraction failed', { error: String(e) });
    }
    return count;
  }

  private async extractFeatSummaries(commits: Array<{ hash: string; type: string; message: string; files: string[] }>): Promise<void> {
    try {
      const { knowledgeBus } = await import('../knowledge/knowledge-bus.service.js');

      for (const c of commits) {
        if (c.type !== 'feat') continue;

        await knowledgeBus.recordPattern({
          source: 'session-summary',
          type: 'pattern',
          title: `[Session Feature] ${c.message.slice(0, 120)}`,
          content: `Commit: ${c.hash.slice(0, 8)}\nMessage: ${c.message}\nFiles: ${c.files.join(', ')}`,
          severity: 'info',
          timestamp: Date.now(),
        });
      }
    } catch {
      // non-blocking
    }
  }

  private extractGapFromMessage(message: string): string {
    // Heuristic: extract the core problem pattern from the commit message
    // "fix: X → Y" or "fix: prevent X" or "fix: X now Y"
    const clean = message.replace(/^(fix[:(\[]\s*)/i, '').slice(0, 200);
    return clean;
  }

  private extractTrigger(message: string, files: string[]): string {
    const parts: string[] = [];
    if (files.length === 1) parts.push(`single-file(${files[0]})`);
    else if (files.length <= 3) parts.push(`few-files`);
    else parts.push(`multi-file`);

    const lower = message.toLowerCase();
    if (lower.includes('race') || lower.includes('cascade')) parts.push('concurrency');
    if (lower.includes('timeout')) parts.push('timeout');
    if (lower.includes('cleanup') || lower.includes('leak')) parts.push('resource-leak');
    if (lower.includes('format') || lower.includes('schema') || lower.includes('json')) parts.push('data-format');
    if (lower.includes('prompt')) parts.push('prompt-engineering');

    return parts.join(', ');
  }
}

export const sessionSummaryAgent = new SessionSummaryAgent();
