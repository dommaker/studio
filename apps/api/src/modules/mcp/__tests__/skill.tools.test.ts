/**
 * skill.tools 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖 loadSkill 的两级加载（包内缓存 → 文件加载）与未命中分支。
 * skillLoader / skillLoaderService 动态 import 被 mock。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetFullPrompt = vi.fn();
const mockLoadSkill = vi.fn();

vi.mock('@dommaker/studio-skill', () => ({
  skillLoader: { getFullPrompt: mockGetFullPrompt },
}));

vi.mock('../../skills/skill-loader.js', () => ({
  skillLoaderService: { loadSkill: mockLoadSkill },
}));

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
});
