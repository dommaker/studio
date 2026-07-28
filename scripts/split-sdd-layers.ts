#!/usr/bin/env npx tsx
/**
 * Split SDD requirement.md into three-layer files:
 *   requirement.md — requirements (ACs, constraints, files)
 *   design.md      — design (implementation notes, patterns, gotchas, arch context)
 *   task.md        — tasks (contract tests)
 *
 * Usage:
 *   npx tsx scripts/split-sdd-layers.ts --dry-run
 *   npx tsx scripts/split-sdd-layers.ts --execute
 */

import { existsSync, readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import {
  parseSddFrontmatter,
  writeSddDoc,
  type SddFrontmatter,
} from '../packages/studio-shared/src/utils/sdd-utils';

// ── Types ──

interface AcGroupDesignData {
  id: string;
  implementationNotes: string;
  codePatterns: string[];
  gotchas: string[];
  architectureContext: Record<string, unknown> | null;
}

interface SplitResult {
  slug: string;
  skipped: boolean;
  reason?: string;
  designGroups: number;
  hasContractTests: boolean;
  requirementLinesBefore: number;
  requirementLinesAfter: number;
}

// ── Section Parsing ──

interface H2Section {
  title: string;
  startLine: number; // index of the ## line
  content: string;   // lines after the ## line until next ## or EOF
}

interface H2SplitResult {
  preamble: string;   // content before first H2 (title, description, TASK_TIER comment)
  sections: H2Section[];
}

/**
 * Split body into preamble (before first H2) and H2 sections.
 */
function splitH2Sections(body: string): H2Section[] {
  return splitH2WithPreamble(body).sections;
}

function splitH2WithPreamble(body: string): H2SplitResult {
  const lines = body.split('\n');
  const sections: H2Section[] = [];
  let preamble: string | null = null;
  let currentTitle: string | null = null;
  let currentStart = 0;
  let currentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const h2Match = lines[i].match(/^##\s+(.+)/);
    if (h2Match) {
      // Capture preamble (content before first H2)
      if (preamble === null && currentTitle === null) {
        preamble = currentLines.join('\n').trim();
      }
      // Flush previous section
      if (currentTitle !== null) {
        sections.push({
          title: currentTitle,
          startLine: currentStart,
          content: currentLines.join('\n'),
        });
      }
      currentTitle = h2Match[1].trim();
      currentStart = i;
      currentLines = [];
    } else {
      currentLines.push(lines[i]);
    }
  }
  // Flush last section
  if (currentTitle !== null) {
    sections.push({
      title: currentTitle,
      startLine: currentStart,
      content: currentLines.join('\n'),
    });
  } else if (preamble === null) {
    // No H2 at all — everything is preamble
    preamble = body.trim();
  }

  return { preamble: preamble || '', sections };
}

/**
 * Extract JSON from first ```json ... ``` code block in text.
 */
function extractJsonCodeBlock(text: string): string | null {
  const match = text.match(/```json\s*\n([\s\S]*?)\n```/);
  return match ? match[1].trim() : null;
}

// ── AC Groups JSON Parsing (design data) ──

function extractDesignDataFromJson(jsonStr: string): AcGroupDesignData[] {
  try {
    const groups = JSON.parse(jsonStr);
    if (!Array.isArray(groups)) return [];

    return groups.map((g: Record<string, unknown>) => ({
      id: String(g.id || 'unknown'),
      implementationNotes: String(g.implementationNotes || ''),
      codePatterns: Array.isArray(g.codePatterns) ? g.codePatterns.map(String) : [],
      gotchas: Array.isArray(g.gotchas) ? g.gotchas.map(String) : [],
      architectureContext:
        g.architectureContext && typeof g.architectureContext === 'object'
          ? g.architectureContext as Record<string, unknown>
          : null,
    }));
  } catch {
    return [];
  }
}

// ── Contract Tests Parsing ──

interface ContractTest {
  file: string;
  content: string;
}

function extractContractTestsFromJson(jsonStr: string): ContractTest[] {
  try {
    const tests = JSON.parse(jsonStr);
    if (!Array.isArray(tests)) return [];
    return tests
      .filter((t: Record<string, unknown>) => typeof t.file === 'string' && typeof t.content === 'string')
      .map((t: Record<string, unknown>) => ({ file: t.file as string, content: t.content as string }));
  } catch {
    return [];
  }
}

// ── Architecture Context Formatting ──

function formatArchitectureContext(ctx: Record<string, unknown>): string {
  const parts: string[] = [];

  const functions = ctx.functions;
  if (Array.isArray(functions) && functions.length > 0) {
    parts.push('**Functions**');
    for (const fn of functions) parts.push(`- ${fn}`);
    parts.push('');
  }

  const callChain = ctx.callChain;
  if (typeof callChain === 'string' && callChain) {
    parts.push('**Call Chain**');
    parts.push(callChain);
    parts.push('');
  }

  const imports = ctx.imports;
  if (Array.isArray(imports) && imports.length > 0) {
    parts.push('**Imports**');
    for (const imp of imports) parts.push(`- ${imp}`);
    parts.push('');
  }

  const typesInScope = ctx.typesInScope;
  if (Array.isArray(typesInScope) && typesInScope.length > 0) {
    parts.push('**Types in Scope**');
    for (const t of typesInScope) parts.push(`- ${t}`);
    parts.push('');
  }

  const testMock = ctx.testMock;
  if (Array.isArray(testMock) && testMock.length > 0) {
    parts.push('**Test Mocks**');
    for (const m of testMock) parts.push(`- ${m}`);
    parts.push('');
  }

  const dangerZones = ctx.dangerZones;
  if (Array.isArray(dangerZones) && dangerZones.length > 0) {
    parts.push('**Danger Zones**');
    for (const d of dangerZones) parts.push(`- ${d}`);
    parts.push('');
  }

  return parts.join('\n').trim();
}

// ── Contract Tests Formatting ──

function formatContractTestsForTask(tests: ContractTest[], preamble?: string): string {
  if (tests.length === 0) return '';

  const parts: string[] = [];
  if (preamble) {
    parts.push(preamble, '');
  }
  parts.push('## Contract Tests', '');
  for (const test of tests) {
    parts.push(`### ${test.file}`);
    parts.push('```typescript');
    parts.push(test.content);
    parts.push('```');
    parts.push('');
  }
  return parts.join('\n').trimEnd();
}

// ── Design.md Body Builder ──

function buildDesignBody(groups: AcGroupDesignData[], preamble?: string): string {
  // Filter groups that have at least some design content
  const groupsWithContent = groups.filter(
    g => g.implementationNotes || g.codePatterns.length > 0 || g.gotchas.length > 0 || g.architectureContext
  );

  if (groupsWithContent.length === 0) return '';

  const parts: string[] = [];
  if (preamble) {
    parts.push(preamble, '');
  }

  // Architecture Context section (aggregate from all groups)
  const groupsWithArch = groupsWithContent.filter(g => g.architectureContext);
  if (groupsWithArch.length > 0) {
    parts.push('## Architecture Context');
    parts.push('');
    for (const group of groupsWithArch) {
      if (groupsWithArch.length > 1) {
        parts.push(`### ${group.id}`);
        parts.push('');
      }
      parts.push(formatArchitectureContext(group.architectureContext!));
      parts.push('');
    }
  }

  // AC Groups design details
  parts.push('## AC Groups');
  parts.push('');

  for (const group of groupsWithContent) {
    parts.push(`### ${group.id}`);
    parts.push('');

    if (group.implementationNotes) {
      parts.push('#### 实现指南');
      parts.push(group.implementationNotes);
      parts.push('');
    }

    if (group.codePatterns.length > 0) {
      parts.push('#### 参考模式');
      for (const pattern of group.codePatterns) {
        parts.push(`- ${pattern}`);
      }
      parts.push('');
    }

    if (group.gotchas.length > 0) {
      parts.push('#### ⚠️ 注意事项');
      for (const gotcha of group.gotchas) {
        parts.push(`- ${gotcha}`);
      }
      parts.push('');
    }
  }

  return parts.join('\n').trimEnd();
}

// ── Requirement.md Body Rebuilder ──

function rebuildRequirementBody(
  preamble: string,
  sections: H2Section[],
  acGroupsJsonSection: H2Section | null,
  contractTestsSection: H2Section | null
): string {
  // Rebuild body excluding:
  // - Design-layer content from the first AC Groups markdown section
  // - Contract Tests section
  // Keep:
  // - Preamble (title, description, TASK_TIER)
  // - Schema First Verification
  // - First AC Groups section (markdown, with design content stripped)
  // - 约束
  // - Second AC Groups section (JSON)
  // - Files

  const parts: string[] = [];

  if (preamble) {
    parts.push(preamble);
  }

  for (const section of sections) {
    // Skip Contract Tests — moved to task.md
    if (section.title.includes('Contract Tests') || section.title.includes('契约测试')) {
      continue;
    }

    // For the first AC Groups section (markdown), strip design subsections
    if (section.title === 'AC Groups' && section === acGroupsJsonSection) {
      // This is the JSON AC Groups section — keep as-is
      parts.push(`## ${section.title}`);
      parts.push(section.content);
      continue;
    }

    if (section.title === 'AC Groups' && section !== acGroupsJsonSection) {
      // This is the markdown AC Groups section — strip design subsections
      const stripped = stripDesignSubsections(section.content);
      parts.push(`## ${section.title}`);
      parts.push(stripped);
      continue;
    }

    // All other sections — keep as-is
    parts.push(`## ${section.title}`);
    parts.push(section.content);
  }

  return parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Strip design-layer H4 subsections from markdown AC Groups content.
 * Removes: #### 实现指南, #### 参考模式, #### ⚠️ 注意事项
 * Keeps: #### 验收标准, #### 涉及文件, #### 依赖: xxx, H3 group headers, HTML comments
 */
function stripDesignSubsections(content: string): string {
  const lines = content.split('\n');
  const result: string[] = [];

  let skipMode = false;

  for (const line of lines) {
    const h4Match = line.match(/^####\s+(.+)/);
    if (h4Match) {
      const title = h4Match[1].trim();
      // Check if this is a design-layer subsection to skip
      if (
        title === '实现指南' ||
        title.startsWith('参考模式') ||
        title.startsWith('⚠️ 注意事项')
      ) {
        skipMode = true;
        continue;
      } else {
        skipMode = false;
      }
    }

    // H3 or H2 ends skip mode
    if (/^###\s+/.test(line) || /^##\s+/.test(line)) {
      skipMode = false;
    }

    if (!skipMode) {
      result.push(line);
    }
  }

  return result.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

// ── Main Split Logic ──

function findJsonAcGroupsSection(sections: H2Section[]): H2Section | null {
  // The JSON AC Groups section is the one whose content starts with ```json
  for (const section of sections) {
    if (section.title === 'AC Groups') {
      const trimmed = section.content.trim();
      if (trimmed.startsWith('```json') || trimmed.startsWith('```JSON')) {
        return section;
      }
    }
  }
  return null;
}

function findMarkdownAcGroupsSection(sections: H2Section[]): H2Section | null {
  for (const section of sections) {
    if (section.title === 'AC Groups') {
      const trimmed = section.content.trim();
      if (!trimmed.startsWith('```json') && !trimmed.startsWith('```JSON')) {
        return section;
      }
    }
  }
  return null;
}

function findContractTestsSection(sections: H2Section[]): H2Section | null {
  for (const section of sections) {
    if (section.title.includes('Contract Tests') || section.title.includes('契约测试')) {
      return section;
    }
  }
  return null;
}

async function splitDoc(baseDir: string, slug: string, dryRun: boolean): Promise<SplitResult> {
  const filePath = join(baseDir, slug, 'requirement.md');
  if (!existsSync(filePath)) {
    return { slug, skipped: true, reason: 'no requirement.md', designGroups: 0, hasContractTests: false, requirementLinesBefore: 0, requirementLinesAfter: 0 };
  }

  const content = readFileSync(filePath, 'utf-8');
  const parsed = parseSddFrontmatter(content);
  if (!parsed) {
    return { slug, skipped: true, reason: 'no frontmatter', designGroups: 0, hasContractTests: false, requirementLinesBefore: 0, requirementLinesAfter: 0 };
  }

  const { meta, body } = parsed;
  const requirementLinesBefore = body.split('\n').length;

  const { preamble, sections } = splitH2WithPreamble(body);

  // Find key sections
  const jsonAcGroupsSection = findJsonAcGroupsSection(sections);
  const contractTestsSection = findContractTestsSection(sections);

  // Extract design data from JSON AC Groups
  let designGroups: AcGroupDesignData[] = [];
  if (jsonAcGroupsSection) {
    const jsonStr = extractJsonCodeBlock(jsonAcGroupsSection.content);
    if (jsonStr) {
      designGroups = extractDesignDataFromJson(jsonStr);
    }
  }

  // Extract contract tests
  let contractTests: ContractTest[] = [];
  if (contractTestsSection) {
    const jsonStr = extractJsonCodeBlock(contractTestsSection.content);
    if (jsonStr) {
      contractTests = extractContractTestsFromJson(jsonStr);
    }
  }

  // Skip if nothing to split
  if (designGroups.length === 0 && contractTests.length === 0) {
    return {
      slug,
      skipped: true,
      reason: 'no design data or contract tests found',
      designGroups: 0,
      hasContractTests: false,
      requirementLinesBefore,
      requirementLinesAfter: requirementLinesBefore,
    };
  }

  // Build new bodies
  const newRequirementBody = rebuildRequirementBody(preamble, sections, jsonAcGroupsSection, contractTestsSection);
  const designBody = buildDesignBody(designGroups, preamble);
  const taskBody = formatContractTestsForTask(contractTests, preamble);

  const requirementLinesAfter = newRequirementBody.split('\n').length;

  if (!dryRun) {
    // Write requirement.md (overwrite with stripped content)
    await writeSddDoc(slug, 'requirement', meta as Partial<SddFrontmatter>, newRequirementBody);

    // Write design.md (if has content)
    if (designBody) {
      await writeSddDoc(slug, 'design', meta as Partial<SddFrontmatter>, designBody);
    }

    // Write task.md (if has content)
    if (taskBody) {
      await writeSddDoc(slug, 'task', meta as Partial<SddFrontmatter>, taskBody);
    }
  }

  return {
    slug,
    skipped: false,
    designGroups: designGroups.filter(g =>
      g.implementationNotes || g.codePatterns.length > 0 || g.gotchas.length > 0 || g.architectureContext
    ).length,
    hasContractTests: contractTests.length > 0,
    requirementLinesBefore,
    requirementLinesAfter,
  };
}

// ── CLI ──

const isMainModule = import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith('split-sdd-layers.ts');

if (isMainModule) {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const execute = args.includes('--execute');

  if (!dryRun && !execute) {
    console.error('Usage: npx tsx scripts/split-sdd-layers.ts [--dry-run | --execute]');
    process.exit(1);
  }

  const baseDir = join(process.cwd(), 'docs/sdd');
  const allSlugs = existsSync(baseDir)
    ? readdirSync(baseDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name)
    : [];

  // Skip historical-* directories
  const slugs = allSlugs.filter(s => !s.startsWith('historical-'));

  console.log(`Scanning ${slugs.length} SDD docs (${allSlugs.length - slugs.length} historical skipped)`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'EXECUTE'}\n`);

  const results: SplitResult[] = [];
  for (const slug of slugs) {
    results.push(splitDoc(baseDir, slug, dryRun));
  }

  // Summary
  const processed = results.filter(r => !r.skipped);
  const skipped = results.filter(r => r.skipped);

  console.log(`\n=== Summary ===`);
  console.log(`Processed: ${processed.length}`);
  console.log(`Skipped: ${skipped.length}`);

  if (processed.length > 0) {
    console.log(`\nProcessed docs:`);
    for (const r of processed) {
      const delta = r.requirementLinesBefore - r.requirementLinesAfter;
      console.log(`  ${r.slug} — design groups: ${r.designGroups}, contract tests: ${r.hasContractTests}, requirement lines: ${r.requirementLinesBefore} → ${r.requirementLinesAfter} (-${delta})`);
    }
  }

  if (skipped.length > 0) {
    console.log(`\nSkipped docs:`);
    for (const r of skipped) {
      console.log(`  ${r.slug} — ${r.reason}`);
    }
  }
}

// ── Exports for testing ──

export {
  splitH2Sections,
  extractJsonCodeBlock,
  extractDesignDataFromJson,
  extractContractTestsFromJson,
  formatArchitectureContext,
  formatContractTestsForTask,
  buildDesignBody,
  stripDesignSubsections,
  rebuildRequirementBody,
  findJsonAcGroupsSection,
  findMarkdownAcGroupsSection,
  findContractTestsSection,
  splitDoc,
  type AcGroupDesignData,
  type ContractTest,
  type SplitResult,
};
