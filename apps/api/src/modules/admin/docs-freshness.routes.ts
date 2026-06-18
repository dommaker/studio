/**
 * T-020 + T-059: CLAUDE.md + CAPABILITIES.md Freshness Check
 *
 * GET /api/v1/admin/docs-freshness — checks both CLAUDE.md staleness
 * and CAPABILITIES.md sync via harness's checkDocsFreshness.
 */

import { Router, Request, Response } from 'express';
import { readFile, stat } from 'fs/promises';
import { join } from 'path';
import { logger } from '@dommaker/studio-shared';
import { checkConstraints } from '@dommaker/harness';

const router = Router();

const PROJECT_ROOT = process.cwd();
const CLAUDE_MD = join(PROJECT_ROOT, 'CLAUDE.md');

interface FreshnessResult {
  status: 'fresh' | 'stale' | 'missing';
  claudeLastModified?: string;
  daysSinceUpdate?: number;
  recentChanges: Array<{ file: string; modified: string }>;
  sections: Array<{ section: string; status: 'ok' | 'stale' | 'missing'; detail: string }>;
  recommendations: string[];
  /** T-059: harness checkDocsFreshness result */
  harnessCheck?: {
    passed: boolean;
    details: Array<{ id: string; passed: boolean; message: string }>;
  };
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    const result = await checkDocsFreshness();

    // T-059: run harness checkDocsFreshness (checks CAPABILITIES.md sync)
    try {
      const harnessResult = await checkConstraints(
        { operation: 'module_modification', projectPath: PROJECT_ROOT },
      );
      const relevantIds = ['docs_freshness', 'capability_sync'];
      const relevantResults = [
        ...harnessResult.guidelines,
        ...harnessResult.ironLaws,
      ].filter(r => relevantIds.includes(r.id));

      result.harnessCheck = {
        passed: relevantResults.every(r => r.satisfied),
        details: relevantResults.map(r => ({ id: r.id, passed: r.satisfied, message: r.message })),
      };
    } catch {
      logger.warn('Harness docs freshness check unavailable');
    }

    res.json(result);
  } catch (error) {
    logger.error('Docs freshness check failed', { error: String(error) });
    res.status(500).json({ error: 'Freshness check failed' });
  }
});

async function checkDocsFreshness(): Promise<FreshnessResult> {
  const recommendations: string[] = [];
  const sections: FreshnessResult['sections'] = [];

  // Check if CLAUDE.md exists
  let claudeStat;
  try {
    claudeStat = await stat(CLAUDE_MD);
  } catch {
    return {
      status: 'missing',
      recentChanges: [],
      sections: [{ section: 'CLAUDE.md', status: 'missing', detail: 'File not found' }],
      recommendations: ['Create CLAUDE.md with project overview, commands, and architecture'],
    };
  }

  const now = Date.now();
  const daysSinceUpdate = Math.floor((now - claudeStat.mtimeMs) / 86400_000);

  // Read CLAUDE.md content
  const content = await readFile(CLAUDE_MD, 'utf-8');

  // Check Domain Packages section
  const hasDomainPackages = content.includes('## Domain Packages') || content.includes('Domain Packages');
  sections.push({
    section: 'Domain Packages',
    status: hasDomainPackages ? 'ok' : 'missing',
    detail: hasDomainPackages ? 'Section present' : 'Missing — add packages/studio-* list',
  });

  // Check Key Architecture Paths section
  const hasArchPaths = content.includes('Key Architecture Paths') || content.includes('Architecture Paths');
  sections.push({
    section: 'Key Architecture Paths',
    status: hasArchPaths ? 'ok' : 'missing',
    detail: hasArchPaths ? 'Section present' : 'Missing — add critical file paths',
  });

  // Check if packages listed in CLAUDE.md actually exist
  const packageMatches = content.match(/packages\/studio-[\w-]+/g) || [];
  const uniquePackages = [...new Set(packageMatches)];
  let missingPackages = 0;
  for (const pkg of uniquePackages) {
    try {
      await stat(join(PROJECT_ROOT, pkg));
    } catch {
      missingPackages++;
      recommendations.push(`Package ${pkg} referenced in CLAUDE.md but not found on disk`);
    }
  }
  sections.push({
    section: 'Package References',
    status: missingPackages === 0 ? 'ok' : 'stale',
    detail: `${uniquePackages.length} packages referenced, ${missingPackages} missing`,
  });

  // Check if Key Architecture Paths point to real files
  const pathMatch = content.match(/\|.*?\|\s*`([^`]+)`/g) || [];
  let brokenPaths = 0;
  for (const line of pathMatch.slice(0, 20)) { // check first 20
    const pathMatch2 = line.match(/`([^`]+)`/);
    if (pathMatch2?.[1]) {
      const filePath = pathMatch2[1].split(' ')[0]; // remove comments after path
      try {
        await stat(join(PROJECT_ROOT, filePath));
      } catch {
        brokenPaths++;
      }
    }
  }
  if (brokenPaths > 0) {
    sections.push({
      section: 'Path References',
      status: 'stale',
      detail: `${brokenPaths} paths may be broken`,
    });
    recommendations.push('Update broken file paths in Key Architecture Paths table');
  } else {
    sections.push({
      section: 'Path References',
      status: 'ok',
      detail: 'All checked paths exist',
    });
  }

  // Overall status
  const hasStale = sections.some(s => s.status === 'stale' || s.status === 'missing');
  const status = daysSinceUpdate > 14 || hasStale ? 'stale' : 'fresh';

  if (daysSinceUpdate > 14) {
    recommendations.push(`CLAUDE.md hasn't been updated in ${daysSinceUpdate} days — review for accuracy`);
  }

  return {
    status,
    claudeLastModified: claudeStat.mtime.toISOString(),
    daysSinceUpdate,
    recentChanges: [], // would need git log for this
    sections,
    recommendations,
  };
}

export default router;
