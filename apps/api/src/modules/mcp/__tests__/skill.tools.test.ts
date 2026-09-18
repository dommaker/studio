/**
 * skill.tools 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖 loadSkill 的两级加载（包内缓存 → 文件加载）与未命中分支。
 * skillLoader / skillLoaderService 动态 import 被 mock。
 * skill 度量地基票 A：cache 命中路径也发射 knowledge:skill_used（level=info signal）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetFullPrompt = vi.fn();
const mockLoadSkill = vi.fn();
const mockWriteStudioEvent = vi.fn().mockResolvedValue(true);

vi.mock('@dommaker/studio-skill', () => ({
  skillLoader: { getFullPrompt: mockGetFullPrompt },
}));

vi.mock('../../skills/skill-loader.js', () => ({
  skillLoaderService: { loadSkill: mockLoadSkill },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return { ...actual, writeStudioEvent: mockWriteStudioEvent };
});

import { skillTools } from '../skill.tools.js';

const loadSkill = skillTools[0];

describe('skill.tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('仅导出 loadSkill，schema required=[skillName]', () => {
    expect(skillTools.map(t => t.name)).toEqual(['loadSkill']);
    expect(loadSkill.inputSchema.required).toEqual(['skillName']);
  });

  it('包内命中 → source=cache，不走文件加载', async () => {
    mockGetFullPrompt.mockReturnValue('# TDD Workflow\n...');
    const result = await loadSkill.handler({ skillName: 'tdd-workflow' });
    expect(result).toEqual({ skillName: 'tdd-workflow', content: '# TDD Workflow\n...', source: 'cache' });
    expect(mockLoadSkill).not.toHaveBeenCalled();
  });

  it('包内未命中 → 回退文件加载 source=file', async () => {
    mockGetFullPrompt.mockReturnValue(null);
    mockLoadSkill.mockResolvedValue({ prompt: 'file prompt' });
    const result = await loadSkill.handler({ skillName: 'custom' });
    expect(mockLoadSkill).toHaveBeenCalledWith({
      sessionId: expect.stringMatching(/^mcp-\d+$/),
      skillName: 'custom',
    });
    expect(result).toEqual({ skillName: 'custom', content: 'file prompt', source: 'file' });
  });

  it('两级均未命中 → 返回 not found 错误', async () => {
    mockGetFullPrompt.mockReturnValue(null);
    mockLoadSkill.mockResolvedValue(null);
    const result = await loadSkill.handler({ skillName: 'ghost' });
    expect(result).toEqual({ skillName: 'ghost', error: 'Skill "ghost" not found' });
  });

  it('#172: 携带 workUnitId 时透传到文件加载（skill_used 事件补 WU 归属）', async () => {
    mockGetFullPrompt.mockReturnValue(null);
    mockLoadSkill.mockResolvedValue({ prompt: 'file prompt' });
    await loadSkill.handler({ skillName: 'custom', workUnitId: 'wu-42' });
    expect(mockLoadSkill).toHaveBeenCalledWith(expect.objectContaining({
      skillName: 'custom',
      workUnitId: 'wu-42',
    }));
  });

  it('票A: cache 命中也发射 skill_used（level=info signal，channel=loadSkill，带 workUnitId）', async () => {
    mockGetFullPrompt.mockReturnValue('# TDD Workflow\n...');
    await loadSkill.handler({ skillName: 'tdd-workflow', workUnitId: 'wu-7' });
    expect(mockWriteStudioEvent).toHaveBeenCalledWith('knowledge:skill_used', {
      skillName: 'tdd-workflow',
      workUnitId: 'wu-7',
      channel: 'loadSkill',
    }, expect.objectContaining({ source: 'skill-tools', level: 'info' }));
  });

  it('票A: cache 命中无 workUnitId 也发射（legacy 口径，聚合侧每条计 1）', async () => {
    mockGetFullPrompt.mockReturnValue('# TDD Workflow\n...');
    await loadSkill.handler({ skillName: 'tdd-workflow' });
    expect(mockWriteStudioEvent).toHaveBeenCalledWith('knowledge:skill_used', {
      skillName: 'tdd-workflow',
      channel: 'loadSkill',
    }, expect.objectContaining({ source: 'skill-tools', level: 'info' }));
  });

  it('票A: 两级均未命中 → 不发射 skill_used', async () => {
    mockGetFullPrompt.mockReturnValue(null);
    mockLoadSkill.mockResolvedValue(null);
    await loadSkill.handler({ skillName: 'ghost' });
    expect(mockWriteStudioEvent).not.toHaveBeenCalled();
  });

  it('票A: 文件加载路径不在本层重复发射（skill-loader.ts 已发射，每调用恰好一次）', async () => {
    mockGetFullPrompt.mockReturnValue(null);
    mockLoadSkill.mockResolvedValue({ prompt: 'file prompt' });
    await loadSkill.handler({ skillName: 'custom' });
    expect(mockWriteStudioEvent).not.toHaveBeenCalled();
  });
});
