/**
 * prompt-overrides 单元测试（E1 约束进化）。
 *
 * 覆盖：覆盖目录 env 解析、readPromptOverride（缺失/存在/目录穿越防护）、
 * renderWithOverride（无覆盖回退 / {content} 替换 / {count} 替换 / 无占位符追加）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readPromptOverride, renderWithOverride, resolvePromptOverridesDir } from '../prompt-overrides';

let tmpDir: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-overrides-test-'));
  prevEnv = process.env.STUDIO_PROMPT_OVERRIDES_DIR;
  process.env.STUDIO_PROMPT_OVERRIDES_DIR = tmpDir;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.STUDIO_PROMPT_OVERRIDES_DIR;
  else process.env.STUDIO_PROMPT_OVERRIDES_DIR = prevEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('prompt-overrides (E1)', () => {
  it('resolves dir from STUDIO_PROMPT_OVERRIDES_DIR env', () => {
    expect(resolvePromptOverridesDir()).toBe(tmpDir);
  });

  it('readPromptOverride returns null when no override file exists', () => {
    expect(readPromptOverride('knowledge.rules-section')).toBeNull();
  });

  it('readPromptOverride returns file content when present', () => {
    fs.writeFileSync(path.join(tmpDir, 'knowledge.rules-section.md'), '自定义模板 {content}', 'utf-8');
    expect(readPromptOverride('knowledge.rules-section')).toBe('自定义模板 {content}');
  });

  it('readPromptOverride rejects path traversal in templateId', () => {
    expect(readPromptOverride('../etc/passwd')).toBeNull();
    expect(readPromptOverride('a/b')).toBeNull();
    expect(readPromptOverride('..')).toBeNull();
  });

  it('renderWithOverride returns fallback when no override exists', () => {
    expect(renderWithOverride('knowledge.rules-section', '## 系统约束\n- a', { content: '- a' })).toBe('## 系统约束\n- a');
  });

  it('renderWithOverride substitutes {content} placeholder', () => {
    fs.writeFileSync(path.join(tmpDir, 'knowledge.rules-section.md'), '## 强制约束\n{content}\n（以上必须遵守）', 'utf-8');
    expect(renderWithOverride('knowledge.rules-section', '## 系统约束\n- a', { content: '- a' }))
      .toBe('## 强制约束\n- a\n（以上必须遵守）');
  });

  it('renderWithOverride appends dynamic content when override has no {content} placeholder', () => {
    fs.writeFileSync(path.join(tmpDir, 'knowledge.context-section.md'), '## 环境（覆盖版）', 'utf-8');
    expect(renderWithOverride('knowledge.context-section', '## 上下文\n- x', { content: '- x' }))
      .toBe('## 环境（覆盖版）\n- x');
  });

  it('renderWithOverride substitutes {count} placeholder', () => {
    fs.writeFileSync(path.join(tmpDir, 'knowledge.reference-hint.md'), '[参考库共 {count} 条]', 'utf-8');
    expect(renderWithOverride('knowledge.reference-hint', '[知识库: 7 条参考]', { count: 7 }))
      .toBe('[参考库共 7 条]');
  });

  it('renderWithOverride with no placeholders and no vars returns override as-is', () => {
    fs.writeFileSync(path.join(tmpDir, 'knowledge.extract-from-text.md'), '全新的提取 prompt', 'utf-8');
    expect(renderWithOverride('knowledge.extract-from-text', '默认 prompt')).toBe('全新的提取 prompt');
  });
});
