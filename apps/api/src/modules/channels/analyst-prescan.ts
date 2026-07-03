/**
 * Analyst PreScan — Rule-based code scope detection (0 LLM tokens)
 *
 * Reads CLAUDE.md + requirement text to determine exploration scope for Scouts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { logger } from '@dommaker/studio-shared';

export interface ScoutScope {
  modules: string[];
  keyFiles: string[];
  concerns: string[];  // 'schema' | 'auth' | 'test' | 'api' | 'code' | 'knowledge'
  directoryMap: Record<string, string>;
}

/**
 * Detect exploration scope from requirement text + CLAUDE.md.
 * Pure function, 0 LLM tokens.
 */
export function preScan(requirement: string, repoDir: string): ScoutScope {
  const lower = requirement.toLowerCase();

  // 1. Read CLAUDE.md for module/directory list
  const claudeMdPath = path.join(repoDir, 'CLAUDE.md');
  const claudeMd = fs.existsSync(claudeMdPath) ? fs.readFileSync(claudeMdPath, 'utf-8') : '';

  // 2. Extract directory mentions from CLAUDE.md (lines with paths)
  const directoryMap: Record<string, string> = {};
  const dirPattern = /(?:^|\s)((?:apps|packages|libs)\/[^\s|]+)/gm;
  let match: RegExpExecArray | null;
  while ((match = dirPattern.exec(claudeMd)) !== null) {
    const dir = match[1].replace(/\/$/, '');
    if (!directoryMap[dir]) {
      const lineStart = claudeMd.lastIndexOf('\n', match.index) + 1;
      const lineEnd = claudeMd.indexOf('\n', match.index);
      const line = claudeMd.slice(lineStart, lineEnd > 0 ? lineEnd : match.index + 100).trim();
      directoryMap[dir] = line.slice(0, 100);
    }
  }

  // 3. Keyword extraction from requirement → module matching
  const modules: string[] = [];
  const keyFiles: string[] = [];

  // Extract file paths mentioned in requirement
  const filePathPattern = /(?:[\w/.-]+\.(?:ts|tsx|js|json|md))/g;
  const fileMatches = requirement.match(filePathPattern) || [];
  keyFiles.push(...fileMatches);

  // Extract module-like keywords
  const moduleKeywords = [
    'channel', 'goal', 'executor', 'review', 'deploy', 'knowledge',
    'scheduler', 'agent', 'monitor', 'skill', 'session', 'worktree',
    'auth', 'schema', 'migration', 'prisma', 'mcp', 'harness', 'analyst',
  ];
  for (const kw of moduleKeywords) {
    if (lower.includes(kw)) modules.push(kw);
  }

  // 4. Concern classification
  const concerns: string[] = [];
  if (/schema|migration|prisma|migrate|数据库/i.test(lower)) concerns.push('schema');
  if (/auth|login|password|token|oauth|jwt|security/i.test(lower)) concerns.push('auth');
  if (/test|测试|mock|vitest/i.test(lower)) concerns.push('test');
  if (/api|route|endpoint|http|rest/i.test(lower)) concerns.push('api');
  concerns.push('code');      // always include code scout
  concerns.push('knowledge');  // always include knowledge scout

  logger.info('[AnalystPreScan] Scope detected', {
    modules: modules.length,
    keyFiles: keyFiles.length,
    concerns,
    directories: Object.keys(directoryMap).length,
  });

  return { modules, keyFiles, concerns, directoryMap };
}
