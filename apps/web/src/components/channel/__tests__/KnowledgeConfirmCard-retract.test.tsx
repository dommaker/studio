// KnowledgeConfirmCard retract — #288（清单 P2 #20）：按钮锁存 + 高危操作两步确认
// 确认废弃（retract_confirm→deprecated）为高危不可逆操作：首次点击进入待确认态（acknowledge），
// 再次点击才执行（confirm）；点拒绝或执行失败后退出待确认态。
// 锁存：onAction 未回流前按钮禁用，连击不重复触发；返回 false → 重武装可重试。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { KnowledgeConfirmCard } from '../KnowledgeConfirmCard';
import type { ChannelMessage } from '../../../api/channel';

function makeMsg(): ChannelMessage {
  return {
    id: 'msg-ret-1',
    channelId: 'ch-1',
    workUnitId: null,
    authorType: 'agent',
    agentName: 'KK',
    content: '撤回确认',
    replyToId: null,
    meta: JSON.stringify({
      cardType: 'retract_confirm',
      status: 'ready',
      cardData: { skillId: 'skill-1', skillName: 'legacy-x' },
    }),
    createdAt: new Date().toISOString(),
  };
}

describe('KnowledgeConfirmCard retract — #288 锁存 + 两步确认', () => {
  it('两步确认：首次点确认废弃仅进入待确认态（不触发 onAction），再次点击才执行', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    const msg = makeMsg();
    render(<KnowledgeConfirmCard message={msg} meta={JSON.parse(msg.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('确认废弃'));
    expect(onAction).not.toHaveBeenCalled();
    // 待确认态：按钮文案变为二次确认提示
    fireEvent.click(screen.getByText(/再次点击确认废弃/));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-ret-1', 'retract_confirm'));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(await screen.findByText('已确认废弃')).toBeTruthy();
  });

  it('待确认态点拒绝 → 退出待确认态并执行 retract_reject（拒绝本身单击直达）', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    const msg = makeMsg();
    render(<KnowledgeConfirmCard message={msg} meta={JSON.parse(msg.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('确认废弃'));
    expect(screen.getByText(/再次点击确认废弃/)).toBeTruthy();
    fireEvent.click(screen.getByText('拒绝'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-ret-1', 'retract_reject'));
    expect(await screen.findByText('撤回已取消，保持发布')).toBeTruthy();
  });

  it('锁存：onAction 未回流前连击不重复触发，按钮禁用', async () => {
    let resolve: (v: boolean) => void = () => {};
    const onAction = vi.fn().mockImplementation(() => new Promise<boolean>(r => { resolve = r; }));
    const msg = makeMsg();
    render(<KnowledgeConfirmCard message={msg} meta={JSON.parse(msg.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('确认废弃'));
    fireEvent.click(screen.getByText(/再次点击确认废弃/));
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
    // pending 锁存中：两个按钮均禁用，连击不再触发
    const armedBtn = screen.getByText(/再次点击确认废弃/).closest('button')!;
    expect(armedBtn.disabled).toBe(true);
    expect(screen.getByText('拒绝').closest('button')!.disabled).toBe(true);
    fireEvent.click(armedBtn);
    fireEvent.click(screen.getByText('拒绝'));
    expect(onAction).toHaveBeenCalledTimes(1);
    resolve(true);
    expect(await screen.findByText('已确认废弃')).toBeTruthy();
  });

  it('失败重武装：onAction 返回 false → 退出待确认态，按钮恢复可点可重试', async () => {
    const onAction = vi.fn().mockResolvedValue(false);
    const msg = makeMsg();
    render(<KnowledgeConfirmCard message={msg} meta={JSON.parse(msg.meta!)} onAction={onAction} />);
    fireEvent.click(screen.getByText('确认废弃'));
    fireEvent.click(screen.getByText(/再次点击确认废弃/));
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
    // 失败后回到未武装态：原按钮文案恢复且可点
    await waitFor(() => expect(screen.getByText('确认废弃').closest('button')!.disabled).toBe(false));
    expect(screen.queryByText('已确认废弃')).toBeNull();
    fireEvent.click(screen.getByText('确认废弃'));
    fireEvent.click(screen.getByText(/再次点击确认废弃/));
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(2));
  });
});
