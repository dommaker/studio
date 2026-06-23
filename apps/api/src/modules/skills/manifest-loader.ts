/**
 * manifest-loader (AS-025 §3.28c-5)
 *
 * Parses ~/.studio/skills/MANIFEST.md → SkillEntry[]
 * Skips "降级记录" section (deprecated skills).
 *
 * AC1: 读取 MANIFEST.md 返回 Skill 列表（name + description）
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
  /** The "回答的问题" column — what this skill answers */
  question: string;
}

const SKILLS_DIR = process.env.SKILLS_DIR || path.join(os.homedir(), '.studio', 'skills');
const MANIFEST_FILE = 'MANIFEST.md';

/** Cache */
let cachedEntries: SkillEntry[] | null = null;

/**
 * Parse a markdown table row like:
 * | `session-analyst/SKILL.md` | 如何分析需求产出 spec 或 SDD |
 *
 * Returns { path, question } or null if malformed.
 */
function parseTableRow(line: string): { skillPath: string; question: string } | null {
  // Match: | `path` | question |
  const match = line.match(/^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|/);
  if (!match) return null;

  const [, skillPath, question] = match;
  // Only accept paths ending in /SKILL.md
  if (!skillPath.endsWith('/SKILL.md')) return null;

  return { skillPath, question };
}

/**
 * Parse MANIFEST.md content into SkillEntry[].
 * Stops at "降级记录" section header.
 */
function parseManifestContent(content: string): SkillEntry[] {
  const entries: SkillEntry[] = [];
  const lines = content.split('\n');
  let inDeprecatedSection = false;

  for (const line of lines) {
    // Detect start of deprecated section
    if (/^##\s+降级/.test(line)) {
      inDeprecatedSection = true;
      continue;
    }

    // Any other ## header exits the deprecated section
    if (/^##\s+/.test(line)) {
      inDeprecatedSection = false;
      continue;
    }

    if (inDeprecatedSection) continue;

    const parsed = parseTableRow(line);
    if (!parsed) continue;

    // Extract directory name from path: "session-analyst/SKILL.md" → "session-analyst"
    const name = parsed.skillPath.replace('/SKILL.md', '');
    entries.push({
      name,
      path: parsed.skillPath,
      question: parsed.question,
    });
  }

  return entries;
}

/**
 * Load and parse MANIFEST.md.
 * Cached after first call; use invalidateManifestCache() to refresh.
 */
export function loadManifest(): SkillEntry[] {
  if (cachedEntries) return cachedEntries;

  const manifestPath = path.join(SKILLS_DIR, MANIFEST_FILE);
  try {
    if (!fs.existsSync(manifestPath)) {
      logger.warn('[manifest-loader] MANIFEST.md not found', { path: manifestPath });
      cachedEntries = [];
      return cachedEntries;
    }

    const content = fs.readFileSync(manifestPath, 'utf-8');
    cachedEntries = parseManifestContent(content);

    logger.info('[manifest-loader] Loaded manifest', { count: cachedEntries.length });
    return cachedEntries;
  } catch (err) {
    logger.error('[manifest-loader] Failed to load manifest', { error: String(err) });
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
 * AC3: 加载选中 Skill 全文（SKILL.md 内容）
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
