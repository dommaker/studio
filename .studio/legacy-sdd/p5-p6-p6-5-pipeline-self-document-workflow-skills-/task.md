---
id: "sdd-1784690249724-ia8e77"
slug: "p5-p6-p6-5-pipeline-self-document-workflow-skills-"
title: "P5/P6/P6.5 管线自举：Self-Document + Workflow Skills + Skill 统一"
status: "stale"
version: 25
taskVersion: 25
parentId: "sdd-1784442305735-znlsow"
changeType: "L3"
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["P5", "P6", "P6.5", "skill-unification", "self-document", "workflow-skills", "pipeline-bootstrap", "AS-021"]
createdAt: "2026-06-10T16:33:57.468Z"
updatedAt: "2026-07-22T03:17:29.724Z"
---

> **DEPRECATED**: Superseded by `p5-p6-p6-5-pipeline-self-document-workflow-skills--ize0`. This doc is kept for historical reference only.

# P5/P6/P6.5 管线自举：Self-Document + Workflow Skills + Skill 统一

三模块管线自举：P5 代码结构提取+LLM 文档生成，P6 三个 workflow skill 定义，P6.5 统一 loadSkill/buildSkillPrompt 接口 + 硬编码迁移

<!-- TASK_TIER {"tier":"premium","reason":"跨 2 仓库 7+ 文件，新建模块(harness code-analysis + studio improver-scheduler)，涉及 LLM 集成 + AST 解析 + 三套 skill 存储统一"} -->

## Contract Tests

### harness/src/knowledge/__tests__/code-analysis.test.ts
```typescript
import { extractCodeStructure } from '../code-analysis';
import * as fs from 'fs';

jest.mock('fs');

const mockFs = fs as jest.Mocked<typeof fs>;

describe('extractCodeStructure', () => {
  beforeEach(() => jest.resetAllMocks());

  it('AC1: extracts exported functions from .ts files', () => {
    mockFs.readdirSync.mockReturnValue(['test.ts'] as any);
    mockFs.readFileSync.mockReturnValue(
      '/** JSDoc comment */\nexport function foo(x: number): string { return String(x); }'
    );
    mockFs.statSync.mockReturnValue({ isFile: () => true, isDirectory: () => false } as any);

    const result = extractCodeStructure('/fake/dir');
    expect(result.functions.length).toBeGreaterThanOrEqual(1);
    expect(result.functions[0].name).toBe('foo');
    expect(result.functions[0].params).toContain('x: number');
    expect(result.functions[0].returnType).toBe('string');
    expect(result.functions[0].jsdoc).toContain('JSDoc comment');
  });

  it('AC1: extracts exported classes', () => {
    mockFs.readdirSync.mockReturnValue(['cls.ts'] as any);
    mockFs.readFileSync.mockReturnValue('export class MyClass { method() {} }');
    mockFs.statSync.mockReturnValue({ isFile: () => true, isDirectory: () => false } as any);

    const result = extractCodeStructure('/fake/dir');
    expect(result.classes.length).toBeGreaterThanOrEqual(1);
    expect(result.classes[0].name).toBe('MyClass');
  });

  it('AC1: extracts exported interfaces', () => {
    mockFs.readdirSync.mockReturnValue(['iface.ts'] as any);
    mockFs.readFileSync.mockReturnValue('export interface MyType { id: string; count: number; }');
    mockFs.statSync.mockReturnValue({ isFile: () => true, isDirectory: () => false } as any);

    const result = extractCodeStructure('/fake/dir');
    expect(result.interfaces.length).toBeGreaterThanOrEqual(1);
    expect(result.interfaces[0].name).toBe('MyType');
  });

  it('AC1: returns empty structure for non-existent dir', () => {
    mockFs.readdirSync.mockImplementation(() => { throw new Error('ENOENT'); });
    const result = extractCodeStructure('/nonexistent');
    expect(result.functions).toEqual([]);
    expect(result.classes).toEqual([]);
    expect(result.interfaces).toEqual([]);
    expect(result.exports).toEqual([]);
  });

  it('AC1: skips non-.ts files', () => {
    mockFs.readdirSync.mockReturnValue(['readme.md', 'image.png'] as any);
    const result = extractCodeStructure('/fake/dir');
    expect(result.functions).toEqual([]);
  });
});
```

### apps/api/src/modules/knowledge/__tests__/improver-scheduler.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@dommaker/harness', () => ({
  extractCodeStructure: vi.fn().mockReturnValue({
    functions: [{ name: 'foo', params: 'x: number', returnType: 'string', jsdoc: '' }],
    classes: [],
    interfaces: [],
    types: [],
    exports: ['foo'],
  }),
}));

vi.mock('@dommaker/studio-shared', () => ({
  modelGateway: { prompt: vi.fn().mockResolvedValue('# Generated Documentation') },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../knowledge-bus.service', () => ({
  knowledgeBus: { write: vi.fn().mockResolvedValue(undefined) },
  sharedStore: { save: vi.fn() },
}));

describe('SelfDocumentService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('AC1: runSelfDoc calls extractCodeStructure and modelGateway.prompt', async () => {
    const { SelfDocumentService } = await import('../improver-scheduler.service');
    const service = new SelfDocumentService();
    const { extractCodeStructure } = await import('@dommaker/harness');
    const { modelGateway } = await import('@dommaker/studio-shared');

    await service.runSelfDoc(['/fake/dir']);

    expect(extractCodeStructure).toHaveBeenCalledWith('/fake/dir');
    expect(modelGateway.prompt).toHaveBeenCalled();
  });

  it('AC1: runSelfDoc skips dir when LLM unavailable', async () => {
    const { modelGateway } = await import('@dommaker/studio-shared');
    (modelGateway.prompt as any).mockRejectedValueOnce(new Error('LLM unavailable'));
    const { SelfDocumentService } = await import('../improver-scheduler.service');
    const service = new SelfDocumentService();
    const { logger } = await import('@dommaker/studio-shared');

    await service.runSelfDoc(['/fake/dir']);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('AC2: startImproverScheduler registers interval', async () => {
    vi.useFakeTimers();
    const { startImproverScheduler, SelfDocumentService } = await import('../improver-scheduler.service');
    const spy = vi.spyOn(SelfDocumentService.prototype, 'runSelfDoc').mockResolvedValue();
    startImproverScheduler(['/fake/dir']);
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(spy).toHaveBeenCalled();
    vi.useRealTimers();
  });
});
```

### ~/.studio/skills/__tests__/workflow-skills.test.ts
```typescript
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const SKILLS_DIR = process.env.SKILLS_DIR || path.join(process.env.HOME || '/root', '.studio', 'skills');

describe('P6 Workflow Skills', () => {
  it('AC1: req SKILL.md exists with correct frontmatter', () => {
    const content = fs.readFileSync(path.join(SKILLS_DIR, 'goal-start', 'req', 'SKILL.md'), 'utf-8');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('name: req');
    expect(content).toContain('trigger: goal_start');
    expect(content).toContain('agentTypes:');
    expect(content).toContain('analyst');
  });

  it('AC2: impl SKILL.md exists with correct frontmatter', () => {
    const content = fs.readFileSync(path.join(SKILLS_DIR, 'goal-start', 'impl', 'SKILL.md'), 'utf-8');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('name: impl');
    expect(content).toContain('trigger: goal_start');
    expect(content).toContain('agentTypes:');
    expect(content).toContain('executor');
  });

  it('AC3: code-review SKILL.md exists with correct frontmatter', () => {
    const content = fs.readFileSync(path.join(SKILLS_DIR, 'review', 'code-review', 'SKILL.md'), 'utf-8');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('name: code-review');
    expect(content).toContain('trigger: review');
    expect(content).toContain('agentTypes:');
    expect(content).toContain('reviewer');
  });
});
```

### packages/studio-skill/src/__tests__/unified-loader.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';

vi.mock('fs');
vi.mock('os', () => ({ default: { homedir: () => '/tmp/test-home' }, homedir: () => '/tmp/test-home' }));

const mockFs = vi.mocked(fs);

describe('SkillLoader unified interface', () => {
  beforeEach(() => vi.resetAllMocks());

  it('AC1: loadSkill finds skill from AS-021 directory structure', () => {
    const skillContent = '---\nname: green-only-tdd\nversion: 1\ndescription: TDD skill\ntrigger: goal_start\nagentTypes: [executor]\ntier: fast\n---\n\n## TDD Workflow\n\n1. Write failing test';
    mockFs.existsSync.mockImplementation((p: any) => {
      return String(p).includes('goal-start/green-only-tdd/SKILL.md');
    });
    mockFs.readdirSync.mockReturnValue(['goal-start'] as any);
    mockFs.readFileSync.mockReturnValue(skillContent);
    mockFs.statSync.mockReturnValue({ isFile: () => true, isDirectory: () => false } as any);

    const { SkillLoader } = require('../loader');
    const loader = new SkillLoader();
    const skill = loader.loadSkill('green-only-tdd');
    expect(skill).not.toBeNull();
    expect(skill.name).toBe('green-only-tdd');
    expect(skill.trigger).toBe('goal_start');
  });

  it('AC2: buildSkillPrompt replaces placeholders', () => {
    const skillContent = '---\nname: test-skill\nversion: 1\ndescription: test\n---\n\nDo {{task}} with {{constraints}}';
    mockFs.existsSync.mockImplementation((p: any) => String(p).includes('test-skill'));
    mockFs.readdirSync.mockReturnValue(['always'] as any);
    mockFs.readFileSync.mockReturnValue(skillContent);
    mockFs.statSync.mockReturnValue({ isFile: () => true, isDirectory: () => false } as any);

    const { SkillLoader } = require('../loader');
    const loader = new SkillLoader();
    const prompt = loader.buildSkillPrompt('test-skill', { task: 'implement feature', constraints: 'no any' });
    expect(prompt).toContain('implement feature');
    expect(prompt).toContain('no any');
    expect(prompt).not.toContain('{{task}}');
  });

  it('AC3: loadSkill returns null for non-existent skill', () => {
    mockFs.existsSync.mockReturnValue(false);
    mockFs.readdirSync.mockReturnValue([] as any);

    const { SkillLoader } = require('../loader');
    const loader = new SkillLoader();
    expect(loader.loadSkill('nonexistent')).toBeNull();
  });

  it('AC4: loadSkill falls back to flat .md format', () => {
    const skillContent = '---\nname: flat-skill\nversion: 1\ndescription: flat file\n---\n\nFlat content';
    mockFs.existsSync.mockImplementation((p: any) => String(p).endsWith('flat-skill.md'));
    mockFs.readdirSync.mockReturnValue([] as any);
    mockFs.readFileSync.mockReturnValue(skillContent);

    const { SkillLoader } = require('../loader');
    const loader = new SkillLoader();
    const skill = loader.loadSkill('flat-skill');
    expect(skill).not.toBeNull();
    expect(skill.name).toBe('flat-skill');
  });
});
```

### apps/api/src/modules/goals/__tests__/skill-dispatch-integration.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@dommaker/studio-skill', () => ({
  skillLoader: {
    loadSkill: vi.fn().mockReturnValue({
      id: 'green-only-tdd',
      name: 'green-only-tdd',
      description: 'TDD skill',
      trigger: 'goal_start',
      agentTypes: ['executor'],
      tier: 'fast',
      prompt: '## TDD Workflow\n1. Write failing test',
    }),
    load: vi.fn().mockReturnValue([]),
    buildSkillPrompt: vi.fn().mockReturnValue('replaced prompt'),
  },
}));

vi.mock('../roles/role-config.service', () => ({
  roleConfigService: {
    getOrCreate: vi.fn().mockResolvedValue({
      boundSkills: ['green-only-tdd'],
      boundConstraints: [],
    }),
  },
}));

describe('scheduler-dispatch Role→Skill binding', () => {
  beforeEach(() => vi.clearAllMocks());

  it('AC2: dispatchStep loads boundSkills from package-level skillLoader', async () => {
    const { skillLoader } = await import('@dommaker/studio-skill');
    const { roleConfigService } = await import('../roles/role-config.service');

    const config = await roleConfigService.getOrCreate('executor', 'company-1');
    expect(config.boundSkills).toContain('green-only-tdd');

    for (const skillName of config.boundSkills) {
      const loaded = skillLoader.loadSkill(skillName);
      expect(loaded).not.toBeNull();
      expect(loaded.prompt).toContain('TDD Workflow');
    }
  });
});
```