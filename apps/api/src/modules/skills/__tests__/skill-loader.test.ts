/**
 * SkillLoaderService tests
 *
 * #73: File-driven loading
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Isolate from real skill files on disk
const testSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-test-'));
process.env.SKILLS_DIR = testSkillsDir;
// 显式清理：`import * as fs` 走原生命名空间，mkdtemp-cleanup 补丁登记不到（见其头注）
afterAll(() => { fs.rmSync(testSkillsDir, { recursive: true, force: true }); });

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

      // 递归加载验证：删除磁盘文件后 base-skill 仍命中会话缓存
      // （若 required 未递归加载，文件已删 → loadSkill 返回 null）
      removeSkillFile('main-skill');
      removeSkillFile('base-skill');

      const cachedBase = await service.loadSkill({ sessionId: 'test-session', skillName: 'base-skill' });
      expect(cachedBase).not.toBeNull();
      expect(cachedBase!.name).toBe('base-skill');
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
