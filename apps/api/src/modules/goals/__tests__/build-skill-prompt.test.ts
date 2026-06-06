/**
 * buildSkillPrompt — Skill 模板化 prompt 组装
 *
 * AC:
 * 1. 加载 Skill .md 模板，填充 {{占位符}}
 * 2. {{task}} 替换为实际任务描述
 * 3. {{constraints}} 替换为约束内容
 * 4. {{knowledgeContext}} 替换为知识上下文
 * 5. 无占位符的正文原样返回（向后兼容）
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Use isolated skills dir
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-skill-prompt-'));
process.env.SKILLS_DIR = testSkillsDir;
vi.resetModules();

const { buildSkillPrompt, loadSkillTemplate } = await import('../scheduler-prompt.js');

beforeAll(() => {
  fs.writeFileSync(path.join(testSkillsDir, 'test-skill.md'), `---
name: test-skill
description: "Test skill with placeholders"
trigger: goal_start
agentTypes: [executor]
tier: fast
status: published
---
## 角色
你是 Executor。

## 约束
{{constraints}}

## 知识
{{knowledgeContext}}

## 任务
{{task}}
`);

  fs.writeFileSync(path.join(testSkillsDir, 'static-skill.md'), `---
name: static-skill
description: "Static skill, no placeholders"
trigger: always
agentTypes: [executor]
tier: fast
status: published
---
## 静态指令
不需要替换的内容。
`);
});

afterAll(() => {
  try { fs.unlinkSync(path.join(testSkillsDir, 'test-skill.md')); } catch {}
  try { fs.unlinkSync(path.join(testSkillsDir, 'static-skill.md')); } catch {}
  try { fs.rmdirSync(testSkillsDir); } catch {}
});

describe('buildSkillPrompt', () => {
  it('AC-1: loads template and replaces placeholders', () => {
    const result = buildSkillPrompt('test-skill', {
      task: '实现批量导入功能',
      constraints: '- TDD\n- no any type',
      knowledgeContext: '知识条目: 导入最佳实践',
    });

    expect(result).toContain('## 角色');
    expect(result).toContain('实现批量导入功能');
    expect(result).toContain('TDD');
    expect(result).toContain('导入最佳实践');
    expect(result).not.toContain('{{task}}');
    expect(result).not.toContain('{{constraints}}');
    expect(result).not.toContain('{{knowledgeContext}}');
  });

  it('AC-2: {{task}} replaced with actual task', () => {
    const result = buildSkillPrompt('test-skill', {
      task: 'AC-1: CSV 解析\nAC-2: JSON 导入',
    });
    expect(result).toContain('AC-1: CSV 解析');
    expect(result).toContain('AC-2: JSON 导入');
  });

  it('AC-3: {{constraints}} replaced with constraints', () => {
    const result = buildSkillPrompt('test-skill', {
      constraints: '- 禁止 any type\n- 外科手术式修改',
    });
    expect(result).toContain('禁止 any type');
    expect(result).toContain('外科手术式修改');
  });

  it('AC-4: {{knowledgeContext}} replaced with knowledge', () => {
    const result = buildSkillPrompt('test-skill', {
      knowledgeContext: '相关知识: Prisma 批量写入性能优化',
    });
    expect(result).toContain('Prisma 批量写入性能优化');
  });

  it('AC-5: static skill returned as-is (backward compat)', () => {
    const result = buildSkillPrompt('static-skill', {
      task: 'ignored',
    });
    expect(result).toContain('## 静态指令');
    expect(result).toContain('不需要替换的内容');
    expect(result).not.toContain('{{');
  });

  it('returns empty string for nonexistent skill', () => {
    const result = buildSkillPrompt('nonexistent', {});
    expect(result).toBe('');
  });

  it('unfilled placeholders replaced with empty string', () => {
    const result = buildSkillPrompt('test-skill', {});
    expect(result).not.toContain('{{task}}');
    expect(result).not.toContain('{{constraints}}');
    expect(result).not.toContain('{{knowledgeContext}}');
  });
});

describe('loadSkillTemplate', () => {
  it('returns meta and template body', () => {
    const result = loadSkillTemplate('test-skill');
    expect(result).not.toBeNull();
    expect(result!.meta.name).toBe('test-skill');
    expect(result!.template).toContain('{{task}}');
    expect(result!.template).toContain('{{constraints}}');
  });

  it('returns null for nonexistent skill', () => {
    const result = loadSkillTemplate('nonexistent');
    expect(result).toBeNull();
  });
});
