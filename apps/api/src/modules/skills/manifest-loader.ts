/**
 * manifest-loader (AS-025 3.28c-5)
 *
 * Scans skills directories, reads SKILL.md frontmatter to build SkillEntry[].
 * No longer depends on manually maintained MANIFEST.md table.
 *
 * AC1: scan skills directory, return Skill list (name + description)
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { logger } from '@dommaker/studio-shared';

export interface SkillEntry {
  /** Directory name (e.g., "session-analyst") */
  name: string;
  /** Relative path (e.g., "session-analyst/SKILL.md") */
  path: string;
  /** Skill description from frontmatter (Chinese) */
  description: string;
  /** 服务域（frontmatter agentTypes）——域匹配主信号，缺省表示未声明 */
  agentTypes?: string[];
  /** 生命周期状态（frontmatter status）——缺省视为 active */
  status?: string;
  /** 触发关键词（frontmatter triggers）——scope 匹配优先于 description */
  triggers?: string[];
  /** 消费方（frontmatter consumers）——含 'loop' 的是 hub-service skill，不参与 WU 匹配 */
  consumers?: string[];
  /** 引用次数（排序器「其余 published」热度信号；manifest 暂未回填 → 调用方按名称序兜底） */
  referenceCount?: number;
  /** 最近更新时间 ISO 8601（热度次级信号；未回填 → 名称序兜底） */
  updatedAt?: string;
}

const SKILLS_DIR = process.env.SKILLS_DIR || path.join(os.homedir(), '.studio', 'skills');

/** Cache */
let cachedEntries: SkillEntry[] | null = null;

/**
 * Parse YAML frontmatter from SKILL.md content.
 * Extracts name/description/agentTypes/status/triggers/consumers fields.
 * 数组字段（agentTypes/triggers/consumers）支持 `[a, b]` 行内写法，与 skill-loader 解析口径一致。
 */
function parseFrontmatter(content: string): { name: string; description: string; agentTypes?: string[]; status?: string; triggers?: string[]; consumers?: string[] } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  let name = '';
  let description = '';
  let agentTypes: string[] | undefined;
  let status: string | undefined;
  let triggers: string[] | undefined;
  let consumers: string[] | undefined;

  for (const line of yaml.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    // Parse arrays: [a, b] or ["a", "b"]
    if (val.startsWith('[') && val.endsWith(']')) {
      const arr = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      if (key === 'agentTypes') agentTypes = arr;
      if (key === 'triggers') triggers = arr;
      if (key === 'consumers') consumers = arr;
      continue;
    }
    const cleaned = val.replace(/^["']|["']$/g, '');
    if (key === 'name') name = cleaned;
    if (key === 'description') description = cleaned;
    if (key === 'status') status = cleaned;
  }

  return name ? { name, description, agentTypes, status, triggers, consumers } : null;
}

/**
 * Scan skills directories, build SkillEntry[] from SKILL.md frontmatter.
 * Skips directories without valid SKILL.md or frontmatter.
 */
export function loadManifest(): SkillEntry[] {
  if (cachedEntries) return cachedEntries;

  try {
    if (!fs.existsSync(SKILLS_DIR)) {
      logger.warn('[manifest-loader] Skills directory not found', { path: SKILLS_DIR });
      cachedEntries = [];
      return cachedEntries;
    }

    const entries: SkillEntry[] = [];
    const dirs = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });

    for (const dir of dirs) {
      if (!dir.isDirectory() || dir.name.startsWith('_')) continue;

      const skillFile = path.join(SKILLS_DIR, dir.name, 'SKILL.md');
      if (!fs.existsSync(skillFile)) continue;

      try {
        const content = fs.readFileSync(skillFile, 'utf-8');
        const meta = parseFrontmatter(content);
        if (!meta) continue;

        // 生命周期过滤：status 缺省 = active；显式设置且非 published 才跳过
        // （与 skill-loader loadSkillFromDisk 口径一致，_deprecated 等草稿不参与匹配）
        if (meta.status && meta.status !== 'published') continue;

        entries.push({
          name: meta.name || dir.name,
          path: `${dir.name}/SKILL.md`,
          description: meta.description,
          agentTypes: meta.agentTypes,
          status: meta.status,
          triggers: meta.triggers,
          consumers: meta.consumers,
        });
      } catch (err) {
        logger.warn('[manifest-loader] Failed to read SKILL.md', { skill: dir.name, error: String(err) });
      }
    }

    cachedEntries = entries;
    logger.info('[manifest-loader] Loaded skills from directory', { count: cachedEntries.length });
    return cachedEntries;
  } catch (err) {
    logger.error('[manifest-loader] Failed to scan skills directory', { error: String(err) });
    cachedEntries = [];
    return cachedEntries;
  }
}

/**
 * Get the full filesystem path for a SkillEntry's SKILL.md.
 */
export function getSkillFilePath(entry: SkillEntry): string {
  return path.join(SKILLS_DIR, entry.path);
}

/**
 * Read full SKILL.md content for a SkillEntry.
 * AC3: load full SKILL.md content for selected skill
 * Returns null if file doesn't exist.
 */
export function loadSkillContent(entry: SkillEntry): string | null {
  const filePath = getSkillFilePath(entry);
  try {
    if (!fs.existsSync(filePath)) {
      logger.warn('[manifest-loader] SKILL.md not found', { path: filePath });
      return null;
    }
    return fs.readFileSync(filePath, 'utf-8');
  } catch (err) {
    logger.error('[manifest-loader] Failed to read SKILL.md', { path: filePath, error: String(err) });
    return null;
  }
}

/**
 * 读取 SKILL.md 正文（剥掉 frontmatter）——agentStep prompt 注入用。
 * Returns null if file doesn't exist or body is empty.
 */
export function loadSkillBody(entry: SkillEntry): string | null {
  const content = loadSkillContent(entry);
  if (!content) return null;
  const match = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
  const body = (match ? match[1] : content).trim();
  return body || null;
}

/**
 * Invalidate cached manifest — call after external changes.
 */
export function invalidateManifestCache(): void {
  cachedEntries = null;
}
