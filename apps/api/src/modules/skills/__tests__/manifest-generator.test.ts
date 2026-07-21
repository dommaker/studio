/**
 * manifest-generator 测试
 *
 * - generateManifest() 从 SKILL.md frontmatter 重新生成 MANIFEST.md
 * - GENERATED 头、active skills 表格（name/description/agentTypes/triggers）、开发流程链、_deprecated 列表
 * - best-effort：空目录/异常不 throw
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Isolated test skills dir（SKILLS_DIR 在模块加载时读取，必须先设再 import）
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'manifest-gen-test-'));
process.env.SKILLS_DIR = testSkillsDir;

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { generateManifest } = await import('../manifest-generator.js');
const { invalidateManifestCache } = await import('../manifest-loader.js');

const MANIFEST_PATH = path.join(testSkillsDir, 'MANIFEST.md');

function writeSkill(dirName: string, frontmatterLines: string[]) {
  const dir = path.join(testSkillsDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\n${frontmatterLines.join('\n')}\n---\n\n# ${dirName}\n`,
    'utf-8',
  );
}

function cleanup() {
  for (const item of fs.readdirSync(testSkillsDir)) {
    fs.rmSync(path.join(testSkillsDir, item), { recursive: true, force: true });
  }
}

beforeEach(() => {
  invalidateManifestCache();
  cleanup();
});

afterEach(() => {
  cleanup();
});

describe('generateManifest', () => {
  it('regenerates MANIFEST.md with header, chain, active table and deprecated list', () => {
    writeSkill('design-analyst', [
      'name: design-analyst',
      'description: "把模糊需求变成结构化设计文档"',
      'agentTypes: [design, analysis]',
      'triggers: [需求分析, 设计探索, design spec]',
      'status: published',
    ]);
    writeSkill('code-review', [
      'name: code-review',
      'description: "代码质量审查"',
      'agentTypes: [review]',
      'triggers: [代码审查, code review]',
      'status: published',
    ]);
    // draft skill：不参与 active 表
    writeSkill('draft-skill', [
      'name: draft-skill',
      'description: "草稿"',
      'status: draft',
    ]);
    // 废弃 skill
    writeSkill('_deprecated/old-skill', [
      'name: old-skill',
      'description: "已废弃的旧 skill"',
    ]);

    generateManifest();

    expect(fs.existsSync(MANIFEST_PATH)).toBe(true);
    const content = fs.readFileSync(MANIFEST_PATH, 'utf-8');

    // GENERATED 头
    expect(content).toContain('GENERATED');
    // 开发流程链
    expect(content).toContain('design-analyst → spec-review-skill → task-planner → sdd-review-skill → tdd-implement → code-review');
    // active 表格行
    expect(content).toContain('`design-analyst/SKILL.md`');
    expect(content).toContain('把模糊需求变成结构化设计文档');
    expect(content).toContain('design, analysis');
    expect(content).toContain('需求分析, 设计探索, design spec');
    expect(content).toContain('`code-review/SKILL.md`');
    // draft 不出现
    expect(content).not.toContain('draft-skill');
    // _deprecated 列表
    expect(content).toContain('`_deprecated/old-skill`');
    expect(content).toContain('已废弃的旧 skill');
  });

  it('shows — for skills without agentTypes/triggers', () => {
    writeSkill('plain-skill', ['name: plain-skill', 'description: "无声明"']);
    generateManifest();
    const content = fs.readFileSync(MANIFEST_PATH, 'utf-8');
    const row = content.split('\n').find(l => l.includes('`plain-skill/SKILL.md`'))!;
    expect(row).toContain('—');
  });

  it('does not throw on empty skills dir', () => {
    expect(() => generateManifest()).not.toThrow();
    expect(fs.existsSync(MANIFEST_PATH)).toBe(true);
  });
});
