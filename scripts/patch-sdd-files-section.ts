#!/usr/bin/env npx tsx
/**
 * Patch SDD requirement.md files: extract `files` arrays from AC Groups JSON
 * and append a `## Files` section at the end of the body.
 *
 * Usage:
 *   npx tsx scripts/patch-sdd-files-section.ts --dry-run
 *   npx tsx scripts/patch-sdd-files-section.ts --execute
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { parseSddFrontmatter, stringifySddFrontmatter } from '../packages/studio-shared/src/utils/sdd-utils';

// ── Helpers ──

/**
 * Extract all file paths from AC Groups JSON code blocks in the body.
 * Handles both ```json ... ``` blocks after `## AC Groups` sections.
 */
export function extractFilesFromAcGroups(body: string): string[] {
  const files: string[] = [];
  const lines = body.split('\n');

  let inAcGroupsSection = false;
  let inCodeBlock = false;
  let jsonBuffer: string[] = [];

  for (const line of lines) {
    // Track H2 sections
    const h2 = line.match(/^##\s+(.+)/);
    if (h2) {
      // If entering a new H2, flush any pending JSON
      if (inCodeBlock && jsonBuffer.length > 0) {
        files.push(...parseFilesFromJson(jsonBuffer.join('\n')));
        jsonBuffer = [];
        inCodeBlock = false;
      }
      inAcGroupsSection = h2[1].trim() === 'AC Groups';
      continue;
    }

    if (!inAcGroupsSection) continue;

    // Track code fences
    if (/^```json\s*$/.test(line)) {
      inCodeBlock = true;
      jsonBuffer = [];
      continue;
    }
    if (/^```\s*$/.test(line) && inCodeBlock) {
      // End of code block — parse accumulated JSON
      if (jsonBuffer.length > 0) {
        files.push(...parseFilesFromJson(jsonBuffer.join('\n')));
      }
      jsonBuffer = [];
      inCodeBlock = false;
      continue;
    }

    if (inCodeBlock) {
      jsonBuffer.push(line);
    }
  }

  // Flush if still in code block at end
  if (inCodeBlock && jsonBuffer.length > 0) {
    files.push(...parseFilesFromJson(jsonBuffer.join('\n')));
  }

  return files;
}

/**
 * Parse files array from AC Groups JSON string.
 */
export function parseFilesFromJson(jsonStr: string): string[] {
  try {
    const groups = JSON.parse(jsonStr);
    if (!Array.isArray(groups)) return [];

    const files: string[] = [];
    for (const group of groups) {
      if (!group.files || !Array.isArray(group.files)) continue;
      for (const fp of group.files) {
        if (typeof fp !== 'string' || !fp.trim()) continue;
        // Strip line ranges like file.ts:L128-L143
        const clean = fp.replace(/:L\d+(-L\d+)?$/, '').trim();
        if (clean) files.push(clean);
      }
    }
    return files;
  } catch {
    return [];
  }
}

/**
 * Check if body already has a ## Files or ## 相关文件 section.
 */
export function hasFilesSection(body: string): boolean {
  return /^## (Files|相关文件)\s*$/m.test(body);
}

/**
 * Build the ## Files section markdown.
 */
export function buildFilesSection(files: string[]): string {
  const unique = [...new Set(files)].sort();
  const lines = unique.map(f => `- ${f}`);
  return `\n## Files\n\n${lines.join('\n')}\n`;
}

// ── Main ──

interface PatchResult {
  slug: string;
  fileCount: number;
  skipped: boolean;
  reason?: string;
}

function listSddSlugs(baseDir: string): string[] {
  if (!existsSync(baseDir)) return [];
  return readdirSync(baseDir, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name);
}

function patchDoc(baseDir: string, slug: string, dryRun: boolean): PatchResult {
  const filePath = join(baseDir, slug, 'requirement.md');
  if (!existsSync(filePath)) {
    return { slug, fileCount: 0, skipped: true, reason: 'no requirement.md' };
  }

  const content = readFileSync(filePath, 'utf-8');
  const parsed = parseSddFrontmatter(content);
  if (!parsed) {
    return { slug, fileCount: 0, skipped: true, reason: 'no frontmatter' };
  }

  const { meta, body } = parsed;

  // Check if already has Files section
  if (hasFilesSection(body)) {
    return { slug, fileCount: 0, skipped: true, reason: 'already has ## Files' };
  }

  // Extract files from AC Groups JSON
  const files = extractFilesFromAcGroups(body);
  if (files.length === 0) {
    return { slug, fileCount: 0, skipped: true, reason: 'no files in AC Groups' };
  }

  const unique = [...new Set(files)].sort();

  if (!dryRun) {
    const newBody = body + buildFilesSection(files);
    const newContent = `${stringifySddFrontmatter(meta)}\n\n${newBody}`;
    writeFileSync(filePath, newContent, 'utf-8');
  }

  return { slug, fileCount: unique.length, skipped: false };
}

// ── CLI ──

const isMainModule = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('patch-sdd-files-section.ts');

if (isMainModule) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const execute = args.includes('--execute');

  if (!dryRun && !execute) {
    console.error('Usage: npx tsx scripts/patch-sdd-files-section.ts [--dry-run | --execute]');
    process.exit(1);
  }

  const baseDir = join(process.cwd(), 'docs/sdd');
  const slugs = listSddSlugs(baseDir);

  console.log(`Scanning ${slugs.length} SDD docs in ${baseDir}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'EXECUTE'}\n`);

  const results: PatchResult[] = [];
  for (const slug of slugs) {
    results.push(patchDoc(baseDir, slug, dryRun));
  }

  // Summary
  const patched = results.filter(r => !r.skipped);
  const skipped = results.filter(r => r.skipped);

  console.log(`\n=== Summary ===`);
  console.log(`Patched: ${patched.length}`);
  console.log(`Skipped: ${skipped.length}`);

  if (patched.length > 0) {
    console.log(`\nPatched docs:`);
    for (const r of patched) {
      console.log(`  ${r.slug} (${r.fileCount} files)`);
    }
  }

  if (skipped.length > 0) {
    console.log(`\nSkipped docs:`);
    for (const r of skipped) {
      console.log(`  ${r.slug} — ${r.reason}`);
    }
  }
}
