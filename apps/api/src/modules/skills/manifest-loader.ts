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
}

const SKILLS_DIR = process.env.SKILLS_DIR || path.join(os.homedir(), '.studio', 'skills');

/** Cache */
let cachedEntries: SkillEntry[] | null = null;

/**
 * Parse YAML frontmatter from SKILL.md content.
 * Extracts name and description fields.
 */
function parseFrontmatter(content: string): { name: string; description: string } | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const yaml = match[1];
  let name = '';
  let description = '';

  for (const line of yaml.split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const [, key, val] = kv;
    const cleaned = val.replace(/^["']|["']$/g, '');
    if (key === 'name') name = cleaned;
    if (key === 'description') description = cleaned;
  }

  return name ? { name, description } : null;
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

        entries.push({
          name: meta.name || dir.name,
          path: `${dir.name}/SKILL.md`,
          description: meta.description,
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
 * Invalidate cached manifest — call after external changes.
 */
export function invalidateManifestCache(): void {
  cachedEntries = null;
}
