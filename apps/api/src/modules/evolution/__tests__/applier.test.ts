/**
 * Evolution applier 单元测试（E1 约束进化）。
 *
 * 覆盖四类 targetType 的生效写入 + 备份：
 *   - iron-law/guideline → #602 D1 落点 .harness/config.yml（M3.2 词表收敛为
 *     retire/disable；M3.3 retire 复用 harness `constraints retire` CLI——
 *     config.yml + constraint-retired-<id> 知识条目都由 harness 写；M3.5 生效后
 *     自动 git commit 留痕，commit 失败降级 warn 不阻断；存量历史词表仍拒绝）
 *   - prompt-template → ~/.studio/prompt-overrides/<templateId>.md
 *   - role-preset → .agents/roles/<name>.yaml（persona 块标量替换 + 写后校验）
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import type { EvolutionProposalData } from '@dommaker/studio-shared';
import { applyProposal, replacePersonaBlock, retireConstraintEntry } from '../applier';
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
  paths = resolveEvolutionPaths({ repoRoot: tmpDir, constraintsFile, rolesDir, eventsDir: tmpDir, studioEventsFile: path.join(tmpDir, 'events.jsonl'), traceFile: path.join(tmpDir, 'traces.log') });
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.STUDIO_PROMPT_OVERRIDES_DIR;
  else process.env.STUDIO_PROMPT_OVERRIDES_DIR = prevEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('applier: 约束类提案（#602 D1：retire 落点 = .harness/config.yml）', () => {
  const configFile = () => path.join(tmpDir, '.harness', 'config.yml');
  const knowledgeFile = (id: string) => path.join(tmpDir, '.harness', 'knowledge', `decision-constraint-retired-${id}.md`);
  const git = (args: string[]) => execFileSync('git', ['-C', tmpDir, ...args], { encoding: 'utf-8' });

  it('retire 复用 harness CLI：config.yml enabled:false + retired 墓碑 + 知识条目，生效集同步缩小', async () => {
    const result = await applyProposal(makeProposal({
      targetType: 'guideline', targetId: 'governance_presence', action: 'amend',
      constraintChange: 'retire', proposedText: '退役（零触发）：traces 全周期无该约束记录',
      evidence: { windowHours: 24, eventCounts: { total: 0, evaluated: 0, fail: 0, failRate: 0 } },
    }), paths);

    const cfg = yaml.load(fs.readFileSync(configFile(), 'utf-8')) as any;
    expect(cfg.constraints.governance_presence.enabled).toBe(false);
    expect(cfg.constraints.governance_presence.retired.at).toBeTruthy();
    expect(cfg.constraints.governance_presence.retired.reason).toContain('零触发');
    // M3.3：知识沉淀由 harness retireConstraint 写（飞轮唯一自动入水口），applier 不自写
    expect(fs.existsSync(knowledgeFile('governance_presence'))).toBe(true);
    // 生效集验证：retire 后 getEffectiveConstraints 不再含该约束
    const { getEffectiveConstraints } = await import('@dommaker/harness');
    expect(getEffectiveConstraints(tmpDir).some(c => c.id === 'governance_presence')).toBe(false);
    expect(result.targetPath).toBe(configFile());
    // M3.5：tmpdir 非 git 仓 → 留痕降级（warn + trail.committed=false），不阻断生效
    expect(result.trail?.committed).toBe(false);
    expect(result.trail?.error).toBeTruthy();
  });

  it('retire 幂等：已退役约束再 apply → detail 报 already retired，文件不变、不再 commit', async () => {
    const proposal = makeProposal({
      targetType: 'guideline', targetId: 'governance_presence', action: 'amend',
      constraintChange: 'retire', proposedText: '退役（零触发）',
    });
    await applyProposal(proposal, paths);
    const before = fs.readFileSync(configFile(), 'utf-8');
    const second = await applyProposal(proposal, paths);
    expect(second.detail).toContain('already retired');
    expect(fs.readFileSync(configFile(), 'utf-8')).toBe(before);
    expect(second.trail).toBeUndefined(); // 未写文件 → 无留痕 commit
  });

  it('disable→retire 升级：仅 disabled 无墓碑不算已退役——走 CLI 补墓碑 + 知识条目', async () => {
    // 先 disable（裸 enabled:false，无 retired 墓碑、无知识条目）
    await applyProposal(makeProposal({
      targetType: 'guideline', targetId: 'governance_presence', action: 'amend',
      constraintChange: 'disable', proposedText: '高噪音临时停用',
    }), paths);
    const afterDisable = fs.readFileSync(configFile(), 'utf-8');
    expect(fs.existsSync(knowledgeFile('governance_presence'))).toBe(false);

    // approve retire 提案：必须真正走 harness CLI 完成退役（墓碑 + 知识沉淀），
    // 不得被「enabled:false 即已退役」的幂等短路堵死（harness CLI 的 already_retired
    // 保护只看 enabled:false，applier 须先摘除裸 disable 条目再 spawn）
    const result = await applyProposal(makeProposal({
      targetType: 'guideline', targetId: 'governance_presence', action: 'amend',
      constraintChange: 'retire', proposedText: '升级退役：观察期满，确认无价值',
    }), paths);

    expect(result.detail).not.toContain('already retired');
    const cfg = yaml.load(fs.readFileSync(configFile(), 'utf-8')) as any;
    expect(cfg.constraints.governance_presence.enabled).toBe(false);
    expect(cfg.constraints.governance_presence.retired?.at).toBeTruthy();
    expect(cfg.constraints.governance_presence.retired?.reason).toContain('升级退役');
    // 飞轮唯一自动入水口：constraint-retired-<id> 知识条目必须落盘
    expect(fs.existsSync(knowledgeFile('governance_presence'))).toBe(true);
    expect(fs.readFileSync(configFile(), 'utf-8')).not.toBe(afterDisable);
    const { getEffectiveConstraints } = await import('@dommaker/harness');
    expect(getEffectiveConstraints(tmpDir).some(c => c.id === 'governance_presence')).toBe(false);
  });

  it('retire 未知约束 id → 抛错且不写文件', async () => {
    await expect(applyProposal(makeProposal({
      targetType: 'guideline', targetId: 'no_such_constraint', action: 'amend',
      constraintChange: 'retire', proposedText: 'x',
    }), paths)).rejects.toThrow('unknown constraint');
    expect(fs.existsSync(configFile())).toBe(false);
  });

  it('disable：config.yml enabled:false 无 retired 墓碑，生效集同步缩小', async () => {
    const result = await applyProposal(makeProposal({
      targetType: 'guideline', targetId: 'governance_presence', action: 'amend',
      constraintChange: 'disable', proposedText: '高噪音临时停用，观察一周',
    }), paths);

    const cfg = yaml.load(fs.readFileSync(configFile(), 'utf-8')) as any;
    expect(cfg.constraints.governance_presence.enabled).toBe(false);
    expect(cfg.constraints.governance_presence.retired).toBeUndefined();
    // disable 无知识条目语义（harness 无 disable 子命令，墓碑/沉淀是 retire 专有）
    expect(fs.existsSync(knowledgeFile('governance_presence'))).toBe(false);
    const { getEffectiveConstraints } = await import('@dommaker/harness');
    expect(getEffectiveConstraints(tmpDir).some(c => c.id === 'governance_presence')).toBe(false);
    expect(result.detail).toContain('disabled');
  });

  it('disable 幂等：已停用再 apply → detail 报 already disabled，文件不变', async () => {
    const proposal = makeProposal({
      targetType: 'guideline', targetId: 'governance_presence', action: 'amend',
      constraintChange: 'disable', proposedText: '临时停用',
    });
    await applyProposal(proposal, paths);
    const before = fs.readFileSync(configFile(), 'utf-8');
    const second = await applyProposal(proposal, paths);
    expect(second.detail).toContain('already disabled');
    expect(fs.readFileSync(configFile(), 'utf-8')).toBe(before);
  });

  it('disable 未知约束 id → 抛错且不写文件', async () => {
    await expect(applyProposal(makeProposal({
      targetType: 'guideline', targetId: 'no_such_constraint', action: 'amend',
      constraintChange: 'disable', proposedText: 'x',
    }), paths)).rejects.toThrow('unknown constraint');
    expect(fs.existsSync(configFile())).toBe(false);
  });

  it('M3.5：git 仓内生效后自动 commit——正文带提案号 + Governance-Approved trailer，只 add config.yml', async () => {
    git(['init']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'user.name', 'Test']);
    fs.writeFileSync(path.join(tmpDir, 'other.txt'), 'v1\n', 'utf-8');
    git(['add', 'other.txt']);
    git(['commit', '-m', 'init']);
    fs.writeFileSync(path.join(tmpDir, 'other.txt'), 'v2-dirty\n', 'utf-8'); // 无关脏改动不得被带入

    const result = await applyProposal(makeProposal({
      id: 'EP-0042', targetType: 'guideline', targetId: 'governance_presence', action: 'amend',
      constraintChange: 'retire', proposedText: '退役（零触发）',
    }), paths);

    expect(result.trail?.committed).toBe(true);
    expect(result.trail?.sha).toBeTruthy();
    const log = git(['log', '-1', '--format=%B']);
    expect(log).toContain('EP-0042');
    expect(log).toContain('Governance-Approved: EP-0042');
    // 只提交 .harness/config.yml 单文件；无关脏文件保持未提交
    const files = git(['show', '--format=', '--name-only', 'HEAD']).trim().split('\n').filter(Boolean);
    expect(files).toEqual(['.harness/config.yml']);
    expect(git(['status', '--porcelain'])).toContain(' M other.txt');
  });

  it('M3.5：commit 失败降级——config.yml 已生效是事实，不抛错、trail 暴露失败', async () => {
    git(['init']);
    // 确定性制造 commit 失败：index.lock 占位使 git add 拒写（不依赖全局 identity 配置有无）
    fs.writeFileSync(path.join(tmpDir, '.git', 'index.lock'), '', 'utf-8');
    const result = await applyProposal(makeProposal({
      targetType: 'guideline', targetId: 'governance_presence', action: 'amend',
      constraintChange: 'retire', proposedText: '退役（零触发）',
    }), paths);

    expect(result.trail?.committed).toBe(false);
    expect(result.trail?.error).toBeTruthy();
    const cfg = yaml.load(fs.readFileSync(configFile(), 'utf-8')) as any;
    expect(cfg.constraints.governance_presence.enabled).toBe(false); // 生效未被阻断
  });

  it('存量历史词表（message/new-entry/exception）落笔前拒绝，且不写任何文件', async () => {
    // M3.2 后词表只剩 retire/disable；构造存量历史提案（类型层绕过）验证运行时闸仍在
    for (const constraintChange of ['message', 'new-entry', 'exception']) {
      await expect(applyProposal(makeProposal({
        targetType: 'guideline', targetId: 'governance_presence', action: 'amend',
        constraintChange: constraintChange as unknown as EvolutionProposalData['constraintChange'], proposedText: 'x',
      }), paths)).rejects.toThrow('落点已退役');
    }
    expect(fs.existsSync(configFile())).toBe(false);
    expect(fs.existsSync(constraintsFile) && fs.readFileSync(constraintsFile, 'utf-8') !== CONSTRAINTS_FIXTURE).toBe(false);
  });

  it('prompt-template 落点不受约束闸影响', async () => {
    const result = await applyProposal(makeProposal({
      targetType: 'prompt-template', targetId: 'tpl-a', action: 'amend',
      proposedText: 'x',
    }), paths);
    expect(result.targetPath).toContain('tpl-a');
  });

  it('retireConstraintEntry（distill 草案渲染复用）null for unknown entry / already-retired entry', () => {
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
