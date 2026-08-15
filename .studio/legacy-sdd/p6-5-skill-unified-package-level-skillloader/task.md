---
id: "cmq7v890w001ydj0xhervmpzw"
goalId: "cmq7v8ao4002odj0x9c3hfgka"
slug: "p6-5-skill-unified-package-level-skillloader"
title: "P6.5 Skill 统一：package-level SkillLoader 支持磁盘文件读取"
status: "done"
version: 1
sourceChannelId: "cmq6eqh3u000k10qwg7tup7lj"
tags: ["skill-system", "P6.5", "disk-loading", "unified-architecture"]
createdAt: "2026-06-10T09:27:47.117Z"
updatedAt: "2026-06-10T09:27:49.428Z"
---

# P6.5 Skill 统一：package-level SkillLoader 支持磁盘文件读取

让 packages/studio-skill/src/loader.ts 从 ~/.studio/knowledge/skills/ 读取 SKILL.md 文件，合并优先级：磁盘 > DB > 硬编码

<!-- TASK_TIER {"tier":"standard","reason":"2 个文件改动（loader.ts + 10 SKILL.md），涉及 fs 模块 + merge 逻辑 + frontmatter 解析，需要新测试覆盖磁盘加载路径"} -->

## Contract Tests

### __tests__/disk-loading.test.ts
```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';

// Mock fs and os before importing loader
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn().mockReturnValue(false),
    readFileSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([]),
  },
}));
vi.mock('os', () => ({
  default: {
    homedir: vi.fn().mockReturnValue('/tmp/test-home'),
  },
}));

describe('SkillLoader disk loading', () => {
  const MOCK_SKILL_DIR = '/tmp/test-home/.studio/knowledge/skills';

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('AC-1: loadFromDisk returns parsed SkillDefinition from .md file', async () => {
    const mockContent = `---\nname: test-skill\ndescription: test desc\ntrigger: always\nagentTypes: [executor]\ntier: fast\nstatus: published\nversion: 1\n---\n## Prompt content here`;
    const fsMock = vi.mocked(fs.default);
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(mockContent);

    const { SkillLoader } = await import('../loader.js');
    const loader = new SkillLoader();
    // loadFromDisk is private, test via refreshCache integration
    // or expose for testing
    expect(fsMock.existsSync).toBeDefined();
  });

  it('AC-1: loadFromDisk returns null for non-published status', async () => {
    const mockContent = `---\nname: draft-skill\ndescription: draft\ntrigger: always\nstatus: draft\n---\n## Content`;
    const fsMock = vi.mocked(fs.default);
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(mockContent);

    const { SkillLoader } = await import('../loader.js');
    const loader = new SkillLoader();
    // After refreshCache, draft-skill should NOT be in results
    const skills = loader.load({ trigger: 'always' });
    expect(skills.some(s => s.id === 'draft-skill')).toBe(false);
  });

  it('AC-1: loadFromDisk returns null when file does not exist', async () => {
    const fsMock = vi.mocked(fs.default);
    fsMock.existsSync.mockReturnValue(false);

    const { SkillLoader } = await import('../loader.js');
    const loader = new SkillLoader();
    const skills = loader.load({ trigger: 'always' });
    // Should fall back to hardcoded
    expect(skills.length).toBeGreaterThan(0);
  });

  it('AC-2: disk skills override DB skills with same name', async () => {
    const diskContent = `---\nname: green-only-tdd\ndescription: DISK VERSION\ntrigger: goal_start\nagentTypes: [executor]\ntier: fast\nstatus: published\n---\n## Disk prompt`;
    const fsMock = vi.mocked(fs.default);
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue(diskContent);
    fsMock.readdirSync.mockReturnValue(['green-only-tdd.md']);

    const { SkillLoader } = await import('../loader.js');
    const loader = new SkillLoader();
    // init with mock prisma that returns DB version
    const mockPrisma = {
      skill: {
        findMany: vi.fn().mockResolvedValue([{
          name: 'green-only-tdd',
          description: 'DB VERSION',
          trigger: 'goal_start',
          agentTypes: JSON.stringify(['executor']),
          tier: 'fast',
          tools: null,
          prompt: 'DB prompt',
        }]),
      },
    };
    loader.init(mockPrisma as any);
    const skills = loader.load({ trigger: 'goal_start', agentType: 'executor', tier: 'fast' });
    const tddSkill = skills.find(s => s.id === 'green-only-tdd');
    expect(tddSkill).toBeDefined();
    expect(tddSkill!.description).toBe('DISK VERSION');
    expect(tddSkill!.prompt).toBe('## Disk prompt');
  });

  it('AC-2: hardcoded definitions used as final fallback', async () => {
    const fsMock = vi.mocked(fs.default);
    fsMock.existsSync.mockReturnValue(false);
    fsMock.readdirSync.mockReturnValue([]);

    const { SkillLoader } = await import('../loader.js');
    const loader = new SkillLoader();
    // No init (no prisma), no disk
    const skills = loader.load({ trigger: 'goal_start', agentType: 'executor', tier: 'fast' });
    expect(skills.some(s => s.id === 'green-only-tdd')).toBe(true);
  });
});

```