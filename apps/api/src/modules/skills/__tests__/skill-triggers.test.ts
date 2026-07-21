/**
 * triggers / consumers 测试
 *
 * - manifest-loader：解析 triggers/consumers 行内数组
 * - selectSkills：声明了 triggers 的 skill 用 triggers 匹配（替代长 description）；
 *   未声明 triggers 的 skill 保持 description 匹配
 * - consumers 含 'loop' 的 hub-service skill 不参与 selectSkills / selectSkillsWithDomain
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Isolated test skills dir（SKILLS_DIR 在模块加载时读取，必须先设再 import）
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'triggers-test-'));
process.env.SKILLS_DIR = testSkillsDir;

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { loadManifest, invalidateManifestCache } = await import('../manifest-loader.js');
const { selectSkills, selectSkillsWithDomain } = await import('../skill-selector.js');
type SkillEntry = import('../manifest-loader.js').SkillEntry;

function writeSkill(dirName: string, frontmatterLines: string[]) {
  const dir = path.join(testSkillsDir, dirName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\n${frontmatterLines.join('\n')}\n---\n\n# ${dirName}\n`,
    'utf-8',
  );
}

function cleanupSkills() {
  for (const dir of fs.readdirSync(testSkillsDir)) {
    fs.rmSync(path.join(testSkillsDir, dir), { recursive: true, force: true });
  }
}

const entry = (name: string, extra?: Partial<SkillEntry>): SkillEntry => ({
  name,
  path: `${name}/SKILL.md`,
  description: `desc-of-${name}`,
  ...extra,
});

beforeEach(() => {
  invalidateManifestCache();
  cleanupSkills();
});

afterEach(() => {
  cleanupSkills();
});

describe('manifest-loader: triggers/consumers 解析', () => {
  it('parses triggers and consumers inline arrays from frontmatter', () => {
    writeSkill('design-analyst', [
      'name: design-analyst',
      'description: "把模糊需求变成设计文档"',
      'agentTypes: [design, analysis]',
      'triggers: [需求分析, 设计探索, requirement analysis, design spec]',
      'status: published',
    ]);
    writeSkill('knowledge-extraction', [
      'name: knowledge-extraction',
      'description: "从工作产物提取知识"',
      'consumers: [loop]',
      'triggers: [知识提取, knowledge extraction]',
    ]);

    const skills = loadManifest();
    const da = skills.find(s => s.name === 'design-analyst')!;
    expect(da.triggers).toEqual(['需求分析', '设计探索', 'requirement analysis', 'design spec']);
    expect(da.consumers).toBeUndefined();

    const ke = skills.find(s => s.name === 'knowledge-extraction')!;
    expect(ke.consumers).toEqual(['loop']);
    expect(ke.triggers).toEqual(['知识提取', 'knowledge extraction']);
  });

  it('leaves triggers/consumers undefined when absent', () => {
    writeSkill('plain-skill', ['name: plain-skill', 'description: "无 triggers"']);
    const skills = loadManifest();
    expect(skills[0].triggers).toBeUndefined();
    expect(skills[0].consumers).toBeUndefined();
  });
});

describe('selectSkills: triggers 优先于 description', () => {
  it('matches scope against triggers when declared', () => {
    const skills = [
      entry('design-analyst', {
        description: '把模糊需求变成结构化设计文档',
        triggers: ['需求分析', '设计探索', '方案对比', '需求澄清'],
      }),
    ];
    // "需求澄清" 只出现在 triggers 里，description 中没有
    const matched = selectSkills('帮我做需求澄清', skills);
    expect(matched.map(s => s.name)).toContain('design-analyst');
  });

  it('does NOT match description text when triggers are declared', () => {
    const skills = [
      entry('design-analyst', {
        description: '把模糊需求变成结构化设计文档，含风险评估',
        triggers: ['代码审查'],
      }),
    ];
    // scope 只命中 description（"风险评估"），不命中 triggers → 不匹配
    const matched = selectSkills('做一次风险评估', skills);
    expect(matched).toEqual([]);
  });

  it('falls back to description matching when triggers absent', () => {
    const skills = [entry('code-review', { description: '代码审查、多维度质量检查' })];
    const matched = selectSkills('代码审查 PR #1', skills);
    expect(matched.map(s => s.name)).toContain('code-review');
  });
});

describe('consumers: [loop] 排除', () => {
  it('selectSkills excludes loop-consumer skills', () => {
    const skills = [
      entry('knowledge-extraction', {
        description: '知识提取、从事件提取可复用知识',
        triggers: ['知识提取', '提取知识'],
        consumers: ['loop'],
      }),
      entry('design-analyst', { description: '分析需求、产出 spec' }),
    ];
    const matched = selectSkills('提取知识', skills);
    expect(matched.map(s => s.name)).not.toContain('knowledge-extraction');
  });

  it('selectSkillsWithDomain excludes loop-consumer skills from domain match', () => {
    const skills = [
      entry('knowledge-extraction', { agentTypes: ['feature'], consumers: ['loop'] }),
      entry('feature-dev', { agentTypes: ['feature'] }),
    ];
    const matched = selectSkillsWithDomain('', skills, { acceptedTypes: [], wuType: 'feature' });
    const names = matched.map(s => s.name);
    expect(names).toContain('feature-dev');
    expect(names).not.toContain('knowledge-extraction');
  });

  it('selectSkillsWithDomain excludes loop-consumer skills from scope fallback', () => {
    const skills = [
      entry('knowledge-extraction', {
        description: '分析需求、产出 spec/SDD、AC 形式化',
        consumers: ['loop'],
      }),
    ];
    const matched = selectSkillsWithDomain('分析需求：用户认证', skills, { acceptedTypes: [], wuType: 'task' });
    expect(matched).toEqual([]);
  });
});
