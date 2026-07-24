/**
 * Behavioral tests for Skill event emission (S3 post-gap 3c)
 *
 * AC:
 * - saveProposal creates skill → emits knowledge:skill_created { skillName, skillId }
 * - loadSkill succeeds → emits knowledge:skill_used { skillName }
 *
 * 迁移说明（studio-prisma 移除后）：事件通过 FileStore.appendJsonl 写入
 * ~/.studio/logs/studio-events.jsonl；skillStore/proposalStore 为文件存储，
 * 此处 mock 掉以隔离真实 ~/.studio。
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';

// Set SKILLS_DIR before skill-loader module loads
process.env.SKILLS_DIR = path.join(os.tmpdir(), 'skill-events-test');

const { mockAppendJsonl, mockSkillCreate, mockProposalCreate } = vi.hoisted(() => ({
  mockAppendJsonl: vi.fn().mockResolvedValue(undefined),
  mockSkillCreate: vi.fn(),
  mockProposalCreate: vi.fn(),
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    recordDecision: vi.fn(),
    FileStore: vi.fn().mockImplementation(function () { return {
      appendJsonl: mockAppendJsonl,
      getIndex: vi.fn().mockResolvedValue([]),
      upsertSnapshot: vi.fn().mockResolvedValue(undefined),
      appendEvent: vi.fn().mockResolvedValue(undefined),
    }; }),
  };
});

// 文件存储隔离：skillStore / proposalStore 不写真实 ~/.studio
vi.mock('../skill-store.js', () => ({
  skillStore: { create: mockSkillCreate },
}));

vi.mock('../proposal-store.js', () => ({
  proposalStore: { create: mockProposalCreate },
}));

// Mock fs for skill-loader file-based loading
const SKILL_MD_CONTENT = `---
name: test-skill
description: "Test"
trigger: always
tier: standard
status: published
---
## Test skill body`;

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const skillsDir = process.env.SKILLS_DIR || '';
  return {
    ...actual,
    existsSync: vi.fn((p: string) => {
      const ps = String(p);
      if (ps.includes('SKILL.md')) return true;
      if (skillsDir && ps.startsWith(skillsDir)) return true;
      return false;
    }),
    readFileSync: vi.fn((p: string) => {
      if (String(p).includes('SKILL.md')) return SKILL_MD_CONTENT;
      return '';
    }),
    readdirSync: vi.fn((p: string, opts?: { withFileTypes?: boolean }) => {
      const asDirent = (name: string) => ({ name, isDirectory: () => true });
      // Return trigger subdirectories for skills dir scan
      if (skillsDir && String(p) === skillsDir) return [asDirent('always')];
      // Return skill name dirs inside trigger dir
      if (String(p).includes('always')) return [asDirent('test-skill')];
      return [];
    }),
  };
});

vi.mock('child_process', () => ({ exec: vi.fn() }));

describe('Skill event emission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendJsonl.mockResolvedValue(undefined);
    mockSkillCreate.mockReturnValue({ id: 'skill-1', name: 'Test Skill' });
    mockProposalCreate.mockReturnValue({ id: 'sp-1' });
  });

  test('saveProposal emits knowledge:skill_created', async () => {
    const { SkillExtractionService } = await import('../skill-extraction.service.js');
    const service = new SkillExtractionService();

    await service.saveProposal({
      id: 'p1',
      skillId: 's1',
      companyId: 'c1',
      name: 'Test Skill',
      description: 'A test skill',
      category: 'implementation',
      pattern: 'pattern text',
      sourceGoalIds: ['g1'],
      confidence: 0.9,
      status: 'pending',
      createdAt: new Date(),
    });

    // 事件经 FileStore.appendJsonl(STUDIO_EVENTS_JSONL, { type, source, payload, createdAt })
    const skillCreatedCall = mockAppendJsonl.mock.calls.find(
      (c: any[]) => c[1]?.type === 'knowledge:skill_created',
    );
    expect(skillCreatedCall).toBeDefined();
    const payload = JSON.parse(skillCreatedCall[1].payload);
    expect(payload.skillName).toBe('Test Skill');
  });

  test('loadSkill emits knowledge:skill_used', async () => {
    // skill-loader 仅从磁盘加载（loadSkillFromDisk，fs 已 mock），无 DB fallback
    mockAppendJsonl.mockClear();

    const { SkillLoaderService } = await import('../../skills/skill-loader.js');
    const loader = new SkillLoaderService();

    const result = await loader.loadSkill({
      sessionId: 'sess-1',
      skillName: 'test-skill',
    });

    // Skill loaded from mocked SKILL.md on disk
    expect(result).not.toBeNull();

    const skillUsedCall = mockAppendJsonl.mock.calls.find(
      (c: any[]) => c[1]?.type === 'knowledge:skill_used',
    );
    expect(skillUsedCall).toBeDefined();
    const payload = JSON.parse(skillUsedCall[1].payload);
    expect(payload.skillName).toBe('test-skill');
  });
});
