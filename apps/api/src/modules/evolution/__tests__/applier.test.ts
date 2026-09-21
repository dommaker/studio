/**
 * Evolution applier 单元测试（E1 约束进化）。
 *
 * 覆盖四类 targetType 的生效写入 + 备份：
 *   - iron-law/guideline → .harness/custom-constraints.yml（amend 文案手术 / 内置
 *     shadow 追加 / new-entry 追加；注释保留、YAML 可解析）
 *   - prompt-template → ~/.studio/prompt-overrides/<templateId>.md
 *   - role-preset → .agents/roles/<name>.yaml（persona 块标量替换 + 写后校验）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import type { EvolutionProposalData } from '@dommaker/studio-shared';
import { applyProposal, amendConstraintMessage, replacePersonaBlock, retireConstraintEntry } from '../applier';
import { resolveEvolutionPaths, type EvolutionPaths } from '../signals';

let tmpDir: string;
let constraintsFile: string;
let rolesDir: string;
let overridesDir: string;
let paths: EvolutionPaths;
let prevEnv: string | undefined;

const CONSTRAINTS_FIXTURE = `# 自定义约束配置 — Studio 项目专属

custom_constraints:

  # 1. MemoryStore 替代 Redis
  no_redis_import:
    id: no_redis_import
    level: iron_law
    rule: "NO REDIS/IREDIS IMPORTS"
    message: "禁止引入 Redis/ioredis 依赖"
    trigger: ["code_implementation"]
    description: "B0-002 已完成迁移"
`;

const ROLE_FIXTURE = `id: developer
name: Developer
description: 代码实现、TDD 流程

capabilities:
  - code-implementation

persona: |
  你是开发者。职责是按 SDD 实现代码，遵循 TDD 流程。
  先写测试用例，再实现功能。

constraints:
  max_concurrent_tasks: 2
`;

function makeProposal(patch: Partial<EvolutionProposalData>): EvolutionProposalData {
  return {
    id: 'EP-0001',
    seq: 1,
    targetType: 'guideline',
    targetId: 'no_redis_import',
    action: 'amend',
    currentText: '',
    proposedText: '新文案',
    rationale: '测试理由',
    evidence: { windowHours: 24, eventCounts: {} },
    status: 'approved',
    source: 'test',
    createdAt: new Date().toISOString(),
    ...patch,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-applier-test-'));
  constraintsFile = path.join(tmpDir, '.harness', 'custom-constraints.yml');
  rolesDir = path.join(tmpDir, '.agents', 'roles');
  overridesDir = path.join(tmpDir, 'prompt-overrides');
  fs.mkdirSync(path.dirname(constraintsFile), { recursive: true });
  fs.mkdirSync(rolesDir, { recursive: true });
  fs.writeFileSync(constraintsFile, CONSTRAINTS_FIXTURE, 'utf-8');
  fs.writeFileSync(path.join(rolesDir, 'developer.yaml'), ROLE_FIXTURE, 'utf-8');
  prevEnv = process.env.STUDIO_PROMPT_OVERRIDES_DIR;
  process.env.STUDIO_PROMPT_OVERRIDES_DIR = overridesDir;
  paths = resolveEvolutionPaths({ constraintsFile, rolesDir, eventsDir: tmpDir, studioEventsFile: path.join(tmpDir, 'events.jsonl'), traceFile: path.join(tmpDir, 'traces.log') });
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.STUDIO_PROMPT_OVERRIDES_DIR;
  else process.env.STUDIO_PROMPT_OVERRIDES_DIR = prevEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('applier: 约束类提案落点已退役（harness 1.10.0 / ADR-0029）', () => {
  it('iron-law 提案 apply 抛错，且不凭空重建 custom-constraints.yml', async () => {
    fs.rmSync(constraintsFile); // 复现生产现状：该文件已随 #606 删除
    await expect(applyProposal(makeProposal({
      targetType: 'iron-law', targetId: 'no_redis_import', action: 'amend',
      constraintChange: 'message', proposedText: '进化版文案',
    }), paths)).rejects.toThrow('落点已退役');
    expect(fs.existsSync(constraintsFile)).toBe(false);
  });

  it('guideline 的 new-entry / retire 变更同样被拒（不写文件、不建备份）', async () => {
    for (const constraintChange of ['new-entry', 'retire'] as const) {
      const before = fs.readFileSync(constraintsFile, 'utf-8');
      await expect(applyProposal(makeProposal({
        targetType: 'guideline', targetId: 'no_redis_import', action: 'add',
        constraintChange, proposedText: 'x',
      }), paths)).rejects.toThrow('落点已退役');
      expect(fs.readFileSync(constraintsFile, 'utf-8')).toBe(before);
    }
    expect(fs.readdirSync(path.dirname(constraintsFile)).filter(f => f.includes('.bak-'))).toEqual([]);
  });

  it('prompt-template 落点不受该闸影响', async () => {
    const result = await applyProposal(makeProposal({
      targetType: 'prompt-template', targetId: 'tpl-a', action: 'amend',
      constraintChange: 'message', proposedText: 'x',
    }), paths);
    expect(result.targetPath).toContain('tpl-a');
  });

  it('amendConstraintMessage returns null for unknown entry', () => {
    expect(amendConstraintMessage(CONSTRAINTS_FIXTURE, 'no_such_entry', 'x')).toBeNull();
  });

  it('retireConstraintEntry null for unknown entry / already-retired entry', () => {
    expect(retireConstraintEntry(CONSTRAINTS_FIXTURE, 'no_such_entry', { at: '2026-08-15T00:00:00.000Z', reason: 'r' })).toBeNull();
    const once = retireConstraintEntry(CONSTRAINTS_FIXTURE, 'no_redis_import', { at: '2026-08-15T00:00:00.000Z', reason: 'r' });
    expect(once).not.toBeNull();
    expect(retireConstraintEntry(once!, 'no_redis_import', { at: '2026-08-16T00:00:00.000Z', reason: 'r2' })).toBeNull();
  });
});

describe('applier: prompt-template → prompt-overrides dir', () => {
  it('writes the override file (no backup when target does not exist)', async () => {
    const result = await applyProposal(makeProposal({
      targetType: 'prompt-template', targetId: 'knowledge.rules-section', action: 'amend',
      proposedText: '## 系统约束\n必须逐条遵守：\n{content}',
    }), paths);

    expect(fs.readFileSync(path.join(overridesDir, 'knowledge.rules-section.md'), 'utf-8'))
      .toBe('## 系统约束\n必须逐条遵守：\n{content}');
    expect(result.backupPath).toBeNull();
  });

  it('backs up a pre-existing override before overwriting', async () => {
    fs.mkdirSync(overridesDir, { recursive: true });
    fs.writeFileSync(path.join(overridesDir, 'knowledge.rules-section.md'), '旧覆盖', 'utf-8');
    const result = await applyProposal(makeProposal({
      targetType: 'prompt-template', targetId: 'knowledge.rules-section', action: 'amend',
      proposedText: '新覆盖',
    }), paths);

    expect(fs.readFileSync(path.join(overridesDir, 'knowledge.rules-section.md'), 'utf-8')).toBe('新覆盖');
    expect(fs.readFileSync(result.backupPath as string, 'utf-8')).toBe('旧覆盖');
  });

  it('rejects path-traversal template ids', async () => {
    await expect(applyProposal(makeProposal({
      targetType: 'prompt-template', targetId: '../evil', action: 'amend', proposedText: 'x',
    }), paths)).rejects.toThrow('invalid template id');
  });
});

describe('applier: role-preset → .agents/roles/<name>.yaml', () => {
  it('replaces the persona block scalar, keeps schema, creates backup', async () => {
    const newPersona = '你是开发者。职责是按 SDD 实现代码。\n近期 bash 多次失败，调用前先验证参数。';
    const result = await applyProposal(makeProposal({
      targetType: 'role-preset', targetId: 'developer', action: 'amend',
      proposedText: newPersona,
    }), paths);

    const parsed = yaml.load(fs.readFileSync(path.join(rolesDir, 'developer.yaml'), 'utf-8')) as Record<string, unknown>;
    expect(parsed.persona).toBe(newPersona);
    expect(parsed.id).toBe('developer');
    expect((parsed.constraints as Record<string, unknown>).max_concurrent_tasks).toBe(2);
    expect(fs.existsSync(result.backupPath as string)).toBe(true);
  });

  it('replacePersonaBlock handles inline persona and missing persona', () => {
    const inline = 'id: x\npersona: "旧"\nname: X\n';
    const out1 = replacePersonaBlock(inline, '新 persona');
    expect((yaml.load(out1) as Record<string, unknown>).persona).toBe('新 persona');
    expect(out1).toContain('name: X');

    const missing = 'id: x\nname: X\n';
    const out2 = replacePersonaBlock(missing, '追加 persona');
    expect((yaml.load(out2) as Record<string, unknown>).persona).toBe('追加 persona');
  });

  it('fails for unknown role file without writing anything', async () => {
    await expect(applyProposal(makeProposal({
      targetType: 'role-preset', targetId: 'ghost', action: 'amend', proposedText: 'x',
    }), paths)).rejects.toThrow('role preset not found');
    expect(fs.existsSync(path.join(rolesDir, 'ghost.yaml'))).toBe(false);
  });
});
