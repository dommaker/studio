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

/** Mock readdirSync to return flat skill directory structure */
function mockSkillDirs(skills: string[]) {
  const entries = skills.map(s => makeDirent(s, true));
  (fs.readdirSync as unknown as { mockImplementation: (fn: any) => void }).mockImplementation(
    (dirPath: string, opts?: any) => {
      const dir = String(dirPath);
      if (dir.endsWith('.studio/skills')) {
        return opts?.withFileTypes ? entries : skills;
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
      const skills = loader.load({ agentType: 'executor', tier: 'fast' });
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
        agentTypes: [], tier: 'fast', prompt: '',
      }]);
      expect(prompt).toContain('Test Skill');
      expect(prompt).toContain('A test');
    });

    it('getFullPrompt() returns null for unknown skill', () => {
      const loader = new SkillLoader();
      expect(loader.getFullPrompt('nonexistent')).toBeNull();
    });

    it('loadSingle() loads a skill from disk and registers it', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(MOCK_SKILL_MD);

      const loader = new SkillLoader();
      const skill = loader.loadSingle('disk-skill');

      expect(skill).not.toBeNull();
      expect(skill!.id).toBe('disk-skill');
      expect(skill!.name).toBe('disk-skill');
      expect(skill!.prompt).toContain('Disk prompt content');

      // Verify it's registered in the internal map
      expect(loader.get('disk-skill')).toBeDefined();
      expect(loader.getFullPrompt('disk-skill')).toContain('Disk prompt content');
    });

    it('loadSingle() returns null for non-existent skill', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const loader = new SkillLoader();
      const skill = loader.loadSingle('nonexistent');

      expect(skill).toBeNull();
      expect(loader.get('nonexistent')).toBeUndefined();
    });

    it('loadSingle() returns null for invalid frontmatter', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('no frontmatter here');

      const loader = new SkillLoader();
      const skill = loader.loadSingle('bad-skill');

      expect(skill).toBeNull();
    });

    it('refresh() forces cache reload from disk', () => {
      const loader = new SkillLoader();

      // Initially no skills on disk
      vi.mocked(fs.existsSync).mockReturnValue(false);
      mockSkillDirs([]);
      loader.refresh();
      expect(loader.load({})).toEqual([]);

      // Now add a skill to disk
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(MOCK_SKILL_MD);
      mockSkillDirs(['disk-skill']);

      // Without refresh, cache is stale
      expect(loader.load({})).toEqual([]);

      // Refresh loads from disk
      loader.refresh();
      const skills = loader.load({});
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe('disk-skill');
    });
  });

  describe('disk loading with skill directories', () => {
    it('should load skill from disk directory', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(MOCK_SKILL_MD);
      mockSkillDirs(['disk-skill']);

      const loader = new SkillLoader();
      loader.init({ skill: { findMany: vi.fn().mockResolvedValue([]) } } as any);
      await new Promise(r => setTimeout(r, 10));

      const skill = loader.get('disk-skill');
      expect(skill).toBeDefined();
      expect(skill!.description).toBe('from disk');
      expect(skill!.agentTypes).toEqual(['executor']);
      expect(skill!.tier).toBe('fast');
      expect(skill!.prompt).toBe('## Disk prompt content');
    });

    it('should load multiple skills from disk directories', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        if (String(p).includes('skill-a')) {
          return [
            '---', 'name: skill-a', 'description: A',
            'agentTypes: [executor]', 'tier: fast', 'status: published', '---', '## A',
          ].join('\n');
        }
        if (String(p).includes('skill-b')) {
          return [
            '---', 'name: skill-b', 'description: B',
            'agentTypes: [reviewer]', 'tier: standard', 'status: published', '---', '## B',
          ].join('\n');
        }
        return '';
      });
      mockSkillDirs(['skill-a', 'skill-b']);

      const loader = new SkillLoader();
      loader.init({ skill: { findMany: vi.fn().mockResolvedValue([]) } } as any);
      await new Promise(r => setTimeout(r, 10));

      expect(loader.get('skill-a')).toBeDefined();
      expect(loader.get('skill-b')).toBeDefined();
    });

    it('should skip non-published disk skills', async () => {
      const draftContent = [
        '---', 'name: draft-skill', 'description: draft',
        'status: draft', '---', '## Draft',
      ].join('\n');

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(draftContent);
      mockSkillDirs(['draft-skill']);

      const loader = new SkillLoader();
      loader.init({ skill: { findMany: vi.fn().mockResolvedValue([]) } } as any);
      await new Promise(r => setTimeout(r, 10));

      expect(loader.get('draft-skill')).toBeUndefined();
    });

    it('should skip file with empty name', async () => {
      const emptyNameContent = [
        '---', 'name: ', 'description: empty',
        'status: published', '---', '## Content',
      ].join('\n');

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(emptyNameContent);
      mockSkillDirs(['empty-skill']);

      const loader = new SkillLoader();
      loader.init({ skill: { findMany: vi.fn().mockResolvedValue([]) } } as any);
      await new Promise(r => setTimeout(r, 10));

      expect(loader.get('empty-skill')).toBeUndefined();
    });

    it('should handle missing frontmatter gracefully', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue('No frontmatter here');
      mockSkillDirs(['no-front']);

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

      const skills = loader.load({ agentType: 'executor', tier: 'fast' });
      expect(skills).toEqual([]);
    });

    it('should load disk skills even without prisma', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(MOCK_SKILL_MD);
      mockSkillDirs(['disk-skill']);

      const loader = new SkillLoader();
      // No init() — prisma is null, but disk loading should still work via refreshCache
      loader.load({ agentType: 'executor' });

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
            '---', 'name: green-only-tdd', 'description: TDD',
            'agentTypes: [executor]', 'tier: fast', 'status: published', '---', '## TDD',
          ].join('\n');
        }
        if (path.includes('multi-stance-review')) {
          return [
            '---', 'name: multi-stance-review', 'description: Review',
            'agentTypes: [reviewer]', 'tier: standard', 'status: published', '---', '## Review',
          ].join('\n');
        }
        if (path.includes('tool-risk')) {
          return [
            '---', 'name: tool-risk', 'description: Risk',
            'agentTypes: [executor]', 'tier: fast', 'status: published', '---', '## Risk',
          ].join('\n');
        }
        if (path.includes('contract-test-writing')) {
          return [
            '---', 'name: contract-test-writing', 'description: Contract',
            'agentTypes: [analyst]', 'tier: premium', 'status: published', '---', '## Contract',
          ].join('\n');
        }
        return '';
      });
      mockSkillDirs(['green-only-tdd', 'multi-stance-review', 'tool-risk', 'contract-test-writing']);
    });

    it('should filter by agentType', async () => {
      const loader = new SkillLoader();
      loader.init({ skill: { findMany: vi.fn().mockResolvedValue([]) } } as any);
      await new Promise(r => setTimeout(r, 10));

      const execSkills = loader.load({ agentType: 'executor' });
      expect(execSkills.every(s => s.agentTypes.includes('executor'))).toBe(true);
    });

    it('should filter by tier threshold', async () => {
      const loader = new SkillLoader();
      loader.init({ skill: { findMany: vi.fn().mockResolvedValue([]) } } as any);
      await new Promise(r => setTimeout(r, 10));

      const fastSkills = loader.load({ agentType: 'reviewer', tier: 'fast' });
      expect(fastSkills.some(s => s.id === 'multi-stance-review')).toBe(false);

      const standardSkills = loader.load({ agentType: 'reviewer', tier: 'standard' });
      expect(standardSkills.some(s => s.id === 'multi-stance-review')).toBe(true);
    });

    it('should respect exclude option', async () => {
      const loader = new SkillLoader();
      loader.init({ skill: { findMany: vi.fn().mockResolvedValue([]) } } as any);
      await new Promise(r => setTimeout(r, 10));

      const skills = loader.load({ agentType: 'executor', exclude: ['green-only-tdd'] });
      expect(skills.some(s => s.id === 'green-only-tdd')).toBe(false);
    });
  });

  describe('refreshCache', () => {
    it('disk-only skill should be available', async () => {
      const diskContent = [
        '---', 'name: extra-skill', 'description: extra',
        'status: published', '---', '## Extra content',
      ].join('\n');

      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue(diskContent);
      mockSkillDirs(['extra-skill']);

      const loader = new SkillLoader();
      loader.init();
      await new Promise(r => setTimeout(r, 10));

      const skill = loader.get('extra-skill');
      expect(skill).toBeDefined();
      expect(skill!.description).toBe('extra');
    });

  });
});
