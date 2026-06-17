/**
 * Analyst Knowledge — 输出路径管理 + worktree 初始化
 *
 * 知识闭环：Analyst findings → knowledgeBus.recordPattern() → KnowledgeStore
 * 消费：buildKnowledgeContext() → prompt 注入（不再走文件）
 */
import * as fs from 'fs';
import * as path from 'path';

export const ANALYST_DIR = process.env.ANALYST_DIR || path.join(process.env.REPO_DIR || process.cwd(), '.analyst');

export function perInvocationOutputFile(): string {
  return path.join(ANALYST_DIR, `output-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`);
}

export function ensureWorktree(): void {
  if (!fs.existsSync(ANALYST_DIR)) {
    fs.mkdirSync(ANALYST_DIR, { recursive: true });
  }
}
