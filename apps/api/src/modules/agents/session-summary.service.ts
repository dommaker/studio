/**
 * SessionSummaryService — 会话级知识提取 (2026-05-25)
 *
 * 在 daemon 启动时运行，提取上次会话以来所有非 WorkUnit 维度的知识：
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

class SessionSummaryService {
  /**
   * 启动时调用。读取上次 checkpoint 以来的变更，提取知识。
   */
  async summarize(): Promise<{ commits: number; patterns: number }> {
    const startTime = Date.now();
    let commitCount = 0;
    let patternCount = 0;

    try {
      const cp = this.readCheckpoint();
      // checkpoint 的 lastCommit 可能已不在仓库（历史被改写 / 换过 REPO_DIR）——
      // 直接用会让 git log 每次启动都报 Invalid revision range 且 checkpoint 永不更新
      // （getNewCommits 失败返回 [] → 不写新 checkpoint → 周期性报错）。先校验再回退。
      const sinceCommit = this.resolveSinceCommit(cp.lastCommit);
      const commits = this.getNewCommits(sinceCommit);
      commitCount = commits.length;

      if (commits.length === 0) {
        logger.info('[SessionSummary] No new commits since last session');
        return { commits: 0, patterns: 0 };
      }

      // 分类
      const classified = commits.map(c => ({ ...c, type: this.classifyCommit(c.message) }));
      logger.info('[SessionSummary] Classified commits', {
        types: classified.reduce((acc, c) => { acc[c.type] = (acc[c.type] || 0) + 1; return acc; }, {} as Record<string, number>),
      });

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

  /** rev 是否存在于仓库（git cat-file -e；失败=false） */
  private commitExists(rev: string): boolean {
    try {
      execSync(`git cat-file -e "${rev}^{commit}"`, { cwd: REPO_DIR, stdio: 'pipe', timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 解析有效的 sinceCommit：checkpoint 值存在则用之；否则回退 HEAD~50（与
   * readCheckpoint 默认值同口径），HEAD~50 也不存在（仓库不足 50 提交）则返回 ''
   * （getNewCommits 以 --max-count=50 兜底）。
   */
  private resolveSinceCommit(checkpointCommit: string): string {
    if (checkpointCommit && this.commitExists(checkpointCommit)) return checkpointCommit;
    if (checkpointCommit) {
      logger.info('[SessionSummary] Checkpoint commit missing from repo, falling back', { stale: checkpointCommit });
    }
    if (this.commitExists('HEAD~50')) return 'HEAD~50';
    return '';
  }

  private getNewCommits(sinceCommit: string): CommitInfo[] {
    try {
      // sinceCommit 为空（短仓库兜底）：全量但封顶 50 条
      const range = sinceCommit ? `${sinceCommit}..HEAD` : '--max-count=50';
      const out = execSync(
        `git log ${range} --format="%H||%s" --name-only`,
        { cwd: REPO_DIR, encoding: 'utf-8', timeout: 10_000, stdio: 'pipe' },
      );
      const result = this.parseGitLog(out);
      if (result.length <= 1 && out.length > 1000) {
        logger.warn('[SessionSummary] Git log parsing may be incomplete', { outputLen: out.length, parsedCount: result.length, firstLine: out.split('\n')[0]?.slice(0, 80) });
      }
      return result;
    } catch(e) {
      logger.warn('[SessionSummary] Git log failed', { error: String(e) });
      return [];
    }
  }

  private parseGitLog(output: string): CommitInfo[] {
    const commits: CommitInfo[] = [];
    const HASH_RE = /^[0-9a-f]{40}/;
    let currentHash = '';
    let currentMsg = '';
    let currentFiles: string[] = [];
    let passedSeparator = false; // blank line between hash||msg and file list

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        passedSeparator = true; // git inserts blank line after hash||msg
        continue;
      }

      // New commit: detect 40-char hex hash at start
      if (HASH_RE.test(trimmed) && trimmed.includes('||')) {
        if (currentHash) {
          commits.push({ hash: currentHash, message: currentMsg, files: currentFiles, type: 'unknown' });
        }
        const parts = trimmed.split('||');
        currentHash = parts[0];
        currentMsg = parts.slice(1).join('||') || '';
        currentFiles = [];
        passedSeparator = false;
        continue;
      }

      // File line
      currentFiles.push(trimmed);
    }
    // Last commit
    if (currentHash && currentMsg) {
      commits.push({ hash: currentHash, message: currentMsg, files: currentFiles, type: 'unknown' });
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
      const { knowledgeService } = await import('../knowledge/knowledge-service.js');

      for (const c of commits) {
        if (c.type !== 'fix') continue;
        logger.info('[SessionSummary] Extracting fix pattern', { commit: c.hash.slice(0, 8), message: c.message.slice(0, 80) });

        const gap = this.extractGapFromMessage(c.message);
        const trigger = this.extractTrigger(c.message, c.files);

        try {
          await knowledgeService.recordPattern({
            type: 'pattern',
            title: `[Session Fix] ${c.message.slice(0, 120)}`,
            content: `Commit: ${c.hash.slice(0, 8)}\nMessage: ${c.message}\nFiles: ${c.files.join(', ')}\nPattern: ${gap}\nTriggers: ${trigger}`,
            tags: ['session-summary'],
          });
          count++;
        } catch (e) {
          logger.warn('[SessionSummary] Failed to record pattern', { commit: c.hash.slice(0, 8), error: String(e) });
        }
      }
    } catch (e) {
      logger.warn('[SessionSummary] Pattern extraction failed (import phase)', { error: String(e) });
    }
    return count;
  }

  private async extractFeatSummaries(commits: Array<{ hash: string; type: string; message: string; files: string[] }>): Promise<void> {
    try {
      const { knowledgeService } = await import('../knowledge/knowledge-service.js');

      for (const c of commits) {
        if (c.type !== 'feat') continue;

        await knowledgeService.recordPattern({
          type: 'pattern',
          title: `[Session Feature] ${c.message.slice(0, 120)}`,
          content: `Commit: ${c.hash.slice(0, 8)}\nMessage: ${c.message}\nFiles: ${c.files.join(', ')}`,
          tags: ['session-summary'],
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

export const sessionSummaryService = new SessionSummaryService();
