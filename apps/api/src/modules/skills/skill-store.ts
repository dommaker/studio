/**
 * SkillStore — File-based CRUD for Skill metadata
 *
 * Replaces prisma.skill with file-system storage.
 * Skill metadata persisted to ~/.studio/skills-index.json.
 * Skill prompt content stored as SKILL.md files in ~/.studio/skills/<trigger>/<name>/.
 *
 * Migration: D-005 Prisma Skill deletion.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';
import { logger } from '@dommaker/studio-shared';
import { generateManifest } from './manifest-generator.js';

// ── Types ──

export interface SkillRecord {
  id: string;
  companyId: string;
  roleId?: string | null;
  name: string;
  source: string;
  status: string;
  version: number;
  category?: string | null;
  description?: string | null;
  prompt?: string | null;
  trigger?: string | null;
  agentTypes?: string | null;  // JSON array
  tier?: string | null;
  tools?: string | null;       // JSON array
  required?: string | null;    // JSON array
  autoLoad: boolean;
  isBuiltin: boolean;
  usageCount: number;
  successRate: number;
  avgDuration: number;
  metadata?: string | null;    // JSON
  extractedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkillCreateInput {
  companyId: string;
  roleId?: string | null;
  name: string;
  source?: string;
  status?: string;
  version?: number;
  category?: string | null;
  description?: string | null;
  prompt?: string | null;
  trigger?: string | null;
  agentTypes?: string | null;
  tier?: string | null;
  tools?: string | null;
  required?: string | null;
  autoLoad?: boolean;
  isBuiltin?: boolean;
  metadata?: string | null;
}

export interface SkillUpdateInput {
  roleId?: string | null;
  name?: string;
  source?: string;
  status?: string;
  version?: number | { increment: number };
  category?: string | null;
  description?: string | null;
  prompt?: string | null;
  trigger?: string | null;
  agentTypes?: string | null;
  tier?: string | null;
  tools?: string | null;
  required?: string | null;
  autoLoad?: boolean;
  isBuiltin?: boolean;
  usageCount?: number;
  successRate?: number;
  avgDuration?: number;
  metadata?: string | null;
}

export interface SkillListFilter {
  companyId?: string;
  status?: string;
  category?: string;
  roleId?: string;
  name?: string | { contains?: string; startsWith?: string; mode?: string };
  source?: string | { in?: string[] };
  usageCount?: number | { gte?: number; gt?: number };
}

// ── Store ──

const DATA_DIR = path.join(os.homedir(), '.studio');
const INDEX_FILE = path.join(DATA_DIR, 'skills-index.json');

export class SkillStore {
  private cache: SkillRecord[] | null = null;

  private ensureDir(): void {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  private loadIndex(): SkillRecord[] {
    if (this.cache) return this.cache;
    try {
      if (!fs.existsSync(INDEX_FILE)) {
        this.cache = [];
        return this.cache;
      }
      const raw = fs.readFileSync(INDEX_FILE, 'utf-8');
      this.cache = JSON.parse(raw);
      return this.cache!;
    } catch {
      this.cache = [];
      return this.cache;
    }
  }

  private saveIndex(records: SkillRecord[]): void {
    this.ensureDir();
    this.cache = records;
    fs.writeFileSync(INDEX_FILE, JSON.stringify(records, null, 2), 'utf-8');
  }

  private matchesFilter(record: SkillRecord, filter: SkillListFilter): boolean {
    if (filter.companyId && record.companyId !== filter.companyId) return false;
    if (filter.status && record.status !== filter.status) return false;
    if (filter.category && record.category !== filter.category) return false;
    if (filter.roleId && record.roleId !== filter.roleId) return false;

    if (filter.name) {
      if (typeof filter.name === 'string') {
        if (record.name !== filter.name) return false;
      } else {
        const nameLower = record.name.toLowerCase();
        if (filter.name.contains && !nameLower.includes(filter.name.contains.toLowerCase())) return false;
        if (filter.name.startsWith && !nameLower.startsWith(filter.name.startsWith.toLowerCase())) return false;
      }
    }

    if (filter.source) {
      if (typeof filter.source === 'string') {
        if (record.source !== filter.source) return false;
      } else if (filter.source.in) {
        if (!filter.source.in.includes(record.source)) return false;
      }
    }

    if (filter.usageCount !== undefined) {
      if (typeof filter.usageCount === 'number') {
        if (record.usageCount !== filter.usageCount) return false;
      } else {
        if (filter.usageCount.gte !== undefined && record.usageCount < filter.usageCount.gte) return false;
        if (filter.usageCount.gt !== undefined && record.usageCount <= filter.usageCount.gt) return false;
      }
    }

    return true;
  }

  // ── CRUD ──

  list(filter: SkillListFilter = {}, options?: { skip?: number; take?: number; orderBy?: { field: keyof SkillRecord; dir: 'asc' | 'desc' } }): SkillRecord[] {
    const all = this.loadIndex();
    let filtered = all.filter(r => this.matchesFilter(r, filter));

    if (options?.orderBy) {
      const { field, dir } = options.orderBy;
      filtered.sort((a, b) => {
        const av = a[field] ?? '';
        const bv = b[field] ?? '';
        if (av < bv) return dir === 'asc' ? -1 : 1;
        if (av > bv) return dir === 'asc' ? 1 : -1;
        return 0;
      });
    }

    if (options?.skip || options?.take) {
      const skip = options.skip || 0;
      const take = options.take || filtered.length;
      filtered = filtered.slice(skip, skip + take);
    }

    return filtered;
  }

  count(filter: SkillListFilter = {}): number {
    const all = this.loadIndex();
    return all.filter(r => this.matchesFilter(r, filter)).length;
  }

  get(id: string): SkillRecord | null {
    const all = this.loadIndex();
    return all.find(r => r.id === id) || null;
  }

  findFirst(filter: SkillListFilter): SkillRecord | null {
    const all = this.loadIndex();
    return all.find(r => this.matchesFilter(r, filter)) || null;
  }

  create(input: SkillCreateInput): SkillRecord {
    const all = this.loadIndex();
    const now = new Date().toISOString();
    const record: SkillRecord = {
      id: randomUUID(),
      companyId: input.companyId,
      roleId: input.roleId ?? null,
      name: input.name,
      source: input.source || 'manual',
      status: input.status || 'draft',
      version: input.version || 1,
      category: input.category ?? null,
      description: input.description ?? null,
      prompt: input.prompt ?? null,
      trigger: input.trigger ?? null,
      agentTypes: input.agentTypes ?? null,
      tier: input.tier ?? null,
      tools: input.tools ?? null,
      required: input.required ?? null,
      autoLoad: input.autoLoad ?? false,
      isBuiltin: input.isBuiltin ?? false,
      usageCount: 0,
      successRate: 0,
      avgDuration: 0,
      metadata: input.metadata ?? null,
      extractedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    all.push(record);
    this.saveIndex(all);

    // Also write SKILL.md if prompt provided
    if (input.prompt) {
      this.writeSkillMd(record, input.prompt);
    }

    logger.info('[SkillStore] Created skill', { id: record.id, name: record.name });
    return record;
  }

  update(id: string, data: SkillUpdateInput): SkillRecord | null {
    const all = this.loadIndex();
    const idx = all.findIndex(r => r.id === id);
    if (idx === -1) return null;

    const record = all[idx];
    const now = new Date().toISOString();

    if (data.name !== undefined) record.name = data.name;
    if (data.roleId !== undefined) record.roleId = data.roleId;
    if (data.source !== undefined) record.source = data.source;
    if (data.status !== undefined) record.status = data.status;
    if (data.version !== undefined) {
      if (typeof data.version === 'object' && 'increment' in data.version) {
        record.version = (record.version || 0) + data.version.increment;
      } else {
        record.version = data.version as number;
      }
    }
    if (data.category !== undefined) record.category = data.category;
    if (data.description !== undefined) record.description = data.description;
    if (data.prompt !== undefined) record.prompt = data.prompt;
    if (data.trigger !== undefined) record.trigger = data.trigger;
    if (data.agentTypes !== undefined) record.agentTypes = data.agentTypes;
    if (data.tier !== undefined) record.tier = data.tier;
    if (data.tools !== undefined) record.tools = data.tools;
    if (data.required !== undefined) record.required = data.required;
    if (data.autoLoad !== undefined) record.autoLoad = data.autoLoad;
    if (data.isBuiltin !== undefined) record.isBuiltin = data.isBuiltin;
    if (data.usageCount !== undefined) record.usageCount = data.usageCount;
    if (data.successRate !== undefined) record.successRate = data.successRate;
    if (data.avgDuration !== undefined) record.avgDuration = data.avgDuration;
    if (data.metadata !== undefined) record.metadata = data.metadata;
    record.updatedAt = now;

    all[idx] = record;
    this.saveIndex(all);

    logger.info('[SkillStore] Updated skill', { id, name: record.name });
    return record;
  }

  delete(id: string): boolean {
    const all = this.loadIndex();
    const idx = all.findIndex(r => r.id === id);
    if (idx === -1) return false;

    const record = all[idx];
    all.splice(idx, 1);
    this.saveIndex(all);

    // Remove SKILL.md file if exists
    this.removeSkillMd(record);

    logger.info('[SkillStore] Deleted skill', { id, name: record.name });
    return true;
  }

  deleteMany(filter: SkillListFilter): number {
    const all = this.loadIndex();
    const toDelete = all.filter(r => this.matchesFilter(r, filter));
    const remaining = all.filter(r => !this.matchesFilter(r, filter));
    this.saveIndex(remaining);

    for (const r of toDelete) {
      this.removeSkillMd(r);
    }

    return toDelete.length;
  }

  // ── SKILL.md file management ──

  private getSkillDir(record: SkillRecord): string {
    const skillsDir = process.env.SKILLS_DIR || path.join(os.homedir(), '.studio', 'skills');
    return path.join(skillsDir, record.name);
  }

  private writeSkillMd(record: SkillRecord, prompt: string): void {
    try {
      const dir = this.getSkillDir(record);
      fs.mkdirSync(dir, { recursive: true });

      const agentTypes = record.agentTypes ? JSON.parse(record.agentTypes) : ['executor'];

      const frontmatter = [
        '---',
        `name: '${record.name}'`,
        `version: ${record.version || 1}`,
        `agentTypes: [${agentTypes.map((a: string) => `'${a}'`).join(', ')}]`,
        `tier: '${record.tier || 'standard'}'`,
        `status: '${record.status || 'draft'}'`,
        '---',
      ].join('\n');

      const content = `${frontmatter}\n\n${prompt}`;
      fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8');

      // SKILL.md 变更后重新生成 MANIFEST.md（best-effort，不阻塞写入）
      try {
        generateManifest();
      } catch (e) {
        logger.warn('[SkillStore] Failed to regenerate MANIFEST.md', { name: record.name, error: String(e) });
      }
    } catch (e) {
      logger.warn('[SkillStore] Failed to write SKILL.md', { name: record.name, error: String(e) });
    }
  }

  private removeSkillMd(record: SkillRecord): void {
    try {
      const dir = this.getSkillDir(record);
      if (fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    } catch (e) {
      logger.warn('[SkillStore] Failed to remove SKILL.md dir', { name: record.name, error: String(e) });
    }
  }

  /** Invalidate cache — call after external file changes */
  invalidateCache(): void {
    this.cache = null;
  }
}

/** Singleton */
export const skillStore = new SkillStore();
