/**
 * SkillLoaderService tests
 *
 * #73: DB-driven loading
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

// Mock prisma
const mockPrismaSkill = {
  findFirst: vi.fn(),
  findMany: vi.fn(),
};

vi.mock('@dommaker/studio-prisma', () => ({
  prisma: { skill: mockPrismaSkill },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

// Import after mocks
const { SkillLoaderService, skillLoaderService } = await import('../skill-loader.js');

describe('SkillLoaderService', () => {
  let service: SkillLoaderService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new SkillLoaderService();
    // Clear all sessions
    service.clearSession('test-session');
    service.clearSession('session-1');
    service.clearSession('session-2');
  });

  // ── #73: DB-driven loading ──

  describe('loadSkill (#73)', () => {
    it('should load a skill from DB', async () => {
      mockPrismaSkill.findFirst.mockResolvedValue({
        id: 'skill-1',
        name: 'tdd-workflow',
        description: 'TDD workflow',
        prompt: '## TDD\nWrite tests first',
        trigger: 'goal_start',
        agentTypes: '["executor"]',
        tier: 'fast',
        tools: '["Read", "Bash"]',
        required: null,
        status: 'published',
      });

      const loaded = await service.loadSkill({
        sessionId: 'test-session',
        skillName: 'tdd-workflow',
        agentType: 'executor',
      });

      expect(loaded).not.toBeNull();
      expect(loaded!.name).toBe('tdd-workflow');
      expect(loaded!.prompt).toBe('## TDD\nWrite tests first');
      expect(loaded!.tools).toEqual(['Read', 'Bash']);
      expect(loaded!.tier).toBe('fast');
      expect(mockPrismaSkill.findFirst).toHaveBeenCalledWith({
        where: { name: 'tdd-workflow', status: 'published' },
      });
    });

    it('should return null if skill not found', async () => {
      mockPrismaSkill.findFirst.mockResolvedValue(null);

      const loaded = await service.loadSkill({
        sessionId: 'test-session',
        skillName: 'nonexistent',
      });

      expect(loaded).toBeNull();
    });

    it('should return cached skill if already loaded', async () => {
      mockPrismaSkill.findFirst.mockResolvedValue({
        id: 'skill-1',
        name: 'tdd-workflow',
        prompt: 'test',
        tools: null,
        tier: 'fast',
        required: null,
        status: 'published',
      });

      await service.loadSkill({ sessionId: 'test-session', skillName: 'tdd-workflow' });
      const second = await service.loadSkill({ sessionId: 'test-session', skillName: 'tdd-workflow' });

      expect(second).not.toBeNull();
      // findFirst called only once (cached on second call)
      expect(mockPrismaSkill.findFirst).toHaveBeenCalledTimes(1);
    });

    it('should load required skills recursively', async () => {
      mockPrismaSkill.findFirst
        .mockResolvedValueOnce({
          id: 'skill-main',
          name: 'main-skill',
          prompt: 'main',
          tools: '["Edit"]',
          tier: 'standard',
          required: '["base-skill"]',
          status: 'published',
        })
        .mockResolvedValueOnce({
          id: 'skill-base',
          name: 'base-skill',
          prompt: 'base',
          tools: '["Read"]',
          tier: 'fast',
          required: null,
          status: 'published',
        });

      const loaded = await service.loadSkill({
        sessionId: 'test-session',
        skillName: 'main-skill',
      });

      expect(loaded).not.toBeNull();
      expect(mockPrismaSkill.findFirst).toHaveBeenCalledTimes(2);

      // Both should be in session
      const sessionSkills = service.getSessionSkills('test-session');
      expect(sessionSkills).toHaveLength(2);
      expect(sessionSkills.map(s => s.name)).toContain('base-skill');
      expect(sessionSkills.map(s => s.name)).toContain('main-skill');
    });
  });

  // ── #75: load/unload lifecycle ──

  describe('unloadSkill (#75)', () => {
    it('should unload a skill from session', async () => {
      mockPrismaSkill.findFirst.mockResolvedValue({
        id: 'skill-1',
        name: 'test-skill',
        prompt: 'test prompt',
        tools: '["Read"]',
        tier: 'fast',
        required: null,
        status: 'published',
      });

      await service.loadSkill({ sessionId: 'test-session', skillName: 'test-skill' });
      expect(service.getSessionSkills('test-session')).toHaveLength(1);

      const removed = service.unloadSkill({ sessionId: 'test-session', skillName: 'test-skill' });
      expect(removed).toBe(true);
      expect(service.getSessionSkills('test-session')).toHaveLength(0);
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
    it('should load matching skills from DB', async () => {
      const tddSkill = {
        id: 's1',
        name: 'tdd-workflow',
        prompt: 'tdd',
        trigger: 'goal_start',
        agentTypes: '["executor"]',
        tier: 'fast',
        tools: '["Read"]',
        required: null,
        status: 'published',
      };
      const constraintsSkill = {
        id: 's2',
        name: 'behaviour-constraints',
        prompt: 'constraints',
        trigger: 'always',
        agentTypes: '["executor"]',
        tier: 'fast',
        tools: null,
        required: null,
        status: 'published',
      };
      const reviewSkill = {
        id: 's3',
        name: 'review-skill',
        prompt: 'review',
        trigger: 'review',
        agentTypes: '["reviewer"]',
        tier: 'standard',
        tools: null,
        required: null,
        status: 'published',
      };

      mockPrismaSkill.findMany.mockResolvedValue([tddSkill, constraintsSkill, reviewSkill]);
      // loadSkill calls findFirst for each matched skill
      mockPrismaSkill.findFirst
        .mockResolvedValueOnce(tddSkill)
        .mockResolvedValueOnce(constraintsSkill);

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
    });

    it('should filter by tier threshold', async () => {
      const premiumSkill = {
        id: 's1',
        name: 'premium-skill',
        prompt: 'premium',
        trigger: 'always',
        agentTypes: '[]',
        tier: 'premium',
        tools: null,
        required: null,
        status: 'published',
      };

      mockPrismaSkill.findMany.mockResolvedValue([premiumSkill]);

      const fastLoaded = await service.loadForSession({
        sessionId: 'session-1',
        trigger: 'goal_start',
        agentType: 'executor',
        tier: 'fast',
      });
      expect(fastLoaded).toHaveLength(0);

      // For premium tier, loadSkill will be called
      mockPrismaSkill.findFirst.mockResolvedValueOnce(premiumSkill);
      const premiumLoaded = await service.loadForSession({
        sessionId: 'session-2',
        trigger: 'goal_start',
        agentType: 'executor',
        tier: 'premium',
      });
      expect(premiumLoaded).toHaveLength(1);
    });
  });

  describe('session management', () => {
    it('should get combined prompt from loaded skills', async () => {
      mockPrismaSkill.findFirst.mockResolvedValue({
        id: 's1',
        name: 'test-skill',
        prompt: '## Section 1',
        tools: null,
        tier: 'fast',
        required: null,
        status: 'published',
      });

      await service.loadSkill({ sessionId: 'test-session', skillName: 'test-skill' });
      const prompt = service.getSessionPrompt('test-session');
      expect(prompt).toContain('## Section 1');
    });

    it('should return empty string for empty session', () => {
      expect(service.getSessionPrompt('empty-session')).toBe('');
    });

    it('should clear session on unload of last skill', async () => {
      mockPrismaSkill.findFirst.mockResolvedValue({
        id: 's1',
        name: 'test-skill',
        prompt: 'test',
        tools: null,
        tier: 'fast',
        required: null,
        status: 'published',
      });

      await service.loadSkill({ sessionId: 'test-session', skillName: 'test-skill' });
      expect(service.getActiveSessionCount()).toBeGreaterThan(0);

      service.unloadSkill({ sessionId: 'test-session', skillName: 'test-skill' });
      // Session should be cleaned up
      expect(service.getSessionSkills('test-session')).toHaveLength(0);
    });

    it('should clear entire session', async () => {
      mockPrismaSkill.findFirst.mockResolvedValue({
        id: 's1',
        name: 'skill-a',
        prompt: 'a',
        tools: null,
        tier: 'fast',
        required: null,
        status: 'published',
      });

      await service.loadSkill({ sessionId: 'test-session', skillName: 'skill-a' });
      service.clearSession('test-session');
      expect(service.getSessionSkills('test-session')).toHaveLength(0);
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
      mockPrismaSkill.findFirst.mockResolvedValue({
        id: 's1',
        name: 'tool-skill',
        prompt: 'test',
        tools: '["Read", "Edit", "WebFetch"]',
        tier: 'premium',
        required: null,
        status: 'published',
      });

      await service.loadSkill({ sessionId: 'test-session', skillName: 'tool-skill' });

      // At fast tier, only Read should be allowed
      const fastTools = service.getSessionTools('test-session', 'fast');
      expect(fastTools).toEqual(['Read']);

      // At standard tier, Read + Edit
      const standardTools = service.getSessionTools('test-session', 'standard');
      expect(standardTools).toContain('Read');
      expect(standardTools).toContain('Edit');
      expect(standardTools).not.toContain('WebFetch');

      // At premium tier, all three
      const premiumTools = service.getSessionTools('test-session', 'premium');
      expect(premiumTools).toContain('Read');
      expect(premiumTools).toContain('Edit');
      expect(premiumTools).toContain('WebFetch');
    });
  });

  // ── .md file-based loading (S1-1) ──

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
      fs.writeFileSync(path.join(testSkillsDir, 'file-skill.md'), mdContent);
    });

    afterEach(() => {
      try { fs.unlinkSync(path.join(testSkillsDir, 'file-skill.md')); } catch {}
    });

    it('should load skill from .md file', async () => {
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

    it('should prefer .md file over Prisma', async () => {
      mockPrismaSkill.findFirst.mockResolvedValue({
        id: 'db-skill',
        name: 'file-skill',
        prompt: 'from DB',
        tools: null,
        tier: 'standard',
        required: null,
        status: 'published',
      });

      const freshService = new SkillLoaderService();
      const loaded = await freshService.loadSkill({
        sessionId: 'precedence-test',
        skillName: 'file-skill',
      });

      expect(loaded).not.toBeNull();
      expect(loaded!.skillId).toBe('file:file-skill');
      expect(loaded!.prompt).toContain('## Test Skill');
      // Prisma should NOT be called since file was found
      expect(mockPrismaSkill.findFirst).not.toHaveBeenCalled();
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
