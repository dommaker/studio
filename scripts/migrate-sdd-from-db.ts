#!/usr/bin/env tsx
/**
 * [DEPRECATED] SP-004 Step 7a: RequirementsDoc DB → docs/sdd/<slug>/requirement.md 迁移
 *
 * RequirementsDoc model 已从 Prisma schema 删除。此脚本保留为历史参考。
 * 迁移已于 SP-004 完成，SDD 文件已全部写入 docs/sdd/ 目录。
 * 如需重新生成，请改为从 filesystem 读取 docs/sdd/**/requirement.md。
 */

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  writeSddDoc,
  stringifySddFrontmatter,
  toKebab,
  parseSddFrontmatter,
  type SddFrontmatter,
} from '../packages/studio-shared/src/utils/sdd-utils.js';

// ── Args ──

const DRY_RUN = process.argv.includes('--dry-run');
const EXECUTE = process.argv.includes('--execute');

if (!DRY_RUN && !EXECUTE) {
  console.error('用法: npx tsx scripts/migrate-sdd-from-db.ts [--dry-run | --execute]');
  process.exit(1);
}

console.error('[DEPRECATED] RequirementsDoc model 已从 Prisma schema 删除。迁移已完成。');
process.exit(0);

// ── Helpers ──

function getExistingGoalId(dirPath: string): string | null {
  const reqPath = join(dirPath, 'requirement.md');
  if (!existsSync(reqPath)) return null;
  const content = readFileSync(reqPath, 'utf-8');
  const parsed = parseSddFrontmatter(content);
  return (parsed?.meta.goalId as string) ?? null;
}

function resolveSlug(baseSlug: string, goalId: string | null, sddDir: string): string {
  const dirPath = join(sddDir, baseSlug);

  if (!existsSync(dirPath)) return baseSlug;

  // dir exists — check if frontmatter.goalId matches
  const existingGoalId = getExistingGoalId(dirPath);

  if (existingGoalId === goalId) return baseSlug;  // same doc, reuse slug

  // conflict: append last 4 chars of goalId (or "xxxx" if no goalId)
  const suffix = goalId ? goalId.slice(-4) : 'xxxx';
  return `${baseSlug}-${suffix}`;
}

// ── Main ──

async function main() {
  const sddDir = process.env.SDD_DIR || 'docs/sdd';
  console.log(`SDD dir: ${sddDir}`);
  console.log(`Mode: ${DRY_RUN ? 'dry-run' : 'execute'}`);

  const docs = await prisma.requirementsDoc.findMany({
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Found ${docs.length} RequirementsDoc rows\n`);

  let written = 0;
  let skipped = 0;
  const usedSlugs = new Set<string>();

  for (const doc of docs) {
    const baseSlug = toKebab(doc.title);

    // Resolve slug: base + conflict check against filesystem + already-seen slugs in this run
    let slug = resolveSlug(baseSlug, doc.goalId, sddDir);

    // Also check slugs assigned in this run (batch conflict)
    if (usedSlugs.has(slug)) {
      const suffix = doc.goalId ? doc.goalId.slice(-4) : 'xxxx';
      slug = `${baseSlug}-${suffix}`;
      // If still conflicts (extremely unlikely), append doc id suffix
      if (usedSlugs.has(slug)) {
        slug = `${baseSlug}-${doc.id.slice(-6)}`;
      }
    }

    usedSlugs.add(slug);

    // Parse JSON fields
    let tags: string[] = [];
    try { tags = JSON.parse(doc.tags); } catch { /* keep [] */ }

    let acGroups: unknown[] = [];
    if (doc.acGroups) {
      try { acGroups = JSON.parse(doc.acGroups); } catch { /* keep [] */ }
    }

    let contractTests: unknown[] = [];
    if (doc.contractTests) {
      try { contractTests = JSON.parse(doc.contractTests); } catch { /* keep [] */ }
    }

    // Frontmatter
    const frontmatter: Partial<SddFrontmatter> = {
      id: doc.id,
      goalId: doc.goalId ?? undefined,
      slug,
      title: doc.title,
      status: (doc.status as SddFrontmatter['status']) ?? 'draft',
      version: 1,
      sourceChannelId: doc.sourceChannelId,
      tags,
      createdAt: doc.createdAt.toISOString(),
      updatedAt: doc.updatedAt.toISOString(),
    };

    // Body
    let body = doc.content ?? '';
    if (acGroups.length > 0) {
      body += `\n\n## AC Groups\n\n\`\`\`json\n${JSON.stringify(acGroups, null, 2)}\n\`\`\``;
    }
    if (contractTests.length > 0) {
      body += `\n\n## Contract Tests\n\n\`\`\`json\n${JSON.stringify(contractTests, null, 2)}\n\`\`\``;
    }

    if (DRY_RUN) {
      console.log(`[dry-run] ${slug}/requirement.md  (title="${doc.title}", id=${doc.id})`);
      written++;
    } else {
      await writeSddDoc(slug, 'requirement', frontmatter, body);
      console.log(`[wrote] ${slug}/requirement.md`);
      written++;
    }
  }

  console.log(`\n${DRY_RUN ? 'Would write' : 'Wrote'}: ${written}`);
  console.log(`Skipped: ${skipped}`);

  // Verify count (only in execute mode)
  if (EXECUTE) {
    const { readdirSync } = await import('fs');
    const dirs = readdirSync(sddDir, { withFileTypes: true }).filter(d => d.isDirectory());
    console.log(`SDD dirs on disk: ${dirs.length}`);
    if (dirs.length !== docs.length) {
      console.warn(`⚠ Count mismatch: DB=${docs.length}, disk=${dirs.length}`);
      console.warn('  (expected if slug conflicts caused suffixing)');
    }
  }
}

main()
  .catch((e) => {
    console.error('Migration failed:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
