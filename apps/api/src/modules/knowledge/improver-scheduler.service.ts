/**
 * ImproverScheduler — 自文档化调度器
 *
 * 定时扫描代码目录，提取结构信息，调用 LLM 生成文档，
 * 写入 KnowledgeStore + CONTEXT.md 文件。
 *
 * AC1: runSelfDoc(dirs) — 遍历目录，提取代码结构，生成文档
 * AC2: startScheduler() — 每小时执行一次 runSelfDoc
 */

import { logger, modelGateway } from '@dommaker/studio-shared';
import { knowledgeBus } from './knowledge-bus.service.js';
import * as fs from 'fs';
import * as path from 'path';

const SELFDOD_INTERVAL_MS = 60 * 60 * 1000; // 1 小时

let selfDocTimer: NodeJS.Timeout | null = null;

interface CodeStructure {
  files: string[];
  functions: { name: string; signature: string; jsdoc?: string }[];
  classes: { name: string; signature: string; jsdoc?: string }[];
  interfaces: { name: string; signature: string; jsdoc?: string }[];
  types: { name: string; signature: string; jsdoc?: string }[];
}

/**
 * 尝试从 @dommaker/harness 导入 extractCodeStructure。
 * P5a 未完成时返回 undefined，调用方应降级。
 */
async function tryImportExtractCodeStructure(): Promise<((dir: string) => CodeStructure) | undefined> {
  try {
    const mod = await import('@dommaker/harness');
    return (mod as any).extractCodeStructure as (dir: string) => CodeStructure;
  } catch {
    return undefined;
  }
}

/**
 * 内联降级实现：读取目录下 .ts/.js 文件名列表
 */
function fallbackExtractCodeStructure(dir: string): CodeStructure {
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.ts') || f.endsWith('.js'))
      .sort();
  } catch {
    // directory doesn't exist or unreadable
  }
  return { files, functions: [], classes: [], interfaces: [], types: [] };
}

/**
 * 将 CodeStructure 格式化为 Markdown prompt
 */
function formatCodeStructurePrompt(dir: string, structure: CodeStructure): string {
  const lines: string[] = [`# Code Structure: ${dir}`, ''];

  if (structure.files.length > 0) {
    lines.push('## Files', ...structure.files.map(f => `- ${f}`), '');
  }

  const sections: [string, { name: string; signature: string; jsdoc?: string }[]][] = [
    ['Functions', structure.functions],
    ['Classes', structure.classes],
    ['Interfaces', structure.interfaces],
    ['Types', structure.types],
  ];

  for (const [label, items] of sections) {
    if (items.length > 0) {
      lines.push(`## ${label}`);
      for (const item of items) {
        const doc = item.jsdoc ? ` — ${item.jsdoc}` : '';
        lines.push(`- \`${item.signature}\`${doc}`);
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/** docs/architecture/ 模块定义 */
const ARCH_MODULES = [
  { name: 'pipeline', title: '管线', sourceDirs: ['apps/api/src/modules/goals', 'apps/api/src/modules/agents'] },
  { name: 'knowledge', title: '知识引擎', sourceDirs: ['apps/api/src/modules/knowledge', 'harness/src/knowledge'] },
  { name: 'constraints', title: '约束系统', sourceDirs: ['harness/src/core/constraints', 'harness/src/constraints'] },
  { name: 'agents', title: 'Agent 系统', sourceDirs: ['apps/api/src/modules/agents'] },
  { name: 'skills', title: 'Skill 系统', sourceDirs: ['apps/api/src/modules/skills', 'apps/api/src/modules/tools-std'] },
  { name: 'infra', title: '基础设施', sourceDirs: ['apps/api/src/daemon', 'packages/studio-shared'] },
  { name: 'index', title: '总索引', sourceDirs: [] },
];

export class ImproverScheduler {
  /**
   * P5b: 生成 7 个 docs/architecture/*.md 架构文档
   *
   * 对每个模块：提取代码结构 → LLM 生成文档 → 写入文件
   */
  async runArchDocs(): Promise<void> {
    const extractFn = await tryImportExtractCodeStructure();
    const archDir = path.resolve('docs/architecture');

    for (const mod of ARCH_MODULES) {
      try {
        // 合并所有 sourceDirs 的代码结构
        let allStructure: CodeStructure = { files: [], functions: [], classes: [], interfaces: [], types: [] };
        for (const dir of mod.sourceDirs) {
          const absDir = path.resolve(dir);
          const structure = extractFn
            ? extractFn(absDir)
            : fallbackExtractCodeStructure(absDir);
          allStructure.files.push(...structure.files);
          allStructure.functions.push(...structure.functions);
          allStructure.classes.push(...structure.classes);
          allStructure.interfaces.push(...structure.interfaces);
          allStructure.types.push(...structure.types);
        }

        const structurePrompt = formatCodeStructurePrompt(mod.title, allStructure);

        const systemPrompt = `You are a technical architecture document writer for the "${mod.title}" module.

Generate a concise architecture document (≤3KB) in this EXACT format:

# ${mod.title}

> 自动生成: ${new Date().toISOString()} | 代码来源: ${mod.sourceDirs.join(', ') || '全局'}

## 职责
(2-3 sentences: what this module does)

## 架构
(how it works internally, key patterns)

## 子模块索引
(list key files/submodules with one-line descriptions)

## 关键接口
(main exported functions/classes)

## 依赖
(what this module depends on)

Be terse. Chinese preferred. Focus on facts from the code structure, not design intent.`;

        const doc = await modelGateway.prompt(systemPrompt, structurePrompt);

        // 写入文件系统
        fs.mkdirSync(archDir, { recursive: true });
        const filePath = path.join(archDir, `${mod.name}.md`);
        fs.writeFileSync(filePath, doc, 'utf-8');

        // 写入 KnowledgeStore
        await knowledgeBus.recordPattern({
          source: 'evolution',
          type: 'guideline',
          title: `Architecture: ${mod.title}`,
          content: doc,
          severity: 'info',
          timestamp: Date.now(),
        });

        logger.info('SelfDoc arch doc generated', { module: mod.name, filePath });
      } catch (error) {
        logger.error('SelfDoc arch doc failed for module', { module: mod.name, error: String(error) });
      }
    }
  }

  /**
   * AC1: 遍历 dirs，对每个目录提取代码结构 → LLM 生成文档 → 写入 KnowledgeStore + CONTEXT.md
   */
  async runSelfDoc(dirs: string[]): Promise<void> {
    if (dirs.length === 0) return;

    const extractFn = await tryImportExtractCodeStructure();

    for (const dir of dirs) {
      try {
        const structure = extractFn
          ? extractFn(dir)
          : fallbackExtractCodeStructure(dir);

        const structurePrompt = formatCodeStructurePrompt(dir, structure);

        const systemPrompt = 'You are a technical documentation writer. Generate a concise CONTEXT.md (≤2KB) for the given code structure. List key modules, their purposes, and important exports. Be terse.';
        const doc = await modelGateway.prompt(systemPrompt, structurePrompt);

        // Write to KnowledgeStore via knowledgeBus
        await knowledgeBus.recordPattern({
          source: 'evolution',
          type: 'guideline',
          title: `Architecture: ${dir}`,
          content: doc,
          severity: 'info',
          timestamp: Date.now(),
        });

        // Write to file system
        const contextPath = path.join(dir, 'CONTEXT.md');
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(contextPath, doc, 'utf-8');
        } catch (writeErr) {
          logger.error('Failed to write CONTEXT.md', { dir, error: String(writeErr) });
        }
      } catch (error) {
        logger.error('SelfDoc failed for directory', { dir, error: String(error) });
      }
    }
  }

  /**
   * Scan subdirectories for stale CONTEXT.md files (containing ⚠️ markers).
   * For each stale file: extract code structure → LLM refresh empty sections → clear markers.
   * Preserves 修复历史 section. Cost: zero when no stale files exist.
   */
  async refreshStaleContext(): Promise<{ scanned: number; refreshed: number; errors: number }> {
    const scanDirs = this.getScanDirs();
    let scanned = 0;
    let refreshed = 0;
    let errors = 0;

    for (const baseDir of scanDirs) {
      const absBase = path.resolve(baseDir);
      let subdirs: string[] = [];
      try {
        subdirs = fs.readdirSync(absBase, { withFileTypes: true })
          .filter(d => d.isDirectory())
          .map(d => path.join(absBase, d.name));
      } catch { continue; }

      for (const dir of subdirs) {
        const ctxPath = path.join(dir, 'CONTEXT.md');
        if (!fs.existsSync(ctxPath)) continue;
        scanned++;

        let content: string;
        try { content = fs.readFileSync(ctxPath, 'utf-8'); } catch { continue; }

        // Skip if no stale markers
        if (!content.includes('⚠️') && !content.includes('STALE_SINCE')) continue;

        try {
          const extractFn = await tryImportExtractCodeStructure();
          const structure = extractFn ? extractFn(dir) : fallbackExtractCodeStructure(dir);
          const structurePrompt = formatCodeStructurePrompt(path.basename(dir), structure);

          // Preserve 修复历史 section
          const fixHistoryMatch = content.match(/## 修复历史\n[\s\S]*?(?=\n## |$)/);
          const fixHistory = fixHistoryMatch ? fixHistoryMatch[0] : '';

          // Preserve 注意事项 section if it has real content (not just placeholder)
          const notesMatch = content.match(/## 注意事项\n([\s\S]*?)(?=\n## |$)/);
          const hasRealNotes = notesMatch && !notesMatch[1].includes('<!-- ');
          const preserveNotes = hasRealNotes ? notesMatch![0] : '';

          const systemPrompt = `You are updating a stale CONTEXT.md file for a code directory.
Fill in ONLY the empty sections (marked with <!-- placeholder comments -->).
Keep sections that already have real content unchanged.
Output the COMPLETE file content including the header line and all sections.
Do NOT include any ⚠️ stale warnings or <!-- STALE_SINCE --> markers.
Preserve the 修复历史 section exactly as provided below.
Be terse. Chinese preferred. ≤2KB total.`;

          const userPrompt = `${structurePrompt}

${fixHistory ? `\nExisting section to preserve verbatim:\n${fixHistory}` : ''}
${preserveNotes ? `\nExisting section to preserve verbatim:\n${preserveNotes}` : ''}`;

          const doc = await modelGateway.prompt(userPrompt, systemPrompt, { tier: 'fast' } as any);

          // Safety: ensure 修复历史 survived
          const finalContent = fixHistory && !doc.includes('## 修复历史')
            ? `${doc.trimEnd()}\n\n${fixHistory}\n`
            : doc;

          fs.writeFileSync(ctxPath, finalContent, 'utf-8');
          refreshed++;
          logger.info('[ImproverScheduler] CONTEXT.md refreshed', { dir: path.basename(dir) });
        } catch (err) {
          errors++;
          logger.error('[ImproverScheduler] CONTEXT refresh failed', { dir: path.basename(dir), error: String(err) });
        }
      }
    }

    if (refreshed > 0 || errors > 0) {
      logger.info('[ImproverScheduler] refreshStaleContext complete', { scanned, refreshed, errors });
    }
    return { scanned, refreshed, errors };
  }

  /**
   * AC2: 启动调度器，每小时执行一次 refreshStaleContext + runArchDocs
   */
  startScheduler(): void {
    selfDocTimer = setInterval(() => {
      this.refreshStaleContext().catch(err => {
        logger.error('refreshStaleContext scheduler tick failed', { error: String(err) });
      });
      this.runArchDocs().catch(err => {
        logger.error('ArchDocs scheduler tick failed', { error: String(err) });
      });
    }, SELFDOD_INTERVAL_MS);
    logger.info('ImproverScheduler started', { intervalMs: SELFDOD_INTERVAL_MS });
  }

  stopScheduler(): void {
    if (selfDocTimer) {
      clearInterval(selfDocTimer);
      selfDocTimer = null;
    }
    logger.info('ImproverScheduler stopped');
  }

  private getScanDirs(): string[] {
    const envDirs = process.env.SELFDOC_DIRS;
    if (envDirs) {
      return envDirs.split(',').map(d => d.trim()).filter(Boolean);
    }
    return ['apps/api/src/modules'];
  }
}
