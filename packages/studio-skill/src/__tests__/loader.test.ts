import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

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

/** Create a Dirent-like object for readdirSync withFileTypes */
function makeDirent(name: string, isDir: boolean) {
  return { name, isDirectory: () => isDir, isFile: () => !isDir } as fs.Dirent;
}

/** Mock readdirSync to return trigger subdirectory structure */
function mockTriggerDirs(triggers: Record<string, string[]>) {
  const triggerEntries = Object.keys(triggers).map(t => makeDirent(t, true));
  (fs.readdirSync as unknown as { mockImplementation: (fn: any) => void }).mockImplementation(
    (dirPath: string, opts?: any) => {
      const dir = String(dirPath);
      // Top-level: return trigger directories
      if (dir.endsWith('.studio/skills')) {
        return opts?.withFileTypes ? triggerEntries : Object.keys(triggers);
      }
      // Trigger level: return skill directories
      for (const [trigger, skills] of Object.entries(triggers)) {
        if (dir.endsWith(`/${trigger}`)) {
          return opts?.withFileTypes ? skills.map(s => makeDirent(s, true)) : skills;
        }
      }
      return [];
    },
  );
}

import { SkillLoader } from '../loader.js';

const MOCK_SKILL_MD = [
  '---',
  'name: disk-skill',
  'description: from disk',
  'trigger: always',
  'agentTypes: [executor]',
  'tier: fast',
  'status: published',
  '---',
  '## Disk prompt content',
].join('\n');

describe('SkillLoader', () => {
  beforeEach(() => {
    vi.mocked(fs.existsSync).mockReset();
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReset();
    vi.mocked(fs.readdirSync).mockReset();
    (fs.readdirSync as any).mockReturnValue([]);
  });

  describe('public API', () => {
    it('load() returns empty when no skills loaded', () => {
      const loader = new SkillLoader();
      const skills = loader.load({ trigger: 'goal_start', agentType: 'executor', tier: 'fast' });
      expect(skills).toEqual([]);
    });

    it('get() returns undefined for unknown skill', () => {
      const loader = new SkillLoader();
      expect(loader.get('nonexistent')).toBeUndefined();
    });

    it('formatForPrompt() returns empty string for empty list', () => {
      const loader = new SkillLoader();
      expect(loader.formatForPrompt([])).toBe('');
    });

    it('formatForPrompt() formats skill list', () => {
      const loader = new SkillLoader();
      const prompt = loader.formatForPrompt([{
        id: 'test', name: 'Test Skill', description: 'A test',
        trigger: 'always', agentTypes: [], tier: 'fast', prompt: '',
      }]);
      expect(prompt).toContain('Test Skill');
      expect(prompt).toContain('A test');
    });

    it('getFullPrompt() returns null for unknown skill', () => {
      const loader = new SkillLoader();
      expect(loader.getFullPrompt('nonexistent')).toBeNull();
    });
  });

  describe('disk loading with trigger subdirectories', () => {
    it('should load skill from trigger subdirectory', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(MOCK_SKILL_MD);
      mockTriggerDirs({ always: ['disk-skill'] });

      const loader = new SkillLoader();
      loader.init({ skill: { findMany: vi.fn().mockResolvedValue([]) } } as any);
      await new Promise(r => setTimeout(r, 10));

      const skill = loader.get('disk-skill');
      expect(skill).toBeDefined();
      expect(skill!.description).toBe('from disk');
      expect(skill!.trigger).toBe('always');
      expect(skill!.agentTypes).toEqual(['executor']);
      expect(skill!.tier).toBe('fast');
      expect(skill!.prompt).toBe('## Disk prompt content');
    });

    it('should load multiple skills from multiple trigger directories', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        if (String(p).includes('skill-a')) {
          return [
            '---', 'name: skill-a', 'description: A', 'trigger: goal_start',
            'agentTypes: [executor]', 'tier: fast', 'status: published', '---', '## A',
          ].join('\n');
        }
        if (String(p).includes('skill-b')) {
          return [
            '---', 'name: skill-b', 'description: B', 'trigger: review',
            'agentTypes: [reviewer]', 'tier: standard', 'status: published', '---', '## B',
          ].join('\n');
        }
        return '';
      });
      mockTriggerDirs({ 'goal-start': ['skill-a'], review: ['skill-b'] });

      const loader = new SkillLoader();
      loader.init({ skill: { findMany: vi.fn().mockResolvedValue([]) } } as any);
      await new Promise(r => setTimeout(r, 10));

      expect(loader.get('skill-a')).toBeDefined();
      expect(loader.get('skill-b')).toBeDefined();
    });

    it('should skip non-published disk skills', async () => {
      const draftContent = [
        '---', 'name: draft-skill', 'description: draft', 'trigger: always',
        'status: draft', '---', '## Draft',
      ].join('\n');

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(draftContent);
      mockTriggerDirs({ always: ['draft-skill'] });

      const loader = new SkillLoader();
      loader.init({ skill: { findMany: vi.fn().mockResolvedValue([]) } } as any);
      await new Promise(r => setTimeout(r, 10));

      expect(loader.get('draft-skill')).toBeUndefined();
    });

    it('should skip file with empty name', async () => {
      const emptyNameContent = [
        '---', 'name: ', 'description: empty', 'trigger: always',
        'status: published', '---', '## Content',
      ].join('\n');

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(emptyNameContent);
      mockTriggerDirs({ always: ['empty-skill'] });

      const loader = new SkillLoader();
      loader.init({ skill: { findMany: vi.fn().mockResolvedValue([]) } } as any);
      await new Promise(r => setTimeout(r, 10));

      expect(loader.get('empty-skill')).toBeUndefined();
    });

    it('should handle missing frontmatter gracefully', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('No frontmatter here');
      mockTriggerDirs({ always: ['no-front'] });

      const loader = new SkillLoader();
      loader.init({ skill: { findMany: vi.fn().mockResolvedValue([]) } } as any);
      await new Promise(r => setTimeout(r, 10));

      expect(loader.get('no-front')).toBeUndefined();
    });

    it('should return empty when disk dir missing', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const loader = new SkillLoader();
      loader.init({ skill: { findMany: vi.fn().mockResolvedValue([]) } } as any);
      await new Promise(r => setTimeout(r, 10));

      const skills = loader.load({ trigger: 'goal_start', agentType: 'executor', tier: 'fast' });
      expect(skills).toEqual([]);
    });

    it('should load disk skills even without prisma', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(MOCK_SKILL_MD);
      mockTriggerDirs({ always: ['disk-skill'] });

      const loader = new SkillLoader();
      // No init() — prisma is null, but disk loading should still work via refreshCache
      loader.load({ trigger: 'always', agentType: 'executor' });

      const skill = loader.get('disk-skill');
      expect(skill).toBeDefined();
    });
  });

  describe('load() filtering', () => {
    beforeEach(async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        const path = String(p);
        if (path.includes('green-only-tdd')) {
          return [
            '---', 'name: green-only-tdd', 'description: TDD', 'trigger: goal_start',
            'agentTypes: [executor]', 'tier: fast', 'status: published', '---', '## TDD',
          ].join('\n');
        }
        if (path.includes('multi-stance-review')) {
          return [
            '---', 'name: multi-stance-review', 'description: Review', 'trigger: review',
            'agentTypes: [reviewer]', 'tier: standard', 'status: published', '---', '## Review',
          ].join('\n');
        }
        if (path.includes('tool-risk')) {
          return [
            '---', 'name: tool-risk', 'description: Risk', 'trigger: always',
            'agentTypes: [executor]', 'tier: fast', 'status: published', '---', '## Risk',
          ].join('\n');
        }
        if (path.includes('contract-test-writing')) {
          return [
            '---', 'name: contract-test-writing', 'description: Contract', 'trigger: goal_start',
            'agentTypes: [analyst]', 'tier: premium', 'status: published', '---', '## Contract',
          ].join('\n');
        }
        return '';
      });
      mockTriggerDirs({
        'goal-start': ['green-only-tdd', 'contract-test-writing'],
        review: ['multi-stance-review'],
        always: ['tool-risk'],
      });
    });

    it('should filter by trigger', async () => {
      const loader = new SkillLoader();
      loader.init({ skill: { findMany: vi.fn().mockResolvedValue([]) } } as any);
      await new Promise(r => setTimeout(r, 10));

      const skills = loader.load({ trigger: 'goal_start', agentType: 'executor', tier: 'fast' });
      expect(skills.some(s => s.id === 'green-only-tdd')).toBe(true);
      // tool-risk is 'always' trigger, should also be included
      expect(skills.some(s => s.id === 'tool-risk')).toBe(true);
    });

    it('should filter by agentType', async () => {
      const loader = new SkillLoader();
      loader.init({ skill: { findMany: vi.fn().mockResolvedValue([]) } } as any);
      await new Promise(r => setTimeout(r, 10));

      const execSkills = loader.load({ trigger: 'goal_start', agentType: 'executor' });
      expect(execSkills.every(s => s.agentTypes.includes('executor'))).toBe(true);
    });

    it('should filter by tier threshold', async () => {
      const loader = new SkillLoader();
      loader.init({ skill: { findMany: vi.fn().mockResolvedValue([]) } } as any);
      await new Promise(r => setTimeout(r, 10));

      const fastSkills = loader.load({ trigger: 'review', agentType: 'reviewer', tier: 'fast' });
      expect(fastSkills.some(s => s.id === 'multi-stance-review')).toBe(false);

      const standardSkills = loader.load({ trigger: 'review', agentType: 'reviewer', tier: 'standard' });
      expect(standardSkills.some(s => s.id === 'multi-stance-review')).toBe(true);
    });

    it('should respect exclude option', async () => {
      const loader = new SkillLoader();
      loader.init({ skill: { findMany: vi.fn().mockResolvedValue([]) } } as any);
      await new Promise(r => setTimeout(r, 10));

      const skills = loader.load({ trigger: 'goal_start', agentType: 'executor', exclude: ['green-only-tdd'] });
      expect(skills.some(s => s.id === 'green-only-tdd')).toBe(false);
    });
  });

  describe('refreshCache merge priority', () => {
    it('disk skill should override DB skill with same name', async () => {
      const diskContent = [
        '---', 'name: green-only-tdd', 'description: DISK VERSION', 'trigger: goal_start',
        'agentTypes: [executor]', 'tier: fast', 'status: published', '---', '## Disk prompt',
      ].join('\n');

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(diskContent);
      mockTriggerDirs({ 'goal-start': ['green-only-tdd'] });

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

      const loader = new SkillLoader();
      loader.init(mockPrisma as any);
      await new Promise(r => setTimeout(r, 10));

      const skill = loader.get('green-only-tdd');
      expect(skill).toBeDefined();
      expect(skill!.description).toBe('DISK VERSION');
      expect(skill!.prompt).toBe('## Disk prompt');
    });

    it('DB skill should be available when no disk file', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const mockPrisma = {
        skill: {
          findMany: vi.fn().mockResolvedValue([{
            name: 'db-skill',
            description: 'DB ONLY',
            trigger: 'always',
            agentTypes: JSON.stringify(['executor']),
            tier: 'fast',
            tools: null,
            prompt: 'DB prompt',
          }]),
        },
      };

      const loader = new SkillLoader();
      loader.init(mockPrisma as any);
      await new Promise(r => setTimeout(r, 10));

      const skill = loader.get('db-skill');
      expect(skill).toBeDefined();
      expect(skill!.description).toBe('DB ONLY');
    });

    it('disk-only skill (not in DB) should be available', async () => {
      const diskContent = [
        '---', 'name: extra-skill', 'description: extra', 'trigger: always',
        'status: published', '---', '## Extra content',
      ].join('\n');

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(diskContent);
      mockTriggerDirs({ always: ['extra-skill'] });

      const mockPrisma = {
        skill: { findMany: vi.fn().mockResolvedValue([]) },
      };

      const loader = new SkillLoader();
      loader.init(mockPrisma as any);
      await new Promise(r => setTimeout(r, 10));

      const skill = loader.get('extra-skill');
      expect(skill).toBeDefined();
      expect(skill!.description).toBe('extra');
    });

    it('should handle prisma DB error gracefully', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const mockPrisma = {
        skill: { findMany: vi.fn().mockRejectedValue(new Error('DB error')) },
      };

      const loader = new SkillLoader();
      loader.init(mockPrisma as any);
      await new Promise(r => setTimeout(r, 10));

      // Should not crash, cache should be empty
      const skills = loader.load({ trigger: 'goal_start', agentType: 'executor' });
      expect(skills).toEqual([]);
    });
  });
});
