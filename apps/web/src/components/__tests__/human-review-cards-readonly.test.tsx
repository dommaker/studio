// #278（决策 #250 D2）：历史卡只读化 + retract_confirm 按钮接活
// knowledge_confirm / requirements_doc（产卡链已删）→ 按钮区整区隐藏 + 卡底淡注「该确认入口已下线」；
// retract_confirm 按钮保留并触发 retract_confirm / retract_reject action。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

vi.mock('../../api/requirements', () => ({
  requirementApi: { getChain: vi.fn() },
}));

import { KnowledgeConfirmCard } from '../channel/KnowledgeConfirmCard';
import { RequirementsDocCard } from '../channel/RequirementsDocCard';
import type { ChannelMessage } from '../../api/channel';
import type { CardMeta } from '../../utils/messageMeta';

function makeMsg(meta: Record<string, unknown>, content = '卡片内容'): ChannelMessage {
  return {
    id: 'msg-1', channelId: 'ch-1', authorType: 'agent', agentName: 'KK',
    content, workUnitId: null, replyToId: null,
    meta: JSON.stringify(meta),
    createdAt: new Date().toISOString(),
  };
}

describe('KnowledgeConfirmCard — #278 历史卡只读化 + retract 接线', () => {
  it('knowledge_confirm 待决卡：按钮区隐藏 + 淡注「该确认入口已下线」', () => {
    render(
      <KnowledgeConfirmCard
        message={makeMsg({ cardType: 'knowledge_confirm', status: 'ready', cardData: { entries: [{ type: 'pitfall', title: 't', content: 'c', tags: [] }] } })}
        meta={{ cardType: 'knowledge_confirm', status: 'ready', cardData: { entries: [{ type: 'pitfall', title: 't', content: 'c', tags: [] }] } }}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('该确认入口已下线')).toBeTruthy();
    expect(screen.queryByText('确认入库')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('knowledge_confirm 已决卡（confirmed）：保持既有紧凑已审态', () => {
    render(
      <KnowledgeConfirmCard
        message={makeMsg({ cardType: 'knowledge_confirm', status: 'confirmed' })}
        meta={{ cardType: 'knowledge_confirm', status: 'confirmed' }}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('已确认入库')).toBeTruthy();
    expect(screen.queryByText('该确认入口已下线')).toBeNull();
  });

  it('retract_confirm 待决卡：头部显示技能名；确认废弃两步确认（#288），拒绝单击直达', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    render(
      <KnowledgeConfirmCard
        message={makeMsg({ cardType: 'retract_confirm', status: 'ready', cardData: { skillId: 'skill-1', skillName: 'legacy-x' } })}
        meta={{ cardType: 'retract_confirm', status: 'ready', cardData: { skillId: 'skill-1', skillName: 'legacy-x' } }}
        onAction={onAction}
      />,
    );
    expect(screen.getByText('legacy-x')).toBeTruthy();
    expect(screen.queryByText(/条知识/)).toBeNull();
    // 高危操作 acknowledge→confirm：首次点击仅进入待确认态
    fireEvent.click(screen.getByText('确认废弃'));
    expect(onAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText(/再次点击确认废弃/));
    await screen.findByText('已确认废弃');
    expect(onAction).toHaveBeenCalledWith('msg-1', 'retract_confirm');
  });

  it('retract_confirm 已决卡：deprecated → 已确认废弃；published → 撤回已取消', () => {
    const { unmount } = render(
      <KnowledgeConfirmCard
        message={makeMsg({ cardType: 'retract_confirm', status: 'deprecated' })}
        meta={{ cardType: 'retract_confirm', status: 'deprecated' }}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('已确认废弃')).toBeTruthy();
    unmount();
    render(
      <KnowledgeConfirmCard
        message={makeMsg({ cardType: 'retract_confirm', status: 'published' })}
        meta={{ cardType: 'retract_confirm', status: 'published' }}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('撤回已取消，保持发布')).toBeTruthy();
  });
});

describe('RequirementsDocCard — #278 历史卡只读化', () => {
  const docMeta: CardMeta = { cardType: 'requirements_doc', status: 'ready', requirementId: 'REQ-1' };

  it('待确认历史卡：按钮区整区隐藏 + 淡注「该确认入口已下线」', () => {
    render(
      <RequirementsDocCard message={makeMsg(docMeta, '# 需求文档')} meta={docMeta} onAction={vi.fn()} />,
    );
    expect(screen.getByText('该确认入口已下线')).toBeTruthy();
    expect(screen.queryByText('开始执行')).toBeNull();
    expect(screen.queryByText('修改需求')).toBeNull();
    expect(screen.queryByText('继续讨论')).toBeNull();
    // 卡体内容仍可读
    expect(screen.getByText('# 需求文档')).toBeTruthy();
  });

  it('已完成历史卡：保持既有状态尾注，无下线淡注', () => {
    render(
      <RequirementsDocCard
        message={makeMsg({ ...docMeta, status: 'done' })}
        meta={{ ...docMeta, status: 'done' }}
        onAction={vi.fn()}
      />,
    );
    expect(screen.getByText('需求已完成')).toBeTruthy();
    expect(screen.queryByText('该确认入口已下线')).toBeNull();
  });
});
