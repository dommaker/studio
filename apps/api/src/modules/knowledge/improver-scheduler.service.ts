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

export class ImproverScheduler {
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
   * AC2: 启动调度器，每小时执行一次 runSelfDoc
   */
  startScheduler(): void {
    const dirs = this.getScanDirs();
    selfDocTimer = setInterval(() => {
      this.runSelfDoc(dirs).catch(err => {
        logger.error('SelfDoc scheduler tick failed', { error: String(err) });
      });
    }, SELFDOD_INTERVAL_MS);
    logger.info('ImproverScheduler started', { intervalMs: SELFDOD_INTERVAL_MS, dirs });
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
