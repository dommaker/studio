// SuggestionChips（#440 Phase 1）— 频道输入框上方的建议 prompt 片：渲染 / 点击填入 / dismiss
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SuggestionChips } from '../SuggestionChips';

const SUGGESTIONS = [
  { id: 'review-checklist', text: '@reviewer 把 AC 转写成审查清单' },
  { id: 'contract-lock', text: '@developer 锁定实现契约' },
];

describe('SuggestionChips', () => {
  it('渲染全部建议片（mono 小卡）', () => {
    render(<SuggestionChips suggestions={SUGGESTIONS} onPick={() => {}} onDismiss={() => {}} />);
    expect(screen.getByText('@reviewer 把 AC 转写成审查清单')).toBeTruthy();
    expect(screen.getByText('@developer 锁定实现契约')).toBeTruthy();
  });

  it('点击建议片 → onPick 携带该片文本', () => {
    const onPick = vi.fn();
    render(<SuggestionChips suggestions={SUGGESTIONS} onPick={onPick} onDismiss={() => {}} />);
    fireEvent.click(screen.getByText('@reviewer 把 AC 转写成审查清单'));
    expect(onPick).toHaveBeenCalledWith('@reviewer 把 AC 转写成审查清单');
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('dismiss 按钮 → onDismiss', () => {
    const onDismiss = vi.fn();
    render(<SuggestionChips suggestions={SUGGESTIONS} onPick={() => {}} onDismiss={onDismiss} />);
    fireEvent.click(screen.getByLabelText('关闭建议'));
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  // #442：in_review 片收窄——label 标注「可选」、hint 说明点击后果；预填内容（text）不污染
  it('label/hint 存在时：渲染 label 与说明小字，点击仍上送 text', () => {
    const onPick = vi.fn();
    const suggestions = [{
      id: 'review-checklist',
      text: '@reviewer 把 AC 转写成审查清单',
      label: '可选：@reviewer 把 AC 转写成审查清单',
      hint: '自动评审通常已在进行，不点也会继续；点了会把这句话预填到输入框，可修改后再发送',
    }];
    render(<SuggestionChips suggestions={suggestions} onPick={onPick} onDismiss={() => {}} />);
    expect(screen.getByText('可选：@reviewer 把 AC 转写成审查清单')).toBeTruthy();
    expect(screen.getByText(/预填到输入框/)).toBeTruthy();
    fireEvent.click(screen.getByText('可选：@reviewer 把 AC 转写成审查清单'));
    expect(onPick).toHaveBeenCalledWith('@reviewer 把 AC 转写成审查清单');
    expect(onPick).toHaveBeenCalledTimes(1);
  });

  it('空建议列表 → 整体不渲染', () => {
    const { container } = render(<SuggestionChips suggestions={[]} onPick={() => {}} onDismiss={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  // #443（spec #441）：三形态渲染骨架——status 只读状态说明：不可点、无发送语义
  it('status 形态：只读状况说明，非按钮、点击不上送、无 prefill 语义', () => {
    const onPick = vi.fn();
    const suggestions = [{
      id: 'auto-review-in-flight',
      kind: 'status' as const,
      label: '等待自动评审：《登录功能》',
      hint: '系统正在自动审查这张工单，无需操作；有结果后这里会更新',
    }];
    render(<SuggestionChips suggestions={suggestions} onPick={onPick} onDismiss={() => {}} />);
    const note = screen.getByText('等待自动评审：《登录功能》');
    expect(note.closest('button')).toBeNull(); // 不可点：不是按钮、不包在按钮里
    fireEvent.click(note);
    expect(onPick).not.toHaveBeenCalled(); // 无发送语义
    expect(screen.getByText(/无需操作/)).toBeTruthy();
  });

  // action 形态骨架（#444 起由后端产出）：可点、点击走 onAction 而非 prefill
  it('action 形态：点击上送整条建议给 onAction（直调确定性接口，不经输入框）', () => {
    const onPick = vi.fn();
    const onAction = vi.fn();
    const actionItem = { id: 'redispatch-review', kind: 'action' as const, label: '补派评审' };
    render(<SuggestionChips suggestions={[actionItem]} onPick={onPick} onAction={onAction} onDismiss={() => {}} />);
    fireEvent.click(screen.getByText('补派评审'));
    expect(onAction).toHaveBeenCalledWith(actionItem);
    expect(onPick).not.toHaveBeenCalled();
  });
});
