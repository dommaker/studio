/**
 * RuleScanner (G-002) — 从源码/harness 约束/配置中提取业务规则
 *
 * 冷启动全量扫描 + 变更时增量 diff 更新。
 */

import { logger } from '@dommaker/studio-shared';
import { sharedStore } from './knowledge-bus.service.js';
import { readFileSync, existsSync, readdirSync } from 'fs';
import path from 'path';
import * as os from 'os';

interface ScannedRule {
  name: string;
  category: string;
  description: string;
  condition: string;
  action: string;
  defaultValue?: string;
  source: string;
  sourceType: 'code_constant' | 'env_var' | 'harness_constraint' | 'config_file';
  affects: string[];
}

const PROJECT_ROOT = process.env.PROJECT_ROOT || path.join(os.homedir(), 'projects', 'studio');

export class RuleScanner {
  /**
   * 冷启动：全量扫描所有规则源
   */
  async fullScan(): Promise<{ created: number; updated: number; skipped: number }> {
    logger.info('[RuleScanner] Starting full scan...');
    const rules: ScannedRule[] = [];

    try {
      rules.push(...this.scanHarnessConstraints());
      rules.push(...this.scanArchitectRules());
      rules.push(...this.scanSourceConstants());
      rules.push(...this.scanEnvThresholds());
    } catch (err) {
      logger.error('[RuleScanner] Scan error', { error: String(err) });
    }

    let created = 0;
    let updated = 0;
    let skipped = 0;

    // Get existing rules from KnowledgeStore for dedup + deprecation
    const existingEntries = sharedStore.list({ tags: ['rule'] });
    const existingByName = new Map<string, any>();
    for (const e of existingEntries) {
      existingByName.set((e as any).title, e);
    }

    const known = new Set(rules.map(r => r.name));
    const ts = new Date().toISOString();

    for (const rule of rules) {
      if (!rule.name || !rule.description) continue;

      const existing = existingByName.get(rule.name);

      if (existing) {
        const d = JSON.parse((existing as any).content || '{}');
        const changed =
          d.description !== rule.description ||
          d.condition !== rule.condition ||
          d.defaultValue !== rule.defaultValue;

        if (changed) {
          sharedStore.save({
            ...existing,
            title: rule.name,
            content: JSON.stringify(rule),
            lastReferenced: ts,
          } as any);
          updated++;
        } else {
          skipped++;
        }
      } else {
        const id = `rule-${rule.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}`;
        sharedStore.save({
          id,
          type: 'guideline' as any,
          title: rule.name,
          content: JSON.stringify(rule),
          maturity: 'active' as any,
          layer: 'project',
          created: ts,
          lastReferenced: ts,
          contributors: ['rule-scanner'],
          projects: [],
          tags: ['rule', 'active', rule.category],
          applicablePhases: [],
          sourceReferences: [],
          referencedBy: [],
          executionResults: [],
          consumptionMode: 'rule',
          origin: 'system',
        } as any);
        created++;
      }
    }

    // Deprecate rules not found in this scan
    for (const [name, entry] of existingByName) {
      if (!known.has(name)) {
        sharedStore.save({
          ...entry,
          tags: [...(entry as any).tags.filter((t: string) => t !== 'active'), 'deprecated'],
        } as any);
      }
    }

    logger.info(`[RuleScanner] Scan done: ${created} created, ${updated} updated, ${skipped} unchanged`);
    return { created, updated, skipped };
  }

  /**
   * 增量扫描：从 git diff 中检测规则变更
   */
  async scanFromDiff(diffFiles: string[]): Promise<number> {
    const ruleFiles = diffFiles.filter(f =>
      f.includes('definitions.ts') ||
      f.includes('.architect/rules.yml') ||
      f.match(/(MAX_|MIN_|DEFAULT_|LIMIT_|THRESHOLD_)/) ||
      f.endsWith('.env.example'),
    );

    if (ruleFiles.length === 0) return 0;

    logger.info('[RuleScanner] Diff-triggered scan', { files: ruleFiles });
    const { created, updated } = await this.fullScan();
    return created + updated;
  }

  /**
   * 获取所有活跃规则（供 Agent context 注入）
   */
  async getActiveRules(): Promise<Record<string, any>[]> {
    const entries = sharedStore.list({ tags: ['rule', 'active'] });
    return entries
      .map((e: any) => {
        const r = JSON.parse(e.content || '{}');
        return {
          name: r.name || e.title,
          category: r.category || '',
          description: r.description || '',
          condition: r.condition || '',
          action: r.action || '',
          defaultValue: r.defaultValue || null,
          source: r.source || '',
          affects: r.affects || [],
          version: r.version || 1,
        };
      })
      .sort((a: any, b: any) => a.category.localeCompare(b.category));
  }

  /**
   * 按影响范围查询规则
   */
  async getRulesForAgent(agentType: string): Promise<Record<string, any>[]> {
    const all = await this.getActiveRules();
    return all.filter(r => r.affects.includes(agentType) || r.affects.length === 0);
  }

  /**
   * 格式化规则为 prompt 注入片段
   */
  async formatForPrompt(agentType?: string): Promise<string> {
    const rules = agentType ? await this.getRulesForAgent(agentType) : await this.getActiveRules();
    if (rules.length === 0) return '';

    const byCategory: Record<string, typeof rules> = {};
    for (const r of rules) {
      (byCategory[r.category] ||= []).push(r);
    }

    const lines: string[] = ['\n## 业务规则（系统约束）'];
    for (const [cat, items] of Object.entries(byCategory)) {
      lines.push(`\n### ${cat}`);
      for (const item of items.slice(0, 8)) {
        lines.push(`- ${item.name}: ${item.description} (${item.condition} → ${item.action})`);
        if (item.defaultValue) lines.push(`  默认值: ${item.defaultValue}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  // ── private scanners ──

  private scanHarnessConstraints(): ScannedRule[] {
    const rules: ScannedRule[] = [];
    const harnessRoot = path.join(PROJECT_ROOT, 'node_modules', '@dommaker', 'harness');

    // definitions.ts 是薄聚合；真实定义在 definitions/{iron-laws,guidelines,tips}.ts（harness 拆分后用 id: 字段）
    const layers: Array<{ file: string; prefix: string }> = [
      { file: 'iron-laws.ts', prefix: 'iron_law' },
      { file: 'guidelines.ts', prefix: 'guideline' },
      { file: 'tips.ts', prefix: 'tip' },
    ];

    let foundAny = false;
    for (const { file, prefix } of layers) {
      const defPath = path.join(harnessRoot, 'src', 'core', 'constraints', 'definitions', file);
      if (!existsSync(defPath)) continue;
      foundAny = true;

      try {
        const content = readFileSync(defPath, 'utf-8');

        // 每个约束块以 id: 'xxx' 开头，取其后最近的 description 首行
        const blockRe = /id:\s*'(\w+)'[\s\S]*?description:\s*['`]([^'`\n]+)/g;
        for (const m of content.matchAll(blockRe)) {
          rules.push({
            name: `${prefix}:${m[1]}`,
            category: 'constraint',
            description: m[2],
            condition: 'always',
            action: `enforce ${prefix}:${m[1]}`,
            source: `@dommaker/harness/src/core/constraints/definitions/${file}`,
            sourceType: 'harness_constraint',
            affects: ['agent', 'reviewer'],
          });
        }
      } catch (err) {
        logger.warn('[RuleScanner] Failed to scan harness constraints', { error: String(err) });
      }
    }

    if (!foundAny) {
      logger.debug('[RuleScanner] harness definitions subfiles not found', { path: harnessRoot });
    }

    return rules;
  }

  private scanArchitectRules(): ScannedRule[] {
    const rules: ScannedRule[] = [];
    const archPath = path.join(PROJECT_ROOT, '.architect', 'rules.yml');

    if (!existsSync(archPath)) return rules;

    try {
      const content = readFileSync(archPath, 'utf-8');
      // 简单解析 YAML 规则（不引入完整 yaml 解析器）
      const ruleBlocks = content.split(/\n- rule:/).filter(Boolean);
      for (const block of ruleBlocks.slice(1)) {
        const descMatch = block.match(/description:\s*"([^"]+)"/);
        const pathMatch = block.match(/path:\s*"([^"]+)"/);
        if (descMatch) {
          rules.push({
            name: `architect:${pathMatch?.[1] || 'unknown'}`,
            category: 'architecture',
            description: descMatch[1],
            condition: `applies to ${pathMatch?.[1] || 'all'}`,
            action: 'architect constraint check',
            source: '.architect/rules.yml',
            sourceType: 'config_file',
            affects: ['agent', 'reviewer'],
          });
        }
      }
    } catch (err) {
      logger.warn('[RuleScanner] Failed to scan .architect/rules.yml', { error: String(err) });
    }

    return rules;
  }

  private scanSourceConstants(): ScannedRule[] {
    const rules: ScannedRule[] = [];
    const srcDir = path.join(PROJECT_ROOT, 'apps', 'api', 'src');
    if (!existsSync(srcDir)) return rules;

    const constantRe = /\b(MAX_|MIN_|DEFAULT_|LIMIT_|THRESHOLD_)(\w+)\s*[=:]\s*(\d+|["'][^"']*["'])/g;

    try {
      this.walkDir(srcDir, (filePath: string) => {
        if (!filePath.endsWith('.ts')) return;
        try {
          const content = readFileSync(filePath, 'utf-8');
          for (const m of content.matchAll(constantRe)) {
            const prefix = m[1];
            const name = m[2];
            const value = m[3].replace(/['"]/g, '');
            const lineNum = content.substring(0, m.index).split('\n').length;
            const relPath = filePath.replace(PROJECT_ROOT + '/', '');

            // 找关联注释
            const lines = content.split('\n');
            const lineIdx = lineNum - 1;
            const comment = (lineIdx > 0 && lines[lineIdx - 1]?.match(/\/\/\s*(.+)/))
              ? lines[lineIdx - 1].match(/\/\/\s*(.+)/)![1]
              : '';

            rules.push({
              name: `${prefix}${name}`.toLowerCase(),
              category: prefix.startsWith('MAX_') || prefix.startsWith('LIMIT_') ? 'threshold' : 'behavior',
              description: comment || `${prefix}${name}`,
              condition: `${prefix}${name} = ${value}`,
              action: `${prefix}${name} exceeded`,
              defaultValue: value,
              source: `${relPath}:${lineNum}`,
              sourceType: 'code_constant',
              affects: this.inferAffects(relPath),
            });
          }
        } catch { /* skip unreadable */ }
      });
    } catch (err) {
      logger.warn('[RuleScanner] Failed to scan source constants', { error: String(err) });
    }

    // T-1.3: 只保留有同行注释的常量 — 过滤纯配置值
    return rules.filter(r => r.description && !r.description.startsWith('MAX_') && !r.description.startsWith('MIN_') && !r.description.startsWith('DEFAULT_') && !r.description.startsWith('LIMIT_') && !r.description.startsWith('THRESHOLD_'));
  }

  private scanEnvThresholds(): ScannedRule[] {
    const rules: ScannedRule[] = [];
    const envPaths = [
      path.join(PROJECT_ROOT, '.env.example'),
      path.join(PROJECT_ROOT, '.env.production.example'),
    ];

    for (const envPath of envPaths) {
      if (!existsSync(envPath)) continue;
      try {
        const content = readFileSync(envPath, 'utf-8');
        const lines = content.split('\n');
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed.startsWith('#')) continue;

          const commentIdx = trimmed.indexOf('#');
          const comment = commentIdx >= 0 ? trimmed.substring(commentIdx + 1).trim() : '';
          const kv = commentIdx >= 0 ? trimmed.substring(0, commentIdx).trim() : trimmed;
          const match = kv.match(/^(\w+)\s*=\s*(.+)$/);
          if (!match) continue;

          const key = match[1];
          const value = match[2].replace(/['"]/g, '');

          // 只取阈值类配置
          if (key.match(/(_TIMEOUT|_LIMIT|_MAX|_MIN|_INTERVAL|MAX_|MIN_)/i)) {
            rules.push({
              name: `env:${key.toLowerCase()}`,
              category: 'threshold',
              description: comment || `${key} 环境配置`,
              condition: `${key} = ${value}`,
              action: `use ${key}`,
              defaultValue: value,
              source: envPath.replace(PROJECT_ROOT + '/', ''),
              sourceType: 'env_var',
              affects: ['agent', 'executor', 'monitor'],
            });
          }
        }
      } catch (err) {
        logger.warn('[RuleScanner] Failed to scan env', { envPath, error: String(err) });
      }
    }

    return rules;
  }

  private walkDir(dir: string, fn: (path: string) => void): void {
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules') {
          this.walkDir(full, fn);
        } else if (e.isFile()) {
          fn(full);
        }
      }
    } catch { /* skip */ }
  }

  private inferAffects(filePath: string): string[] {
    if (filePath.includes('agent')) return ['agent', 'executor'];
    if (filePath.includes('review')) return ['reviewer'];
    if (filePath.includes('analyst')) return ['analyst'];
    if (filePath.includes('goal') || filePath.includes('executor')) return ['executor', 'agent'];
    if (filePath.includes('monitor') || filePath.includes('triage')) return ['monitor', 'triage'];
    if (filePath.includes('deploy')) return ['deploy'];
    if (filePath.includes('auditor')) return ['auditor'];
    return ['agent'];
  }
}

export const ruleScanner = new RuleScanner();
