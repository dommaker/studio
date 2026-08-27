/**
 * Behavioral tests for Skill event emission (S3 post-gap 3c)
 *
 * AC:
 * - saveProposal creates skill → emits knowledge:skill_created { skillName, skillId }
 * - loadSkill succeeds → emits knowledge:skill_used { skillName }
 *
 * 迁移说明（studio-prisma 移除后）：skillStore 为文件存储，此处 mock 掉以隔离真实 ~/.studio。
 * #361：事件经 studio-shared 的 writeStudioEvent 唯一入口落盘（写口内部 FileStore 为
 * 共享包相对导入，包级 mock 拦不到）——事件断言改走 STUDIO_EVENTS_FILE 指向的
 * tmp 隔离文件读真实磁盘行。skill 夹具同理落真实 tmp 目录（不再全局 mock fs，
 * 规避「包级 mock × fs mock」组合下写口静默丢写的 vitest 怪癖）。
 */

import { describe, test, expect, vi, beforeEach, afterAll } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';

// 真实 tmp 隔离目录：SKILLS_DIR（磁盘加载）与 STUDIO_EVENTS_FILE（事件写口）各一份
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-events-'));
const skillsDir = path.join(tmpRoot, 'skills');
const eventsFile = path.join(tmpRoot, 'events.jsonl');
process.env.SKILLS_DIR = skillsDir;
process.env.STUDIO_EVENTS_FILE = eventsFile;
afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  delete process.env.SKILLS_DIR;
  delete process.env.STUDIO_EVENTS_FILE;
});

const { mockAppendJsonl, mockSkillCreate } = vi.hoisted(() => ({
  // 仅服务 review-proposal store 等非事件写口的隔离；事件走真实写口落 STUDIO_EVENTS_FILE
  mockAppendJsonl: vi.fn().mockResolvedValue(undefined),
  mockSkillCreate: vi.fn(),
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

// 文件存储隔离：skillStore 不写真实 ~/.studio（#354：提案存取归 review-proposal 正本）
vi.mock('../skill-store.js', () => ({
  skillStore: { create: mockSkillCreate },
}));

vi.mock('child_process', () => ({ exec: vi.fn() }));

/** 在 SKILLS_DIR 下创建 <name>/SKILL.md 夹具 */
function createSkillFixture(name: string, content: string): void {
  const dir = path.join(skillsDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
}

const SKILL_MD_CONTENT = `---
name: test-skill
description: "Test"
trigger: always
status: published
---
## Test skill body`;

/** 写口为 fire-and-forget（void writeStudioEvent），轮询等待目标事件落盘 */
async function waitForEvent(type: string, timeoutMs = 2000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const rows = fs.readFileSync(eventsFile, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
      const row = [...rows].reverse().find(r => r.type === type);
      if (row) return row;
    } catch { /* 文件尚未创建 */ }
    await new Promise(r => setTimeout(r, 25));
  }
  throw new Error(`event ${type} not written within ${timeoutMs}ms`);
}

describe('Skill event emission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAppendJsonl.mockResolvedValue(undefined);
    mockSkillCreate.mockReturnValue({ id: 'skill-1', name: 'Test Skill' });
    createSkillFixture('test-skill', SKILL_MD_CONTENT);
    // 事件文件按用例清空：waitForEvent 只见本用例写入，不命中前序用例的旧事件
    fs.rmSync(eventsFile, { force: true });
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

    // 事件经 writeStudioEvent 落盘：{ type, source, payload, createdAt } envelope
    const row = await waitForEvent('knowledge:skill_created');
    expect(row.source).toBe('skill-extraction');
    const payload = JSON.parse(row!.payload);
    expect(payload.skillName).toBe('Test Skill');
  });

  test('loadSkill emits knowledge:skill_used', async () => {
    // skill-loader 从磁盘加载（studio-skill 包加载器读 SKILLS_DIR 夹具）
    const { SkillLoaderService } = await import('../../skills/skill-loader.js');
    const loader = new SkillLoaderService();

    const result = await loader.loadSkill({
      sessionId: 'sess-used',
      skillName: 'test-skill',
    });

    // Skill loaded from fixture SKILL.md on disk
    expect(result).not.toBeNull();

    const row = await waitForEvent('knowledge:skill_used');
    const payload = JSON.parse(row!.payload);
    expect(payload.skillName).toBe('test-skill');
  });

  test('#172（#60 决策）：loadSkill 的 skill_used 携带 workUnitId（传入时）+ envelope level=debug', async () => {
    const { SkillLoaderService } = await import('../../skills/skill-loader.js');
    const loader = new SkillLoaderService();

    const result = await loader.loadSkill({
      sessionId: 'sess-wu',
      skillName: 'test-skill',
      workUnitId: 'wu-42',
    });
    expect(result).not.toBeNull();

    const row = await waitForEvent('knowledge:skill_used');
    expect(row.level).toBe('debug'); // knowledge:* 默认 debug 分级（写口按 type 赋级）
    const payload = JSON.parse(row!.payload);
    expect(payload.skillName).toBe('test-skill');
    expect(payload.workUnitId).toBe('wu-42');
  });
});
