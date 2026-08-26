/**
 * manifest-loader tests (AS-025 §3.28c-5)
 *
 * AC1: 扫描 skills 目录返回 Skill 列表（name + description）
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Isolated test skills dir
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
process.env.SKILLS_DIR = testSkillsDir;
// 显式清理：`import * as fs` 走原生命名空间，mkdtemp-cleanup 补丁登记不到（见其头注）
afterAll(() => { fs.rmSync(testSkillsDir, { recursive: true, force: true }); });

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { loadManifest, invalidateManifestCache, getSkillFilePath } = await import('../manifest-loader.js');

function writeSkill(dirName: string, name: string, description: string) {
  const dir = path.join(testSkillsDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const content = `---\nname: ${name}\ndescription: "${description}"\n---\n\n# ${name}\n\nSkill content here.`;
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content, 'utf-8');
}

function cleanupSkills() {
  for (const dir of fs.readdirSync(testSkillsDir)) {
    fs.rmSync(path.join(testSkillsDir, dir), { recursive: true, force: true });
  }
}

describe('manifest-loader', () => {
  beforeEach(() => {
    invalidateManifestCache();
    cleanupSkills();
  });

  afterEach(() => {
    cleanupSkills();
  });

  describe('AC1: loadManifest returns SkillEntry[]', () => {
    it('scans skills directory and parses frontmatter', () => {
      writeSkill('session-analyst', 'session-analyst', '需求分析、产出 spec/SDD、AC 形式化');
      writeSkill('tdd-red', 'tdd-red', '测试契约设计、RED 阶段');
      writeSkill('code-review', 'code-review', '代码审查、多维度质量检查');

      const skills = loadManifest();
      expect(skills.length).toBe(3);

      for (const s of skills) {
        expect(s.name).toBeDefined();
        expect(s.description).toBeDefined();
        expect(s.path).toContain('/SKILL.md');
      }
    });

    it('extracts name and description from frontmatter', () => {
      writeSkill('session-analyst', 'session-analyst', '需求分析、产出 spec/SDD、AC 形式化');

      const skills = loadManifest();
      const analyst = skills.find(s => s.name === 'session-analyst');
      expect(analyst).toBeDefined();
      expect(analyst!.path).toBe('session-analyst/SKILL.md');
      expect(analyst!.description).toContain('需求分析');
    });

    it('skips directories without SKILL.md', () => {
      writeSkill('valid-skill', 'valid-skill', '有效 Skill');
      fs.mkdirSync(path.join(testSkillsDir, 'no-skill-file'), { recursive: true });

      const skills = loadManifest();
      expect(skills.length).toBe(1);
      expect(skills[0].name).toBe('valid-skill');
    });

    it('skips SKILL.md without valid frontmatter', () => {
      const dir = path.join(testSkillsDir, 'bad-frontmatter');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '# No frontmatter here', 'utf-8');

      writeSkill('valid-skill', 'valid-skill', '有效 Skill');

      const skills = loadManifest();
      expect(skills.length).toBe(1);
      expect(skills[0].name).toBe('valid-skill');
    });

    it('handles missing skills directory gracefully (returns [])', () => {
      process.env.SKILLS_DIR = '/tmp/nonexistent-skills-dir';
      invalidateManifestCache();

      const skills = loadManifest();
      expect(skills).toEqual([]);

      process.env.SKILLS_DIR = testSkillsDir;
    });

    it('caches result on repeated calls', () => {
      writeSkill('test-skill', 'test-skill', '测试 Skill');

      const first = loadManifest();
      const second = loadManifest();
      expect(first).toBe(second); // Same reference (cached)
    });

    it('invalidates cache on demand', () => {
      writeSkill('test-skill', 'test-skill', '测试 Skill');

      const first = loadManifest();
      invalidateManifestCache();
      const second = loadManifest();
      expect(first).not.toBe(second); // Different references
      expect(first.length).toBe(second.length); // Same content
    });
  });

  describe('getSkillFilePath', () => {
    it('returns absolute path', () => {
      const entry = { name: 'foo', path: 'foo/SKILL.md', description: 'test' };
      const absPath = getSkillFilePath(entry);
      expect(absPath).toContain('foo/SKILL.md');
      expect(path.isAbsolute(absPath)).toBe(true);
    });
  });
});
