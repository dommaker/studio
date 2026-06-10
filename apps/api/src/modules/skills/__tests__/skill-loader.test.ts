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

// Create trigger subdirectory structure
function createSkillFile(trigger: string, skillName: string, content: string) {
  const dir = path.join(testSkillsDir, trigger, skillName);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
}

function removeSkillFile(trigger: string, skillName: string) {
  try {
    const dir = path.join(testSkillsDir, trigger, skillName);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

// Mock prisma
const mockPrismaSkill = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
};

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: {
    skill: mockPrismaSkill,
    studioEvent: { create: vi.fn().mockResolvedValue({ id: 'mock-evt' }) },
  },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import after mocks
const { SkillLoaderService, skillLoaderService } = await import('../skill-loader.js');

const TDD_SKILL_MD = `---
name: tdd-workflow
description: "TDD workflow"
trigger: goal_start
agentTypes: [executor]
tier: fast
status: published
---
## TDD
Write tests first`;

const CONSTRAINTS_SKILL_MD = `---
name: behaviour-constraints
description: "Always-on constraints"
trigger: always
agentTypes: [executor]
tier: fast
status: published
---
## Constraints
- No any type`;

const REVIEW_SKILL_MD = `---
name: review-skill
description: "Review skill"
trigger: review
agentTypes: [reviewer]
tier: standard
status: published
---
## Review
Read code`;

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
      createSkillFile('goal-start', 'tdd-workflow', TDD_SKILL_MD);

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

      removeSkillFile('goal-start', 'tdd-workflow');
    });

    it('should return null if skill not found on disk', async () => {
      const loaded = await service.loadSkill({
        sessionId: 'test-session',
        skillName: 'nonexistent',
      });

      expect(loaded).toBeNull();
    });

    it('should return cached skill if already loaded', async () => {
      createSkillFile('goal-start', 'tdd-workflow', TDD_SKILL_MD);

      await service.loadSkill({ sessionId: 'test-session', skillName: 'tdd-workflow' });
      const second = await service.loadSkill({ sessionId: 'test-session', skillName: 'tdd-workflow' });

      expect(second).not.toBeNull();

      removeSkillFile('goal-start', 'tdd-workflow');
    });

    it('should load required skills recursively', async () => {
      const mainSkillMd = `---
name: main-skill
description: "Main skill"
trigger: goal_start
agentTypes: [executor]
tier: standard
required: [base-skill]
status: published
---
## Main`;

      const baseSkillMd = `---
name: base-skill
description: "Base skill"
trigger: always
agentTypes: [executor]
tier: fast
status: published
---
## Base`;

      createSkillFile('goal-start', 'main-skill', mainSkillMd);
      createSkillFile('always', 'base-skill', baseSkillMd);

      const loaded = await service.loadSkill({
        sessionId: 'test-session',
        skillName: 'main-skill',
      });

      expect(loaded).not.toBeNull();

      // Both should be in session
      const sessionSkills = service.getSessionSkills('test-session');
      expect(sessionSkills).toHaveLength(2);
      expect(sessionSkills.map(s => s.name)).toContain('base-skill');
      expect(sessionSkills.map(s => s.name)).toContain('main-skill');

      removeSkillFile('goal-start', 'main-skill');
      removeSkillFile('always', 'base-skill');
    });
  });

  // ── #75: load/unload lifecycle ──

  describe('unloadSkill (#75)', () => {
    it('should unload a skill from session', async () => {
      createSkillFile('always', 'test-skill', `---
name: test-skill
description: "Test"
trigger: always
tier: fast
status: published
---
## Test`);

      await service.loadSkill({ sessionId: 'test-session', skillName: 'test-skill' });
      expect(service.getSessionSkills('test-session')).toHaveLength(1);

      const removed = service.unloadSkill({ sessionId: 'test-session', skillName: 'test-skill' });
      expect(removed).toBe(true);
      expect(service.getSessionSkills('test-session')).toHaveLength(0);

      removeSkillFile('always', 'test-skill');
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

  describe('loadForSession (#73 + #75)', () => {
    it('should load matching skills from disk', async () => {
      createSkillFile('goal-start', 'tdd-workflow', TDD_SKILL_MD);
      createSkillFile('always', 'behaviour-constraints', CONSTRAINTS_SKILL_MD);
      createSkillFile('review', 'review-skill', REVIEW_SKILL_MD);

      const loaded = await service.loadForSession({
        sessionId: 'session-1',
        trigger: 'goal_start',
        agentType: 'executor',
        tier: 'fast',
      });

      // Should match tdd-workflow (goal_start) + behaviour-constraints (always)
      // Should NOT match review-skill (review trigger, reviewer agentType)
      expect(loaded).toHaveLength(2);
      expect(loaded.map(s => s.name)).toContain('tdd-workflow');
      expect(loaded.map(s => s.name)).toContain('behaviour-constraints');

      removeSkillFile('goal-start', 'tdd-workflow');
      removeSkillFile('always', 'behaviour-constraints');
      removeSkillFile('review', 'review-skill');
    });

    it('should filter by tier threshold', async () => {
      const premiumMd = `---
name: premium-skill
description: "Premium"
trigger: always
agentTypes: []
tier: premium
status: published
---
## Premium`;

      createSkillFile('always', 'premium-skill', premiumMd);

      const fastLoaded = await service.loadForSession({
        sessionId: 'session-1',
        trigger: 'goal_start',
        agentType: 'executor',
        tier: 'fast',
      });
      expect(fastLoaded).toHaveLength(0);

      const premiumLoaded = await service.loadForSession({
        sessionId: 'session-2',
        trigger: 'goal_start',
        agentType: 'executor',
        tier: 'premium',
      });
      expect(premiumLoaded).toHaveLength(1);

      removeSkillFile('always', 'premium-skill');
    });
  });

  describe('session management', () => {
    it('should get combined prompt from loaded skills', async () => {
      createSkillFile('always', 'test-skill', `---
name: test-skill
description: "Test"
trigger: always
tier: fast
status: published
---
## Section 1`);

      await service.loadSkill({ sessionId: 'test-session', skillName: 'test-skill' });
      const prompt = service.getSessionPrompt('test-session');
      expect(prompt).toContain('## Section 1');

      removeSkillFile('always', 'test-skill');
    });

    it('should return empty string for empty session', () => {
      expect(service.getSessionPrompt('empty-session')).toBe('');
    });

    it('should clear session on unload of last skill', async () => {
      createSkillFile('always', 'test-skill', `---
name: test-skill
description: "Test"
trigger: always
tier: fast
status: published
---
## Test`);

      await service.loadSkill({ sessionId: 'test-session', skillName: 'test-skill' });
      expect(service.getActiveSessionCount()).toBeGreaterThan(0);

      service.unloadSkill({ sessionId: 'test-session', skillName: 'test-skill' });
      expect(service.getSessionSkills('test-session')).toHaveLength(0);

      removeSkillFile('always', 'test-skill');
    });

    it('should clear entire session', async () => {
      createSkillFile('always', 'skill-a', `---
name: skill-a
description: "A"
trigger: always
tier: fast
status: published
---
## A`);

      await service.loadSkill({ sessionId: 'test-session', skillName: 'skill-a' });
      service.clearSession('test-session');
      expect(service.getSessionSkills('test-session')).toHaveLength(0);

      removeSkillFile('always', 'skill-a');
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
      createSkillFile('always', 'tool-skill', `---
name: tool-skill
description: "Tools"
trigger: always
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

      removeSkillFile('always', 'tool-skill');
    });
  });

  // ── .md file-based loading (trigger subdirectories) ──

  describe('file-based loading (.md)', () => {
    const mdContent = `---
name: file-skill
description: "Test skill from file"
trigger: goal_start
agentTypes: [executor]
tier: fast
status: published
---
## Test Skill
This is a test skill loaded from a .md file.`;

    beforeEach(() => {
      createSkillFile('goal-start', 'file-skill', mdContent);
    });

    afterEach(() => {
      removeSkillFile('goal-start', 'file-skill');
    });

    it('should load skill from .md file in trigger subdirectory', async () => {
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

    it('should load from .md in loadForSession', async () => {
      const freshService = new SkillLoaderService();
      const loaded = await freshService.loadForSession({
        sessionId: 'session-file',
        trigger: 'goal_start',
        agentType: 'executor',
        tier: 'fast',
      });

      expect(loaded.some(s => s.name === 'file-skill')).toBe(true);
    });
  });

  describe('singleton', () => {
    it('should export a singleton instance', () => {
      expect(skillLoaderService).toBeInstanceOf(SkillLoaderService);
    });
  });
});
