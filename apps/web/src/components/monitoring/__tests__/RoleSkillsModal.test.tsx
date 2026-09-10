// RoleSkillsModal — #462：角色 skill 多选编辑（候选 = GET /skills/manifest，保存 = PATCH /agent-profiles/:id {skills}）
// role.skills 是注入索引候选（与 WU +skill 点名同权，见 skill-selector.selectSkillsForInjection）；
// acceptedTypes 不进 UI（数据模型保留做长尾排序/子单 type 推导）。
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const { mockUpdateAgent, mockListManifest } = vi.hoisted(() => ({
  mockUpdateAgent: vi.fn(),
  mockListManifest: vi.fn(),
}));

vi.mock('../../../api/channel', () => ({
  channelApi: { updateAgent: mockUpdateAgent },
}));
vi.mock('../../../api/skills', () => ({
  skillsApi: { listManifest: mockListManifest },
}));

import { RoleSkillsModal } from '../RoleSkillsModal';

const MANIFEST = [
  { name: 'requirement-clarify', description: '需求澄清', agentTypes: ['plan'], triggers: [] },
  { name: 'tdd-implement', description: '测试先行实现', agentTypes: ['implement'], triggers: [] },
  { name: 'code-review', description: '代码评审', agentTypes: ['review'], triggers: [] },
];

const profile = { id: 'p1', name: 'dev-agent', skills: ['tdd-implement'] };

describe('RoleSkillsModal（#462）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockListManifest.mockResolvedValue({ data: { data: MANIFEST } });
    mockUpdateAgent.mockResolvedValue({ data: {} });
  });

  it('打开拉 MANIFEST 渲染多选（name + description），profile.skills 预勾选', async () => {
    render(<RoleSkillsModal open profile={profile} onClose={() => {}} onSaved={() => {}} />);

    expect(await screen.findByText('requirement-clarify')).toBeDefined();
    expect(screen.getByText(/测试先行实现/)).toBeDefined();
    expect(mockListManifest).toHaveBeenCalledTimes(1);

    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes).toHaveLength(3);
    const checked = boxes.filter(b => b.checked).map(b => b.value);
    expect(checked).toEqual(['tdd-implement']);
  });

  it('勾选/取消后保存 → updateAgent(id, { skills }) + onSaved + onClose', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    render(<RoleSkillsModal open profile={profile} onClose={onClose} onSaved={onSaved} />);

    await screen.findByText('requirement-clarify');
    // 勾选 requirement-clarify，取消 tdd-implement
    fireEvent.click(screen.getByLabelText(/requirement-clarify/));
    fireEvent.click(screen.getByLabelText(/tdd-implement/));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith('p1', { skills: ['requirement-clarify'] });
    });
    await waitFor(() => {
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('全部取消勾选 → 保存 skills: []（清空声明）', async () => {
    render(<RoleSkillsModal open profile={profile} onClose={() => {}} onSaved={() => {}} />);

    await screen.findByText('tdd-implement');
    fireEvent.click(screen.getByLabelText(/tdd-implement/));
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    await waitFor(() => {
      expect(mockUpdateAgent).toHaveBeenCalledWith('p1', { skills: [] });
    });
  });

  it('已声明但不在 MANIFEST 的 skill 也列出且预勾选（防保存静默丢声明）', async () => {
    render(<RoleSkillsModal open profile={{ ...profile, skills: ['tdd-implement', 'ghost-skill'] }} onClose={() => {}} onSaved={() => {}} />);

    const ghost = await screen.findByLabelText(/ghost-skill/) as HTMLInputElement;
    expect(ghost.checked).toBe(true);
  });

  it('保存失败 → 内联错误，不关窗', async () => {
    const onClose = vi.fn();
    const onSaved = vi.fn();
    mockUpdateAgent.mockRejectedValue(new Error('boom'));
    render(<RoleSkillsModal open profile={profile} onClose={onClose} onSaved={onSaved} />);

    await screen.findByText('tdd-implement');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));

    expect(await screen.findByText(/保存失败/)).toBeDefined();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSaved).not.toHaveBeenCalled();
  });

  it('open=false 不渲染也不拉 MANIFEST', () => {
    render(<RoleSkillsModal open={false} profile={profile} onClose={() => {}} onSaved={() => {}} />);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(mockListManifest).not.toHaveBeenCalled();
  });
});
