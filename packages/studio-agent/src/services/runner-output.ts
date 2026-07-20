/**
 * Runner Output — 输出解析（agent-runner.ts 拆分模块）
 *
 * 从 agent-runner.ts 按职责拆出的执行输出/状态解析逻辑：
 *   - hasRecentActivity: worktree 文件 mtime 探测（stuck 判定的延期依据）
 *   - queryResolutionHints: RKB 已知解法查询（session 错误输出 → resolutionHint）
 *
 * 零行为变更：函数体均自 agent-runner.ts 平移。
 */

import * as path from 'path';
import * as fsSync from 'fs';
import * as os from 'os';
import { FileStore } from '@dommaker/studio-shared';

const fileStore = new FileStore();

/** Files excluded from mtime check (agent writes these regardless of real progress) */
const MTIME_EXCLUDED_FILES = new Set(['.progress.json', '.agent.log']);

/**
 * Check if any file in the worktree was modified within the threshold.
 * Used to defer stuck detection during I/O waits (npm install, tsc, vitest).
 *
 * Scans top-level files + src/ directory (recursive). Excludes node_modules,
 * .progress.json, .agent.log, and all dot-prefixed entries.
 * Caps at 200 stat calls to keep check under 100ms.
 */
export function hasRecentActivity(worktreePath: string, thresholdMs = 3 * 60 * 1000): boolean {
  const cutoff = Date.now() - thresholdMs;
  let statCalls = 0;
  const MAX_STATS = 200;

  if (!fsSync.existsSync(worktreePath)) {
    return false;
  }

  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync(worktreePath, { withFileTypes: true });
  } catch {
    return false;
  }

  /** Check a single file's mtime. Returns true if recent. */
  function isRecent(filePath: string): boolean {
    if (statCalls >= MAX_STATS) return false;
    statCalls++;
    try {
      return fsSync.statSync(filePath).mtimeMs > cutoff;
    } catch {
      return false;
    }
  }

  /** Recursively check directory entries (skips excluded dirs). */
  function checkDir(dirPath: string): boolean {
    if (statCalls >= MAX_STATS) return false;
    let dirEntries: fsSync.Dirent[];
    try {
      dirEntries = fsSync.readdirSync(dirPath, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of dirEntries) {
      if (statCalls >= MAX_STATS) return false;
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isFile()) {
        if (isRecent(fullPath)) return true;
      } else if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
        if (checkDir(fullPath)) return true;
      }
    }
    return false;
  }

  for (const entry of entries) {
    if (statCalls >= MAX_STATS) break;
    const name = entry.name;

    // Skip excluded: dotfiles, node_modules
    if (name.startsWith('.') || name === 'node_modules') continue;

    const fullPath = path.join(worktreePath, name);

    if (entry.isFile() && !MTIME_EXCLUDED_FILES.has(name)) {
      if (isRecent(fullPath)) return true;
    }

    // Recurse into src/
    if (entry.isDirectory() && name === 'src') {
      if (checkDir(fullPath)) return true;
    }
  }

  return false;
}

/**
 * RKB: query known resolutions for a session error message.
 * 返回可注入下一轮 prompt 的 resolutionHint；无匹配或查询失败返回 ''（调用方保留旧值）。
 */
export async function queryResolutionHints(errMsg: string): Promise<string> {
  try {
    const knowledgeDir = path.join(os.homedir(), '.studio', 'knowledge');
    const allKeys = await fileStore.listDocs(knowledgeDir);
    const resKeys = allKeys.filter((k: string) => k.startsWith('resolution-'));
    const resolutions: any[] = [];
    for (const key of resKeys) {
      const doc = await fileStore.readDoc(knowledgeDir, key);
      if (doc && (doc.meta.maturity === 'verified' || doc.meta.maturity === 'canonical')) {
        resolutions.push({
          id: key.replace('resolution-', ''),
          pattern: doc.meta.pattern || '',
          title: doc.meta.title || '',
          fix: (doc.body || '').replace(/^#.*\n/, '').replace(/^## Solution\n/, '').trim(),
          verifyCount: doc.meta.verifyCount || 0,
          status: doc.meta.maturity,
        });
      }
    }
    resolutions.sort((a: any, b: any) => (b.verifyCount || 0) - (a.verifyCount || 0));
    const matched: string[] = [];
    const lowerMsg = errMsg.toLowerCase();
    for (const r of resolutions) {
      try {
        if (new RegExp(r.pattern, 'i').test(errMsg)) {
          matched.push(`- **${r.title}**: ${r.fix}`);
        }
      } catch {
        if (lowerMsg.includes(r.pattern.toLowerCase())) {
          matched.push(`- **${r.title}**: ${r.fix}`);
        }
      }
    }
    if (matched.length > 0) {
      return '## \u5df2\u77e5\u89e3\u6cd5 (RKB)\n\u4ee5\u4e0b\u89e3\u6cd5\u66fe\u5728\u7c7b\u4f3c\u9519\u8bef\u4e0a\u9a8c\u8bc1\u6709\u6548\uff1a\n' + matched.join('\n');
    }
  } catch { /* non-blocking */ }
  return '';
}
