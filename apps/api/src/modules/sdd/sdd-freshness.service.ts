/**
 * SDD Doc Freshness Service
 *
 * SP-004 Step 9: 检测代码变更，增量 patch SDD 文档。
 *
 * 流程：
 *   git diff --name-only → changed files
 *   → 匹配 SDD requirement.md body 中的 Files 段
 *   → classifySddChange (L1-L4)
 *   → L1: skip / L2: patch task / L3: patch design+task / L4: patch requirement+design+task
 *   → LLM patch (保留未改动 section)
 *   → version++, parentId = old version
 *   → append CHANGELOG
 */

import {
  readSddDoc,
  writeSddDoc,
  listSddDocs,
  appendChangelog,
} from '@dommaker/studio-shared';
import type { SddFrontmatter } from '@dommaker/studio-shared';
import { logger } from '@dommaker/studio-shared';
import { getSystemExecutor } from '../agents/system-executor.js';

// ── ChangeLevel (aligned with SP-002 change.types.ts) ──
export type ChangeLevel = 'L1' | 'L2' | 'L3' | 'L4';

// ── Types ──

export interface SddChangePlan {
  /** SDD slug (directory name) */
  slug: string;
  /** Change level determined by classifySddChange */
  level: ChangeLevel;
  /** Matched changed files that belong to this SDD */
  matchedFiles: string[];
}

// ── classifySddChange ──

/**
 * Check if diff only contains whitespace, comment, or string literal changes.
 */
function isTypoOrFormat(gitDiff: string): boolean {
  const addedLines: string[] = [];
  const removedLines: string[] = [];

  for (const line of gitDiff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) {
      addedLines.push(line.slice(1));
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      removedLines.push(line.slice(1));
    }
  }

  // Empty diff is not a typo fix
  if (addedLines.length === 0 && removedLines.length === 0) return false;

  // Threshold: <= 3 changed lines total
  const totalChanged = addedLines.length + removedLines.length;
  if (totalChanged > 3) return false;

  const isTrivialLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (trimmed === '') return true; // whitespace-only
    // comment-only
    if (trimmed.startsWith('//') || trimmed.startsWith('#')) return true;
    if (trimmed.startsWith('/*') || trimmed.startsWith('*')) return true;
    // import-only (formatting change)
    if (trimmed.startsWith('import ')) return true;
    // string literal only (trailing comma, quote style)
    if (/^['"`].*['"`][,;]?$/.test(trimmed)) return true;
    // pure punctuation / bracket
    if (/^[{}\[\](),;:]+$/.test(trimmed)) return true;
    return false;
  };

  return [...addedLines, ...removedLines].every(isTrivialLine);
}

/**
 * Count total added + removed lines in a unified diff.
 */
function countDiffLines(gitDiff: string): number {
  let count = 0;
  for (const line of gitDiff.split('\n')) {
    if (
      (line.startsWith('+') && !line.startsWith('+++')) ||
      (line.startsWith('-') && !line.startsWith('---'))
    ) {
      count++;
    }
  }
  return count;
}

/**
 * Check if diff contains any new file additions (diff --git ... /dev/null).
 */
function hasNewFiles(gitDiff: string): boolean {
  return /^diff --git a\/.+ b\/.+\nnew file mode/m.test(gitDiff);
}

/**
 * Classify change level based on git diff stats.
 *
 * - L1: format/typo (<=3 lines, all trivial)
 * - L2: small (<=2 files, <=30 lines)
 * - L3: medium (<=5 files or has new files)
 * - L4: large (everything else)
 */
export function classifySddChange(
  gitDiff: string,
  changedFiles: string[],
): ChangeLevel {
  if (isTypoOrFormat(gitDiff)) return 'L1';

  const fileCount = changedFiles.length;
  const lineCount = countDiffLines(gitDiff);

  // New files escalate to L3 regardless of line count
  if (hasNewFiles(gitDiff)) return 'L3';
  if (fileCount <= 2 && lineCount <= 30) return 'L2';
  if (fileCount <= 5) return 'L3';
  return 'L4';
}

// ── Files section parsing ──

/**
 * Parse the `## Files` section from SDD requirement.md body.
 *
 * Expected format:
 * ```
 * ## Files
 *
 * - src/foo.ts
 * - src/bar.ts
 * ```
 *
 * Returns list of file paths (glob-style or literal).
 */
export function parseFilesSection(body: string): string[] {
  const lines = body.split('\n');
  const files: string[] = [];
  let inFilesSection = false;

  for (const line of lines) {
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      if (inFilesSection) break; // exited Files section
      inFilesSection =
        h2[1].trim() === 'Files' || h2[1].trim() === '相关文件';
      continue;
    }

    if (!inFilesSection) continue;

    // Parse "- path" or "- `path`"
    const item = line.match(/^-\s+(.+)/);
    if (item) {
      const path = item[1].trim().replace(/^`|`$/g, '');
      if (path) files.push(path);
    }
  }

  return files;
}

/**
 * Match a changed file against a list of SDD file patterns.
 *
 * Supports:
 * - Exact match: "src/foo.ts"
 * - Directory prefix: "src/foo/" matches "src/foo/bar.ts"
 * - Glob star: "src/foo/*.ts" matches "src/foo/bar.ts"
 */
function matchesFilePattern(changedFile: string, pattern: string): boolean {
  // Exact
  if (changedFile === pattern) return true;

  // Directory prefix (pattern ends with /)
  if (pattern.endsWith('/')) {
    return changedFile.startsWith(pattern);
  }

  // Glob star
  if (pattern.includes('*')) {
    const regexStr = pattern
      .replace(/\./g, '\\.')
      .replace(/\*/g, '[^/]*');
    return new RegExp(`^${regexStr}$`).test(changedFile);
  }

  return false;
}

// ── SddFreshnessService ──

export class SddFreshnessService {
  /**
   * Analyze git diff and determine which SDD docs need updating.
   * Returns list of affected SDD slugs with change levels.
   */
  async analyzeChanges(
    changedFiles: string[],
    gitDiff: string,
  ): Promise<SddChangePlan[]> {
    const slugs = await listSddDocs();
    const plans: SddChangePlan[] = [];

    for (const slug of slugs) {
      const doc = await readSddDoc(slug, 'requirement');
      if (!doc) continue;

      const trackedFiles = parseFilesSection(doc.body);
      if (trackedFiles.length === 0) continue;

      // Match changed files against tracked files
      const matchedFiles = changedFiles.filter((cf) =>
        trackedFiles.some((tf) => matchesFilePattern(cf, tf)),
      );

      if (matchedFiles.length === 0) continue;

      const level = classifySddChange(gitDiff, matchedFiles);

      // L1 is skipped — only include L2+
      if (level === 'L1') {
        logger.info(
          `[SddFreshness] ${slug}: L1 (typo/format), skipping`,
        );
        continue;
      }

      plans.push({ slug, level, matchedFiles });
      logger.info(
        `[SddFreshness] ${slug}: ${level}, ${matchedFiles.length} matched files`,
      );
    }

    return plans;
  }

  /**
   * Generate and apply patches for affected SDD docs.
   * Only called for L2+ changes (L1 is skipped by analyzeChanges).
   */
  async applyPatches(
    plans: SddChangePlan[],
    gitDiff: string,
  ): Promise<void> {
    for (const plan of plans) {
      logger.info(
        `[SddFreshness] Patching ${plan.slug} (${plan.level})`,
      );

      const layersToPatch = this.getLayersToPatch(plan.level);

      for (const layer of layersToPatch) {
        await this.patchLayer(plan.slug, layer, gitDiff, plan);
      }

      // Append changelog
      const changelogEntry = [
        `- **Level**: ${plan.level}`,
        `- **Files**: ${plan.matchedFiles.join(', ')}`,
        `- **Layers patched**: ${layersToPatch.join(', ')}`,
      ].join('\n');

      await appendChangelog(plan.slug, changelogEntry);
    }
  }

  /**
   * Determine which SDD layers to patch based on change level.
   */
  private getLayersToPatch(
    level: ChangeLevel,
  ): Array<'requirement' | 'design' | 'task'> {
    switch (level) {
      case 'L2':
        return ['task'];
      case 'L3':
        return ['design', 'task'];
      case 'L4':
        return ['requirement', 'design', 'task'];
      default:
        return [];
    }
  }

  /**
   * Patch a single SDD layer: read current → LLM patch → bump version → write.
   */
  private async patchLayer(
    slug: string,
    layer: 'requirement' | 'design' | 'task',
    gitDiff: string,
    plan: SddChangePlan,
  ): Promise<void> {
    const doc = await readSddDoc(slug, layer);
    if (!doc) {
      logger.warn(
        `[SddFreshness] ${slug}/${layer}.md not found, skipping patch`,
      );
      return;
    }

    // Generate patch (LLM via SystemExecutor；失败时 generatePatch 内部转 append 兜底)
    const patchedBody = await this.generatePatch(
      doc.body,
      layer,
      gitDiff,
      plan,
    );

    // Bump version
    const newMeta = this.bumpVersion(doc.meta, layer, plan.level);

    // Write back
    await writeSddDoc(slug, layer, newMeta, patchedBody);

    logger.info(
      `[SddFreshness] ${slug}/${layer}.md patched → v${newMeta.version}`,
    );
  }

  /**
   * Bump version for the specified layer and update global version.
   * Sets parentId to old id, generates new id.
   */
  private bumpVersion(
    meta: Partial<SddFrontmatter>,
    layer: 'requirement' | 'design' | 'task',
    level: ChangeLevel,
  ): Partial<SddFrontmatter> {
    const now = new Date().toISOString();
    const currentVersion = meta.version ?? 1;

    const layerVersionKey =
      layer === 'requirement'
        ? 'requirementVersion'
        : layer === 'design'
          ? 'designVersion'
          : 'taskVersion';

    return {
      ...meta,
      id: `sdd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      parentId: meta.id,
      version: currentVersion + 1,
      [layerVersionKey]: (meta[layerVersionKey] ?? 1) + 1,
      changeType: level,
      updatedAt: now,
    };
  }

  /**
   * Layer-specific guidance for LLM prompt.
   * Each layer only touches its own sections.
   */
  private getLayerGuidance(layer: 'requirement' | 'design' | 'task'): string {
    switch (layer) {
      case 'requirement':
        return `你负责 requirement.md（What 层）。
只关注以下 section：
- Acceptance Criteria / AC / 验收标准
- Constraints / 约束
- Files / 相关文件
不要修改属于 design 或 task 层的内容（implementationNotes, architectureContext, codePatterns, gotchas, contractTests, testFiles）。`;
      case 'design':
        return `你负责 design.md（How 层）。
只关注以下 section：
- Implementation Notes / 实现说明
- Architecture Context / 架构上下文
- Code Patterns / 代码模式
- Gotchas / 陷阱
不要修改属于 requirement 或 task 层的内容（ACs, constraints, files, contractTests, testFiles）。`;
      case 'task':
        return `你负责 task.md（Verify 层）。
只关注以下 section：
- Contract Tests / 契约测试
- Test Files / 测试文件
不要修改属于 requirement 或 design 层的内容（ACs, constraints, files, implementationNotes, architectureContext, codePatterns, gotchas）。`;
    }
  }

  /**
   * Generate patched content for a layer using LLM.
   *
   * Sends current doc + git diff to LLM, which outputs full updated doc
   * preserving unmodified sections. Each layer only patches its own sections.
   */
  private async generatePatch(
    currentBody: string,
    layer: 'requirement' | 'design' | 'task',
    gitDiff: string,
    plan: SddChangePlan,
  ): Promise<string> {
    // Truncate diff to fit context window
    const truncatedDiff = gitDiff.length > 4000
      ? gitDiff.slice(0, 4000) + '\n... (truncated)'
      : gitDiff;

    const layerGuidance = this.getLayerGuidance(layer);

    const prompt = `你是一个 SDD 文档维护器。

## 你的职责
${layerGuidance}

## 当前 ${layer}.md
${currentBody}

## 代码变更
${truncatedDiff}

## 变更分级
${plan.level}（L1-L4）

## 受影响文件
${plan.matchedFiles.join(', ')}

## 规则
- 只修改受变更影响的 section（见上方职责范围）
- 保留未改动的内容原样
- 输出完整的更新后文档（不是 diff）
- 不要添加 "Code Changes Detected" 之类的临时标记
- 如果变更不影响该层文档内容，原样输出当前文档`;

    // LLM 调用走 SystemExecutor（studio 角色绑定的 CLI）；角色未配置/调用失败 → append 兜底
    let result: string | null = null;
    try {
      result = (await getSystemExecutor().run(prompt, {
        systemPrompt: '你是 SDD 文档维护专家。只输出文档内容，不要解释。',
        timeoutMs: 120_000,
      })).output;
    } catch (error) {
      logger.error('[SddFreshness] LLM call failed', { error: String(error) });
    }

    if (result) {
      logger.info(`[SddFreshness] LLM patch generated for ${layer}, ${result.length} chars`);
      return result;
    }

    // Fallback: append structured change note if LLM unavailable
    logger.warn('[SddFreshness] LLM unavailable, falling back to append mode');
    const changeNote = [
      '',
      `## Code Changes Detected (${plan.level})`,
      '',
      `**Affected files**: ${plan.matchedFiles.join(', ')}`,
      '',
      '**Diff summary**:',
      '```diff',
      truncatedDiff,
      '```',
      '',
      `> Auto-detected by SddFreshnessService. Layer: ${layer}. Review and integrate manually.`,
      '',
    ].join('\n');

    return currentBody + changeNote;
  }
}

// Export singleton
export const sddFreshnessService = new SddFreshnessService();
