#!/usr/bin/env npx tsx
/**
 * patch-sdd-changelog.ts — SP-004 Step 7 辅助脚本
 *
 * 为从 DB 迁移的 SDD 文档生成初始 CHANGELOG.md。
 * 跳过 historical-* 目录（已有 CHANGELOG）。
 *
 * Usage:
 *   npx tsx scripts/patch-sdd-changelog.ts --dry-run
 *   npx tsx scripts/patch-sdd-changelog.ts --execute
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { readSddDoc, listSddDocs, appendChangelog } from '../packages/studio-shared/src/utils/sdd-utils';

interface PatchResult {
  slug: string;
  action: 'created' | 'skipped-exists' | 'skipped-historical' | 'skipped-no-requirement' | 'skipped-no-frontmatter';
}

function buildEntry(meta: { status?: string; sourceChannelId?: string; createdAt?: string }): string {
  const lines: string[] = [
    `Migrated from RequirementsDoc DB table (SP-004 Step 7).`,
    `- **Status**: ${meta.status ?? 'unknown'}`,
    `- **Source**: ${meta.sourceChannelId ?? 'N/A'}`,
  ];
  if (meta.createdAt) {
    lines.unshift(`Original createdAt: ${meta.createdAt}`);
  }
  return lines.join('\n');
}

export async function patchSddChangelogs(dryRun: boolean, sddDir?: string): Promise<PatchResult[]> {
  const baseDir = sddDir || process.env.SDD_DIR || 'docs/sdd';
  const slugs = await listSddDocs();
  const results: PatchResult[] = [];

  for (const slug of slugs) {
    // Skip historical dirs
    if (slug.startsWith('historical-')) {
      results.push({ slug, action: 'skipped-historical' });
      continue;
    }

    const changelogPath = join(baseDir, slug, 'CHANGELOG.md');

    // Skip if CHANGELOG already exists
    if (existsSync(changelogPath)) {
      results.push({ slug, action: 'skipped-exists' });
      continue;
    }

    // Read requirement frontmatter
    const doc = await readSddDoc(slug, 'requirement');
    if (!doc) {
      results.push({ slug, action: 'skipped-no-requirement' });
      continue;
    }
    if (!doc.meta.createdAt) {
      results.push({ slug, action: 'skipped-no-frontmatter' });
      continue;
    }

    const entry = buildEntry({
      status: doc.meta.status,
      sourceChannelId: doc.meta.sourceChannelId,
      createdAt: doc.meta.createdAt,
    });

    if (!dryRun) {
      await appendChangelog(slug, entry);
    }

    results.push({ slug, action: 'created' });
  }

  return results;
}

// CLI (guarded — skip when imported by tests)
const isDirectRun = process.argv[1]?.includes('patch-sdd-changelog');

if (isDirectRun) {
  void (async () => {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const execute = args.includes('--execute');

  if (!dryRun && !execute) {
    console.error('Usage: npx tsx scripts/patch-sdd-changelog.ts [--dry-run | --execute]');
    process.exit(1);
  }

  const results = await patchSddChangelogs(dryRun);

  const created = results.filter(r => r.action === 'created');
  const skipped = results.filter(r => r.action !== 'created');

  console.log(`\nMode: ${dryRun ? 'DRY RUN' : 'EXECUTE'}`);
  console.log(`Total slugs: ${results.length}`);
  console.log(`To create: ${created.length}`);
  console.log(`Skipped: ${skipped.length}`);

  if (created.length > 0) {
    console.log(`\nCreated CHANGELOG for:`);
    for (const r of created) {
      console.log(`  ${r.slug}`);
    }
  }

  if (skipped.length > 0) {
    const byReason = new Map<string, string[]>();
    for (const r of skipped) {
      const list = byReason.get(r.action) || [];
      list.push(r.slug);
      byReason.set(r.action, list);
    }
    console.log(`\nSkipped:`);
    for (const [reason, slugs] of byReason) {
      console.log(`  ${reason}: ${slugs.length}`);
    }
  }
  })();
}
