/**
 * SkillLoaderService tests
 *
 * #73: File-driven loading
 * #75: load/unload lifecycle
 * #76: tier-based tool permission binding
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Isolate from real skill files on disk
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
process.env.SKILLS_DIR = testSkillsDir;

// Create flat skill file: <SKILLS_DIR>/<skillName>/SKILL.md
function createSkillFile(skillName: string, content: string) {
  const dir = path.join(testSkillsDir, skillName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
}

function removeSkillFile(skillName: string) {
  try {
    const dir = path.join(testSkillsDir, skillName);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

// Mock studio-shared — skill-loader 仅需 logger 与 FileStore（事件写入）
// FileStore 保持最小 fake：appendJsonl 不触碰真实 ~/.studio
vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    FileStore: vi.fn().mockImplementation(function () { return {
      appendJsonl: vi.fn().mockResolvedValue(undefined),
    }; }),
  };
});

// Import after mocks
const { SkillLoaderService, skillLoaderService } = await import('../skill-loader.js');

const TDD_SKILL_MD = `---
name: tdd-workflow
description: "TDD workflow"
agentTypes: [executor]
tier: fast
status: published
---
## TDD
Write tests first`;

describe('SkillLoaderService', () => {
  let service: SkillLoaderService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SkillLoaderService();
    service.clearSession('test-session');
    service.clearSession('session-1');
    service.clearSession('session-2');
  });

  // ── #73: File-driven loading ──

  describe('loadSkill (#73)', () => {
    it('should load a skill from disk file', async () => {
      createSkillFile('tdd-workflow', TDD_SKILL_MD);

      const loaded = await service.loadSkill({
        sessionId: 'test-session',
        skillName: 'tdd-workflow',
        agentType: 'executor',
      });

      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('tdd-workflow');
      expect(loaded!.prompt).toContain('## TDD');
      expect(loaded!.tier).toBe('fast');
      expect(loaded!.skillId).toBe('file:tdd-workflow');

      removeSkillFile('tdd-workflow');
    });

    it('should return null if skill not found on disk', async () => {
      const loaded = await service.loadSkill({
        sessionId: 'test-session',
        skillName: 'nonexistent',
      });

      expect(loaded).toBeNull();
    });

    it('should return cached skill if already loaded', async () => {
      createSkillFile('tdd-workflow', TDD_SKILL_MD);

      await service.loadSkill({ sessionId: 'test-session', skillName: 'tdd-workflow' });
      const second = await service.loadSkill({ sessionId: 'test-session', skillName: 'tdd-workflow' });

      expect(second).not.toBeNull();

      removeSkillFile('tdd-workflow');
    });

    it('should load required skills recursively', async () => {
      const mainSkillMd = `---
name: main-skill
description: "Main skill"
agentTypes: [executor]
tier: standard
required: [base-skill]
status: published
---
## Main`;

      const baseSkillMd = `---
name: base-skill
description: "Base skill"
agentTypes: [executor]
tier: fast
status: published
---
## Base`;

      createSkillFile('main-skill', mainSkillMd);
      createSkillFile('base-skill', baseSkillMd);

      const loaded = await service.loadSkill({
        sessionId: 'test-session',
        skillName: 'main-skill',
      });

      expect(loaded).not.toBeNull();

      const sessionSkills = service.getSessionSkills('test-session');
      expect(sessionSkills).toHaveLength(2);
      expect(sessionSkills.map(s => s.name)).toContain('base-skill');
      expect(sessionSkills.map(s => s.name)).toContain('main-skill');

      removeSkillFile('main-skill');
      removeSkillFile('base-skill');
    });
  });

  // ── #75: load/unload lifecycle ──

  describe('unloadSkill (#75)', () => {
    it('should unload a skill from session', async () => {
      createSkillFile('test-skill', `---
name: test-skill
description: "Test"
tier: fast
status: published
---
## Test`);

      await service.loadSkill({ sessionId: 'test-session', skillName: 'test-skill' });
      expect(service.getSessionSkills('test-session')).toHaveLength(1);

      const removed = service.unloadSkill({ sessionId: 'test-session', skillName: 'test-skill' });
      expect(removed).toBe(true);
      expect(service.getSessionSkills('test-session')).toHaveLength(0);

      removeSkillFile('test-skill');
    });

    it('should return false when unloading non-loaded skill', () => {
      const removed = service.unloadSkill({ sessionId: 'test-session', skillName: 'nonexistent' });
      expect(removed).toBe(false);
    });

    it('should return false for non-existent session', () => {
      const removed = service.unloadSkill({ sessionId: 'no-such-session', skillName: 'any' });
      expect(removed).toBe(false);
    });
  });

  describe('session management', () => {
    it('should get combined prompt from loaded skills', async () => {
      createSkillFile('test-skill', `---
name: test-skill
description: "Test"
tier: fast
status: published
---
## Section 1`);

      await service.loadSkill({ sessionId: 'test-session', skillName: 'test-skill' });
      const prompt = service.getSessionPrompt('test-session');
      expect(prompt).toContain('## Section 1');

      removeSkillFile('test-skill');
    });

    it('should return empty string for empty session', () => {
      expect(service.getSessionPrompt('empty-session')).toBe('');
    });

    it('should clear session on unload of last skill', async () => {
      createSkillFile('test-skill', `---
name: test-skill
description: "Test"
tier: fast
status: published
---
## Test`);

      await service.loadSkill({ sessionId: 'test-session', skillName: 'test-skill' });
      expect(service.getActiveSessionCount()).toBeGreaterThan(0);

      service.unloadSkill({ sessionId: 'test-session', skillName: 'test-skill' });
      expect(service.getSessionSkills('test-session')).toHaveLength(0);

      removeSkillFile('test-skill');
    });

    it('should clear entire session', async () => {
      createSkillFile('skill-a', `---
name: skill-a
description: "A"
tier: fast
status: published
---
## A`);

      await service.loadSkill({ sessionId: 'test-session', skillName: 'skill-a' });
      service.clearSession('test-session');
      expect(service.getSessionSkills('test-session')).toHaveLength(0);

      removeSkillFile('skill-a');
    });
  });

  // ── #76: tier-based tool permission binding ──

  describe('tool permissions (#76)', () => {
    it('should return tools for fast tier', () => {
      const tools = service.getToolsForTier('fast');
      expect(tools).toContain('Read');
      expect(tools).toContain('Bash');
      expect(tools).not.toContain('Edit');
      expect(tools).not.toContain('WebFetch');
    });

    it('should return tools for standard tier', () => {
      const tools = service.getToolsForTier('standard');
      expect(tools).toContain('Read');
      expect(tools).toContain('Edit');
      expect(tools).toContain('Write');
      expect(tools).not.toContain('WebFetch');
    });

    it('should return tools for premium tier', () => {
      const tools = service.getToolsForTier('premium');
      expect(tools).toContain('Read');
      expect(tools).toContain('Edit');
      expect(tools).toContain('WebFetch');
      expect(tools).toContain('WebSearch');
    });

    it('should check if tool is allowed for tier', () => {
      expect(service.isToolAllowedForTier('Read', 'fast')).toBe(true);
      expect(service.isToolAllowedForTier('Edit', 'fast')).toBe(false);
      expect(service.isToolAllowedForTier('Edit', 'standard')).toBe(true);
      expect(service.isToolAllowedForTier('WebFetch', 'standard')).toBe(false);
      expect(service.isToolAllowedForTier('WebFetch', 'premium')).toBe(true);
    });

    it('should get session tools filtered by tier', async () => {
      createSkillFile('tool-skill', `---
name: tool-skill
description: "Tools"
tier: premium
tools: [Read, Edit, WebFetch]
status: published
---
## Tools`);

      await service.loadSkill({ sessionId: 'test-session', skillName: 'tool-skill' });

      const fastTools = service.getSessionTools('test-session', 'fast');
      expect(fastTools).toEqual(['Read']);

      const standardTools = service.getSessionTools('test-session', 'standard');
      expect(standardTools).toContain('Read');
      expect(standardTools).toContain('Edit');
      expect(standardTools).not.toContain('WebFetch');

      const premiumTools = service.getSessionTools('test-session', 'premium');
      expect(premiumTools).toContain('Read');
      expect(premiumTools).toContain('Edit');
      expect(premiumTools).toContain('WebFetch');

      removeSkillFile('tool-skill');
    });
  });

  // ── .md file-based loading (flat structure) ──

  describe('file-based loading (.md)', () => {
    const mdContent = `---
name: file-skill
description: "Test skill from file"
agentTypes: [executor]
tier: fast
status: published
---
## Test Skill
This is a test skill loaded from a .md file.`;

    beforeEach(() => {
      createSkillFile('file-skill', mdContent);
    });

    afterEach(() => {
      removeSkillFile('file-skill');
    });

    it('should load skill from flat .md file', async () => {
      const freshService = new SkillLoaderService();
      const loaded = await freshService.loadSkill({
        sessionId: 'file-test',
        skillName: 'file-skill',
        agentType: 'executor',
      });

      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('file-skill');
      expect(loaded!.prompt).toContain('## Test Skill');
      expect(loaded!.tier).toBe('fast');
      expect(loaded!.skillId).toBe('file:file-skill');
    });
  });

  describe('singleton', () => {
    it('should export a singleton instance', () => {
      expect(skillLoaderService).toBeInstanceOf(SkillLoaderService);
    });
  });
});
