---
id: "sdd-1785165386524-9664yg"
slug: "p5-p6-p6-5-pipeline-self-document-workflow-skills--ize0"
title: "P5/P6/P6.5 管线自举：Self-Document + Workflow Skills + Skill 统一"
status: "stale"
version: 16
taskVersion: 16
parentId: "sdd-1785145839864-w9svzu"
changeType: "L3"
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["P5", "P6", "P6.5", "skill-system", "self-document", "pipeline-bootstrap", "AS-021"]
createdAt: "2026-06-10T16:44:47.809Z"
updatedAt: "2026-07-27T15:16:26.524Z"
---

# P5/P6/P6.5 管线自举：Self-Document + Workflow Skills + Skill 统一

实现三个模块：P5 代码结构提取 + LLM 文档生成（harness 原语 + studio 编排），P6 三个 Workflow Skill（req/impl/review），P6.5 Skill 统一（SKILL.md 迁移 + loader 切换 + 硬编码删除 + proposal 生成）

<!-- TASK_TIER {"tier":"premium","reason":"跨 2 个仓库（harness + studio），新建 harness 原语 + studio 编排服务 + 13 个 SKILL.md 文件 + loader 重写 + definitions 删除，涉及 10+ 文件改动"} -->

## Contract Tests

### harness/src/knowledge/__tests__/extraction.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs', async () => ({
  ...await vi.importActual('fs'),
  readdirSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const { extractCodeStructure } = await import('../extraction.js');
const mockFs = vi.mocked(fs);

describe('extractCodeStructure', () => {
  beforeEach(() => vi.clearAllMocks());

  it('extracts exported functions from .ts files', () => {
    mockFs.readdirSync.mockReturnValue([
      { name: 'utils.ts', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false } as any,
    ]);
    mockFs.readFileSync.mockReturnValue('/** Helper function */\nexport function helper(x: string): void {}');

    const result = extractCodeStructure('/src');
    expect(result.functions.length).toBeGreaterThan(0);
    expect(result.functions[0].name).toBe('helper');
  });

  it('returns empty structure for empty directory', () => {
    mockFs.readdirSync.mockReturnValue([]);
    const result = extractCodeStructure('/empty');
    expect(result.functions).toEqual([]);
    expect(result.classes).toEqual([]);
    expect(result.interfaces).toEqual([]);
  });

  it('skips node_modules and .git directories', () => {
    mockFs.readdirSync.mockReturnValue([
      { name: 'node_modules', isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false } as any,
      { name: 'index.ts', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false } as any,
    ]);
    mockFs.readFileSync.mockReturnValue('export const x = 1;');
    const result = extractCodeStructure('/src');
    // Should not recurse into node_modules
    expect(mockFs.readdirSync).toHaveBeenCalledTimes(1);
  });

  it('handles file read errors gracefully', () => {
    mockFs.readdirSync.mockReturnValue([
      { name: 'bad.ts', isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false } as any,
    ]);
    mockFs.readFileSync.mockImplementation(() => { throw new Error('permission denied'); });
    const result = extractCodeStructure('/src');
    expect(result.files).toEqual([]);
  });
});
```

### apps/api/src/modules/knowledge/__tests__/improver-scheduler.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@dommaker/studio-shared', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../knowledge-bus.service.js', () => ({ knowledgeBus: { write: vi.fn(), search: vi.fn().mockReturnValue([]) } }));

vi.mock('fs', async () => ({ ...await vi.importActual('fs'), existsSync: vi.fn().mockReturnValue(true), writeFileSync: vi.fn(), mkdirSync: vi.fn() }));

describe('ImproverScheduler.runSelfDoc', () => {
  beforeEach(() => vi.clearAllMocks());

  it('generates CONTEXT.md for each directory', async () => {
    // Mock extractCodeStructure + modelGateway
    // Verify knowledgeBus.write called + CONTEXT.md written
  });

  it('handles empty dirs list gracefully', async () => {
    // Verify no errors, no writes
  });

  it('continues on LLM failure for one directory', async () => {
    // Verify other directories still processed
  });
});
```

### packages/studio-skill/src/__tests__/skill-md-files.test.ts
```typescript
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const EXPECTED_SKILLS = [
  { name: 'green-only-tdd', trigger: 'goal-start', agentTypes: ['executor'], tier: 'fast' },
  { name: 'contract-test-writing', trigger: 'goal-start', agentTypes: ['analyst'], tier: 'premium' },
  { name: 'stuck-recovery', trigger: 'goal-continue', agentTypes: ['executor'], tier: 'fast' },
  { name: 'behaviour-constraints', trigger: 'always', agentTypes: ['executor'], tier: 'fast' },
  { name: 'multi-stance-review', trigger: 'review', agentTypes: ['reviewer'], tier: 'standard' },
  { name: 'forensic-review', trigger: 'review', agentTypes: ['reviewer'], tier: 'standard' },
  { name: 'knowledge-extraction', trigger: 'knowledge-extract', agentTypes: ['knowledge_keeper'], tier: 'standard' },
  { name: 'integration-merge', trigger: 'integration', agentTypes: ['executor'], tier: 'standard' },
  { name: 'sub-agent-workflow', trigger: 'sub-agent', agentTypes: ['executor'], tier: 'fast' },
  { name: 'tool-risk', trigger: 'always', agentTypes: ['executor'], tier: 'fast' },
  { name: 'requirement-analysis', trigger: 'goal-start', agentTypes: ['analyst'], tier: 'standard' },
  { name: 'implementation', trigger: 'goal-start', agentTypes: ['executor'], tier: 'standard' },
  { name: 'code-review', trigger: 'review', agentTypes: ['reviewer'], tier: 'standard' },
];

describe('SKILL.md files exist and have valid frontmatter', () => {
  const skillsDir = process.env.SKILLS_DIR || path.join(os.homedir(), '.studio', 'skills');

  for (const skill of EXPECTED_SKILLS) {
    it(`${skill.name}: exists at ${skill.trigger}/${skill.name}/SKILL.md`, () => {
      const filePath = path.join(skillsDir, skill.trigger, skill.name, 'SKILL.md');
      expect(fs.existsSync(filePath)).toBe(true);
    });

    it(`${skill.name}: has valid YAML frontmatter`, () => {
      const filePath = path.join(skillsDir, skill.trigger, skill.name, 'SKILL.md');
      if (!fs.existsSync(filePath)) return;
      const raw = fs.readFileSync(filePath, 'utf-8');
      const match = raw.match(/^---\n([\s\S]*?)\n---/);
      expect(match).toBeTruthy();
      const yaml = match![1];
      expect(yaml).toContain(`name: ${skill.name}`);
      expect(yaml).toContain('version:');
      expect(yaml).toContain('description:');
    });
  }
});
```

### apps/api/src/modules/skills/__tests__/skill-loader-file-only.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';

vi.mock('fs', async () => ({
  ...await vi.importActual('fs'),
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn(),
  readdirSync: vi.fn().mockReturnValue([]),
}));

describe('SkillLoaderService file-based loading', () => {
  it('loadForSession scans trigger subdirectory + always/', async () => {
    // Verify scans ~/.studio/skills/goal-start/ + ~/.studio/skills/always/
  });

  it('no Prisma query is made when loading skills', async () => {
    // Verify prisma.skill.findMany / findFirst NOT called
  });
});
```

### apps/api/src/modules/tools-std/__tests__/skill-md-generation.test.ts
```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';

vi.mock('fs', async () => ({
  ...await vi.importActual('fs'),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  existsSync: vi.fn().mockReturnValue(false),
}));

describe('workflowTypeToTriggerDir', () => {
  it('maps ci_fix to goal-start', () => {
    // expect(workflowTypeToTriggerDir('ci_fix')).toBe('goal-start');
  });
  it('maps pr_review to review', () => {
    // expect(workflowTypeToTriggerDir('pr_review')).toBe('review');
  });
  it('maps unknown to always', () => {
    // expect(workflowTypeToTriggerDir('unknown')).toBe('always');
  });
});

describe('Proposal SKILL.md generation', () => {
  it('approved proposal generates SKILL.md file at correct path', () => {
    // Verify writeFileSync called with correct path
  });
  it('does not overwrite existing SKILL.md file', () => {
    // Verify existsSync check + skip
  });
});
```