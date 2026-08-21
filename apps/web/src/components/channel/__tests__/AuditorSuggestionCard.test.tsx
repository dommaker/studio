// AuditorSuggestionCard — #288（清单 P2 #20）：按钮一次性锁存核查
// 契约：cardType 'auditor_suggestion'；action 'auditor_apply_confirm' / 'auditor_apply_reject'。
// 锁存：点击到 onAction 回流前按钮禁用，连击不重复触发；onAction 返回 false → 重武装可重试。
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AuditorSuggestionCard } from '../AuditorSuggestionCard';
import type { ChannelMessage } from '../../../api/channel';

function makeMsg(status?: string): ChannelMessage {
  return {
    id: 'msg-aud-1',
    channelId: 'ch-1',
    workUnitId: null,
    authorType: 'agent',
    agentName: 'Auditor',
    content: '审计建议',
    replyToId: null,
    meta: JSON.stringify({
      cardType: 'auditor_suggestion',
      ...(status ? { status } : {}),
      cardData: {
        suggestions: [
          { type: 'prompt_optimization', risk: 'high', agentType: 'Analyst', detail: '提示词缺少反例' },
        ],
      },
    }),
    createdAt: new Date().toISOString(),
  };
}

const parsedMeta = (msg: ChannelMessage) => JSON.parse(msg.meta!);

describe('AuditorSuggestionCard — #288 按钮锁存', () => {
  it('待决卡：渲染建议清单 + 确认执行/拒绝按钮', () => {
    const msg = makeMsg();
    render(<AuditorSuggestionCard message={msg} meta={parsedMeta(msg)} onAction={vi.fn()} />);
    expect(screen.getByText('Prompt 优化')).toBeTruthy();
    expect(screen.getByText('高风险')).toBeTruthy();
    expect(screen.getByText('确认执行')).toBeTruthy();
    expect(screen.getByText('拒绝')).toBeTruthy();
  });

  it('点确认执行 → onAction(auditor_apply_confirm)，成功后显示已确认执行', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    const msg = makeMsg();
    render(<AuditorSuggestionCard message={msg} meta={parsedMeta(msg)} onAction={onAction} />);
    fireEvent.click(screen.getByText('确认执行'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-aud-1', 'auditor_apply_confirm'));
    expect(await screen.findByText('已确认执行')).toBeTruthy();
  });

  it('点拒绝 → onAction(auditor_apply_reject)，成功后显示已拒绝', async () => {
    const onAction = vi.fn().mockResolvedValue(true);
    const msg = makeMsg();
    render(<AuditorSuggestionCard message={msg} meta={parsedMeta(msg)} onAction={onAction} />);
    fireEvent.click(screen.getByText('拒绝'));
    await waitFor(() => expect(onAction).toHaveBeenCalledWith('msg-aud-1', 'auditor_apply_reject'));
    expect(await screen.findByText('已拒绝')).toBeTruthy();
  });

  it('锁存：onAction 未回流前连击不重复触发，按钮禁用', async () => {
    let resolve: (v: boolean) => void = () => {};
    const onAction = vi.fn().mockImplementation(() => new Promise<boolean>(r => { resolve = r; }));
    const msg = makeMsg();
    render(<AuditorSuggestionCard message={msg} meta={parsedMeta(msg)} onAction={onAction} />);
    const confirmBtn = screen.getByText('确认执行').closest('button')!;
    fireEvent.click(confirmBtn);
    // pending 锁存中：按钮禁用，连击不再触发
    expect(confirmBtn.disabled).toBe(true);
    expect(screen.getByText('拒绝').closest('button')!.disabled).toBe(true);
    fireEvent.click(confirmBtn);
    fireEvent.click(screen.getByText('拒绝'));
    expect(onAction).toHaveBeenCalledTimes(1);
    resolve(true);
    expect(await screen.findByText('已确认执行')).toBeTruthy();
    expect(onAction).toHaveBeenCalledTimes(1);
  });

  it('失败重武装：onAction 返回 false → 不进终态，按钮恢复可点', async () => {
    const onAction = vi.fn().mockResolvedValue(false);
    const msg = makeMsg();
    render(<AuditorSuggestionCard message={msg} meta={parsedMeta(msg)} onAction={onAction} />);
    fireEvent.click(screen.getByText('确认执行'));
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText('确认执行').closest('button')!.disabled).toBe(false));
    expect(screen.queryByText('已确认执行')).toBeNull();
    // 重试可再触发
    fireEvent.click(screen.getByText('确认执行'));
    await waitFor(() => expect(onAction).toHaveBeenCalledTimes(2));
  });
});
