// SpecApproveDialog — #463 spec 确认弹窗：卡片墙预填 / 勾选剔除（部分物化）/ 展开改 AC /
// 手动加卡 / 全剔=不物化 / 打回预设理由；blockedBy/leg 透传不丢失
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SpecApproveDialog, SPEC_REJECT_REASON } from '../SpecApproveDialog';
import type { SpecTaskFormItem } from '../mapUtils';

const PREFILL: SpecTaskFormItem[] = [
  { title: '实现存储层', ac: ['单测覆盖'], blockedBy: ['wu-9'], leg: 'dommaker/studio' },
  { title: '接通派工', ac: [], blockedBy: [] },
];

function setup(overrides: Record<string, unknown> = {}) {
  const props = {
    prefill: PREFILL,
    onConfirm: vi.fn(),
    onReject: vi.fn(),
    onCancel: vi.fn(),
    ...overrides,
  };
  render(<SpecApproveDialog {...props} />);
  return props;
}

describe('SpecApproveDialog（#463）', () => {
  it('预填卡片墙：全选时点「确认物化（2）」→ confirm 回传全部（blockedBy/leg 透传）', () => {
    const { onConfirm } = setup();
    expect((screen.getByLabelText('任务标题 1') as HTMLInputElement).value).toBe('实现存储层');

    fireEvent.click(screen.getByText('确认物化（2）'));
    expect(onConfirm).toHaveBeenCalledWith({
      kind: 'spec',
      tasks: [
        { title: '实现存储层', ac: ['单测覆盖'], blockedBy: ['wu-9'], leg: 'dommaker/studio' },
        { title: '接通派工', ac: [] },
      ],
    });
  });

  it('勾选剔除一卡 → 主按钮变「部分物化（1/2）」，confirm 只含勾选集', () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByLabelText('纳入物化 2'));
    fireEvent.click(screen.getByText('部分物化（1/2）'));
    expect(onConfirm).toHaveBeenCalledWith({
      kind: 'spec',
      tasks: [{ title: '实现存储层', ac: ['单测覆盖'], blockedBy: ['wu-9'], leg: 'dommaker/studio' }],
    });
  });

  it('全部不勾 → 「确认通过（不物化）」，confirm tasks 为空数组', () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByLabelText('纳入物化 1'));
    fireEvent.click(screen.getByLabelText('纳入物化 2'));
    fireEvent.click(screen.getByText('确认通过（不物化）'));
    expect(onConfirm).toHaveBeenCalledWith({ kind: 'spec', tasks: [] });
  });

  it('展开改 AC：改文/添加/删除生效；标题行内改生效（trim + 空白 AC 剔除）', () => {
    const { onConfirm } = setup();
    fireEvent.change(screen.getByLabelText('任务标题 1'), { target: { value: '  存储层（改） ' } });

    fireEvent.click(screen.getByText('验收标准（1）')); // 展开卡 1
    fireEvent.change(screen.getByLabelText('验收标准 1-1'), { target: { value: '单测全绿' } });
    fireEvent.click(screen.getByText('添加验收标准'));
    fireEvent.change(screen.getByLabelText('验收标准 1-2'), { target: { value: '   ' } }); // 空白 → 提交时剔除

    fireEvent.click(screen.getByText('确认物化（2）'));
    expect(onConfirm).toHaveBeenCalledWith({
      kind: 'spec',
      tasks: [
        { title: '存储层（改）', ac: ['单测全绿'], blockedBy: ['wu-9'], leg: 'dommaker/studio' },
        { title: '接通派工', ac: [] },
      ],
    });
  });

  it('空预填 → 空墙可「添加任务」手动建卡（agent 没拆也可补录入后物化）', () => {
    const { onConfirm } = setup({ prefill: [] });
    expect(screen.getByText('确认通过（不物化）')).toBeTruthy();

    fireEvent.click(screen.getByText('添加任务'));
    fireEvent.change(screen.getByLabelText('任务标题 1'), { target: { value: '手动补的任务' } });
    fireEvent.click(screen.getByText('确认物化（1）'));
    expect(onConfirm).toHaveBeenCalledWith({ kind: 'spec', tasks: [{ title: '手动补的任务', ac: [] }] });
  });

  it('「打回」→ onReject 带预设理由，不触发 onConfirm', () => {
    const { onReject, onConfirm } = setup();
    fireEvent.click(screen.getByText('打回'));
    expect(onReject).toHaveBeenCalledWith(SPEC_REJECT_REASON);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
