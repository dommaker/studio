#!/usr/bin/env tsx
/**
 * Historical Knowledge → SDD Seed Documents
 *
 * SP-004 Step 10: Bootstrap SDD system with historical knowledge grouped by topic.
 *
 * Usage:
 *   npx tsx scripts/extract-historical-sdd.ts --dry-run   # preview only
 *   npx tsx scripts/extract-historical-sdd.ts --execute    # write files
 *
 * Reads knowledge entries from ~/.studio/knowledge/, filters by quality,
 * groups by type, and generates docs/sdd/historical/<type>/requirement.md
 * with CHANGELOG.md per topic.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, basename, resolve } from 'path';
import { homedir } from 'os';
import {
  writeSddDoc,
  appendChangelog,
  parseSddFrontmatter,
  toKebab,
  type SddFrontmatter,
} from '../packages/studio-shared/src/utils/sdd-utils';

// ── CLI Args ──

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const EXECUTE = args.includes('--execute');

if (!DRY_RUN && !EXECUTE) {
  console.error('Usage: npx tsx scripts/extract-historical-sdd.ts [--dry-run | --execute]');
  process.exit(1);
}

// ── Config ──

const KNOWLEDGE_DIR = join(homedir(), '.studio', 'knowledge');
// sdd-utils reads process.env.SDD_DIR lazily at call time; set before use
if (!process.env.SDD_DIR) {
  process.env.SDD_DIR = resolve('docs/sdd');
}
const SDD_DIR = process.env.SDD_DIR;
const MIN_BYTES = 50;

// ── Types ──

interface KnowledgeEntry {
  file: string;           // filename (e.g. "guideline-GUI-096.md")
  type: string;           // from frontmatter or filename prefix
  title: string;
  id: string;
  body: string;
  tags: string[];
  created: string;
}

interface TopicGroup {
  topic: string;          // e.g. "guideline"
  entries: KnowledgeEntry[];
}

// ── Helpers ──

/**
 * Extract type from filename prefix (before first `-` or `_`).
 * e.g. "guideline-GUI-096.md" → "guideline"
 *      "architecture-complete_the_pattern.md" → "architecture"
 */
function typeFromFilename(file: string): string {
  const match = basename(file, '.md').match(/^([a-z]+)[-_]/);
  return match ? match[1] : 'misc';
}

/**
 * Generate a simple cuid-like ID (timestamp + random).
 */
function genId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).substring(2, 8);
  return `h${ts}${rand}`;
}

/**
 * Read and parse a single knowledge entry.
 * Returns null if file fails quality filter.
 */
function readEntry(filePath: string): KnowledgeEntry | null {
  const stat = statSync(filePath);
  if (stat.size < MIN_BYTES) return null;

  const raw = readFileSync(filePath, 'utf-8');

  // Check first line for [DEPRECATED]
  const firstLine = raw.split('\n')[0]?.trim() ?? '';
  if (firstLine.includes('[DEPRECATED]')) return null;

  const parsed = parseSddFrontmatter(raw);
  const file = basename(filePath);
  const meta = parsed?.meta ?? {};
  const body = parsed?.body ?? raw;

  // Check for stale tag in frontmatter
  const tags: string[] = Array.isArray(meta.tags) ? meta.tags : [];
  if (tags.includes('stale')) return null;

  const type = (meta.type as string) || typeFromFilename(file);
  const title = (meta.title as string) || basename(file, '.md');
  const id = (meta.id as string) || basename(file, '.md');
  const created = (meta.createdAt as string) || (meta.created as string) || '';

  return { file, type, title, id, body, tags, created };
}

/**
 * Scan knowledge directory for .md files (non-recursive, skip .archive).
 */
function scanKnowledgeDir(): string[] {
  if (!existsSync(KNOWLEDGE_DIR)) {
    console.error(`Knowledge directory not found: ${KNOWLEDGE_DIR}`);
    process.exit(1);
  }

  const files: string[] = [];
  for (const entry of readdirSync(KNOWLEDGE_DIR, { withFileTypes: true })) {
    // Skip hidden dirs and .archive
    if (entry.isDirectory()) continue;
    if (!entry.name.endsWith('.md')) continue;
    files.push(join(KNOWLEDGE_DIR, entry.name));
  }
  return files;
}

/**
 * Group entries by type.
 */
function groupByType(entries: KnowledgeEntry[]): TopicGroup[] {
  const map = new Map<string, KnowledgeEntry[]>();
  for (const entry of entries) {
    const group = map.get(entry.type) ?? [];
    group.push(entry);
    map.set(entry.type, group);
  }

  return Array.from(map.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([topic, group]) => ({
      topic,
      entries: group.sort((x, y) => x.title.localeCompare(y.title)),
    }));
}

/**
 * Build SDD requirement body for a topic group.
 */
function buildRequirementBody(group: TopicGroup): string {
  const lines: string[] = [];

  lines.push(`# Historical Knowledge: ${group.topic}`);
  lines.push('');
  lines.push(`Auto-generated from ${group.entries.length} knowledge entries.`);
  lines.push(`Source: \`~/.studio/knowledge/\``);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push(`This document aggregates historical ${group.topic} knowledge entries`);
  lines.push('extracted from the knowledge store. Each entry is preserved as a subsection');
  lines.push('for reference and future SDD evolution.');
  lines.push('');

  // Table of contents
  lines.push('## Entries');
  lines.push('');
  for (const entry of group.entries) {
    const anchor = toKebab(entry.title);
    lines.push(`- [${entry.title}](#${anchor}) (${entry.id})`);
  }
  lines.push('');

  // Each entry as subsection
  for (const entry of group.entries) {
    lines.push(`## ${entry.title}`);
    lines.push('');
    lines.push(`- **ID**: \`${entry.id}\``);
    lines.push(`- **Source**: \`${entry.file}\``);
    if (entry.tags.length > 0) {
      lines.push(`- **Tags**: ${entry.tags.join(', ')}`);
    }
    if (entry.created) {
      lines.push(`- **Created**: ${entry.created}`);
    }
    lines.push('');
    // Trim body to avoid bloating — take first 500 chars as summary
    const summary = entry.body.length > 500
      ? entry.body.substring(0, 500) + '\n\n> ... (truncated)'
      : entry.body;
    lines.push(summary);
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Build frontmatter for a topic group's requirement doc.
 */
function buildFrontmatter(group: TopicGroup): Partial<SddFrontmatter> {
  const now = new Date().toISOString();
  return {
    id: genId(),
    slug: `historical-${group.topic}`,
    title: `Historical Knowledge: ${group.topic}`,
    status: 'done',
    tier: 'fast',
    version: 1,
    requirementVersion: 1,
    designVersion: 0,
    taskVersion: 0,
    tags: [group.topic, 'historical', `entries:${group.entries.length}`],
    createdAt: now,
    updatedAt: now,
  };
}

// ── Main ──

async function main(): Promise<void> {
  console.log(`\n=== Historical Knowledge → SDD Seed ===`);
  console.log(`Mode: ${DRY_RUN ? 'DRY RUN' : 'EXECUTE'}`);
  console.log(`Knowledge dir: ${KNOWLEDGE_DIR}`);
  console.log(`SDD dir: ${SDD_DIR}\n`);

  // 1. Scan
  const files = scanKnowledgeDir();
  console.log(`Found ${files.length} knowledge files.`);

  // 2. Read + filter
  const entries: KnowledgeEntry[] = [];
  let skipped = 0;
  for (const f of files) {
    const entry = readEntry(f);
    if (entry) {
      entries.push(entry);
    } else {
      skipped++;
    }
  }
  console.log(`Quality filter: ${entries.length} passed, ${skipped} skipped.\n`);

  // 3. Group
  const groups = groupByType(entries);
  console.log(`Topic groups (${groups.length}):`);
  for (const g of groups) {
    console.log(`  ${g.topic}: ${g.entries.length} entries`);
  }

  // 4. Generate
  if (DRY_RUN) {
    console.log('\n[DRY RUN] Would generate:');
    for (const g of groups) {
      const slug = `historical-${g.topic}`;
      console.log(`  docs/sdd/${slug}/requirement.md`);
      console.log(`  docs/sdd/${slug}/CHANGELOG.md`);
    }
    console.log(`\nTotal: ${groups.length} topic docs, ${entries.length} entries.`);
    return;
  }

  // Execute mode
  console.log('\nGenerating SDD docs...');
  for (const group of groups) {
    const slug = `historical-${group.topic}`;
    const fm = buildFrontmatter(group);
    const body = buildRequirementBody(group);

    await writeSddDoc(slug, 'requirement', fm, body);
    console.log(`  [OK] ${slug}/requirement.md (${group.entries.length} entries)`);

    await appendChangelog(slug, `Initial seed: ${group.entries.length} historical ${group.topic} entries extracted from knowledge store.`);
    console.log(`  [OK] ${slug}/CHANGELOG.md`);
  }

  console.log(`\nDone. ${groups.length} topic docs generated in ${SDD_DIR}/historical-*/`);
}

main();
