/**
 * agent.hooks — buildAgentConstraintPrompt 运行时去重（#308）
 *
 * 行为钉：约束正文已在仓内文档正本中时注入短引用而非全量正文。
 * 新模型（docs/adr/2026-08-21-agent-docs-placement-model.md）：正本 = AGENTS.md
 * `PRESERVE:governance` 段；旧模型：CLAUDE.md `HARNESS_CONSTRAINTS` 段。
 * 两者皆无 → 全量注入约束正文。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

vi.mock('../../prompt-injection', () => ({
  formatConstraintsForPrompt: vi.fn(() => 'FULL_CONSTRAINTS_SENTINEL'),
}));

import { buildAgentConstraintPrompt } from '../agent.hooks';

describe('buildAgentConstraintPrompt — 约束注入去重（新落点模型）', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'agent-hooks-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const build = () => buildAgentConstraintPrompt({ operation: 'code_implementation', projectPath: dir } as any);

  it('AGENTS.md 含 PRESERVE:governance 段 → 注入短引用（指 AGENTS.md 治理契约段），不带全量正文', () => {
    writeFileSync(join(dir, 'AGENTS.md'), '# AGENTS.md\n\n<!-- PRESERVE:governance -->\n## 治理契约\n<!-- /PRESERVE:governance -->\n');

    const prompt = build();

    expect(prompt).toContain('AGENTS.md');
    expect(prompt).toContain('治理契约');
    expect(prompt).not.toContain('FULL_CONSTRAINTS_SENTINEL');
  });

  it('旧模型：仅 CLAUDE.md 含 HARNESS_CONSTRAINTS_START 标记 → 注入短引用（指 CLAUDE.md）', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '# CLAUDE.md\n<!-- HARNESS_CONSTRAINTS_START -->\n...rules...\n<!-- HARNESS_CONSTRAINTS_END -->\n');

    const prompt = build();

    expect(prompt).toContain('CLAUDE.md');
    expect(prompt).not.toContain('FULL_CONSTRAINTS_SENTINEL');
  });

  it('CLAUDE.md 薄身（首行 @AGENTS.md 导入）但 AGENTS.md 缺治理段 → 全量注入（约束正文不在仓内文档中）', () => {
    writeFileSync(join(dir, 'CLAUDE.md'), '@AGENTS.md\n\n# 本机运维簿\n');
    writeFileSync(join(dir, 'AGENTS.md'), '# AGENTS.md\n\n## 项目简介\n');

    const prompt = build();

    expect(prompt).toContain('FULL_CONSTRAINTS_SENTINEL');
  });

  it('AGENTS.md 与 CLAUDE.md 均不存在 → 全量注入约束正文', () => {
    const prompt = build();

    expect(prompt).toContain('FULL_CONSTRAINTS_SENTINEL');
  });
});
