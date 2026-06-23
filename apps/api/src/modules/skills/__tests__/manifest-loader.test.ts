/**
 * manifest-loader tests (AS-025 §3.28c-5)
 *
 * AC1: 读取 MANIFEST.md 返回 Skill 列表（name + description）
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Isolated test skills dir
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-test-'));
process.env.SKILLS_DIR = testSkillsDir;

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { loadManifest, invalidateManifestCache, loadSkillContent, getSkillFilePath } = await import('../manifest-loader.js');

function writeManifest(content: string) {
  fs.writeFileSync(path.join(testSkillsDir, 'MANIFEST.md'), content, 'utf-8');
}

const SAMPLE_MANIFEST = `# Skill 索引

\`~/.studio/skills/\` 下每个目录是一个 Skill（SKILL.md）。Agent 读此清单 → 自选 Skill。

## 原子 Skill（Agent Network）

| Skill | 回答的问题 |
|-------|-----------|
| \`session-analyst/SKILL.md\` | 如何分析需求产出 spec 或 SDD |
| \`tdd-red/SKILL.md\` | 如何设计测试契约（RED 阶段方法论）|
| \`tdd-green/SKILL.md\` | 如何用最小代码让测试通过（GREEN 阶段）|
| \`code-review/SKILL.md\` | 如何多维度审查代码质量 |

## 文档质量

| Skill | 回答的问题 |
|-------|-----------|
| \`arch-review-skill/SKILL.md\` | 概念完整性如何 |
| \`sdd-review-skill/SKILL.md\` | 这个设计质量如何（三层一致性）|
| \`spec-review-skill/SKILL.md\` | 这个 spec 可执行吗 |

## 知识引擎

| Skill | 回答的问题 |
|-------|-----------|
| \`knowledge-extraction/SKILL.md\` | 如何从事件提取知识（Loop-trigger：每日自动）|
| \`knowledge-synthesis-skill/SKILL.md\` | 如何跨时间窗口综合模式（Loop-trigger：每周自动）|
| \`knowledge-quality-skill/SKILL.md\` | 知识库健康度如何（语义层审计）|
| \`doc-manager-skill/SKILL.md\` | 如何管理结构化文档（保存进度/创建 spec/更新文档/更新 roadmap）|

## 降级记录

以下 Skill eval 0% 触发率，职责已被现有工具覆盖或转为 pattern 参考文档：

| Skill | 原因 |
|-------|------|
| \`lifecycle-skill/SKILL.md\` | 废弃检测是 CLI 工作，语义矛盾已在 knowledge-quality-skill 覆盖 |
| \`skill-design-skill/SKILL.md\` | 设计讨论是抽象对话 |
`;

describe('manifest-loader', () => {
  beforeEach(() => {
    invalidateManifestCache();
  });

  afterEach(() => {
    try {
      fs.unlinkSync(path.join(testSkillsDir, 'MANIFEST.md'));
    } catch {}
  });

  describe('AC1: loadManifest returns SkillEntry[]', () => {
    it('parses all active skills from MANIFEST.md', () => {
      writeManifest(SAMPLE_MANIFEST);
      const skills = loadManifest();

      // Should include skills from all active sections (not 降级记录)
      expect(skills.length).toBe(11);

      // Each entry has name + question
      for (const s of skills) {
        expect(s.name).toBeDefined();
        expect(s.question).toBeDefined();
        expect(s.path).toContain('/SKILL.md');
      }
    });

    it('extracts name (directory) and path correctly', () => {
      writeManifest(SAMPLE_MANIFEST);
      const skills = loadManifest();

      const analyst = skills.find(s => s.name === 'session-analyst');
      expect(analyst).toBeDefined();
      expect(analyst!.path).toBe('session-analyst/SKILL.md');
      expect(analyst!.question).toContain('分析需求');
    });

    it('excludes deprecated skills from 降级记录 section', () => {
      writeManifest(SAMPLE_MANIFEST);
      const skills = loadManifest();
      const names = skills.map(s => s.name);

      expect(names).not.toContain('lifecycle-skill');
      expect(names).not.toContain('skill-design-skill');
    });

    it('handles missing MANIFEST.md gracefully (returns [])', () => {
      // Don't write manifest
      const skills = loadManifest();
      expect(skills).toEqual([]);
    });

    it('handles malformed rows (missing backticks) gracefully', () => {
      const malformed = `# Skill 索引

## Section

| Skill | 回答的问题 |
|-------|-----------|
| \`valid-skill/SKILL.md\` | Valid description |
| not-a-skill | No backticks |
`;
      writeManifest(malformed);
      const skills = loadManifest();
      expect(skills.length).toBe(1);
      expect(skills[0].name).toBe('valid-skill');
    });

    it('caches result on repeated calls', () => {
      writeManifest(SAMPLE_MANIFEST);
      const first = loadManifest();
      const second = loadManifest();
      expect(first).toBe(second); // Same reference (cached)
    });

    it('invalidates cache on demand', () => {
      writeManifest(SAMPLE_MANIFEST);
      const first = loadManifest();
      invalidateManifestCache();
      const second = loadManifest();
      expect(first).not.toBe(second); // Different references
      expect(first.length).toBe(second.length); // Same content
    });
  });

  describe('AC3: loadSkillContent reads SKILL.md full text', () => {
    it('returns SKILL.md content for valid entry', () => {
      // Create a SKILL.md file
      const dir = path.join(testSkillsDir, 'test-skill');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), '# Test Skill\nContent here');

      const entry = { name: 'test-skill', path: 'test-skill/SKILL.md', question: 'test' };
      const content = loadSkillContent(entry);
      expect(content).toBe('# Test Skill\nContent here');

      // Cleanup
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns null for missing SKILL.md', () => {
      const entry = { name: 'nonexistent', path: 'nonexistent/SKILL.md', question: 'test' };
      const content = loadSkillContent(entry);
      expect(content).toBeNull();
    });

    it('getSkillFilePath returns absolute path', () => {
      const entry = { name: 'foo', path: 'foo/SKILL.md', question: 'test' };
      const absPath = getSkillFilePath(entry);
      expect(absPath).toContain('foo/SKILL.md');
      expect(path.isAbsolute(absPath)).toBe(true);
    });
  });
});
