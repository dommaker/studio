/**
 * NeedInputOptions tests — #267（决策 #250 D3）NEED_INPUT 结构化选项卡
 *
 * - 选项按钮渲染（label + description 副标题消歧）
 * - v1 单选：点选即发送 option.value（缺省 label）
 * - 「自定义…」展开文本输入收路径直填（文本 fallback 保留）
 * - 「交给 agent 判断」固定选项
 * - multiSelect 预留钩子（aria-multiselectable 透传，v1 恒单选）
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NeedInputOptions } from '../NeedInputOptions';

const OPTIONS = [
  { label: 'studio', description: '/root/projects/studio', value: '/root/projects/studio' },
  { label: 'studio-config', description: '/root/projects/studio-config', value: '/root/projects/studio-config' },
];

describe('NeedInputOptions — 渲染与点选', () => {
  it('渲染全部选项按钮（label + path 副标题）', () => {
    render(<NeedInputOptions options={OPTIONS} onReply={vi.fn()} />);
    expect(screen.getByText('studio')).toBeTruthy();
    expect(screen.getByText('/root/projects/studio')).toBeTruthy();
    expect(screen.getByText('studio-config')).toBeTruthy();
  });

  it('点选选项 → onReply 收到 value（非 label，绝对路径直连消歧）', () => {
    const onReply = vi.fn();
    render(<NeedInputOptions options={OPTIONS} onReply={onReply} />);
    fireEvent.click(screen.getByText('studio'));
    expect(onReply).toHaveBeenCalledWith('/root/projects/studio');
  });

  it('option 无 value 时回退发送 label', () => {
    const onReply = vi.fn();
    render(<NeedInputOptions options={[{ label: '用 OAuth' }]} onReply={onReply} />);
    fireEvent.click(screen.getByText('用 OAuth'));
    expect(onReply).toHaveBeenCalledWith('用 OAuth');
  });
});

describe('NeedInputOptions — 固定动作', () => {
  it('「自定义…」展开文本输入，输入路径直填发送', () => {
    const onReply = vi.fn();
    render(<NeedInputOptions options={OPTIONS} onReply={onReply} />);
    // 默认不收起主输入之外的文本框
    expect(screen.queryByLabelText('自定义回复')).toBeNull();

    fireEvent.click(screen.getByText('自定义…'));
    const input = screen.getByLabelText('自定义回复');
    fireEvent.change(input, { target: { value: '/data/my-repo' } });
    fireEvent.click(screen.getByText('回复'));
    expect(onReply).toHaveBeenCalledWith('/data/my-repo');
  });

  it('自定义输入为空时回复按钮禁用', () => {
    render(<NeedInputOptions options={OPTIONS} onReply={vi.fn()} />);
    fireEvent.click(screen.getByText('自定义…'));
    expect((screen.getByText('回复') as HTMLButtonElement).disabled).toBe(true);
  });

  it('「交给 agent 判断」→ 发送固定文案（走现有回复通道，计入归属尝试轮次）', () => {
    const onReply = vi.fn();
    render(<NeedInputOptions options={OPTIONS} onReply={onReply} />);
    fireEvent.click(screen.getByText('交给 agent 判断'));
    expect(onReply).toHaveBeenCalledWith('交给 agent 判断');
  });
});

describe('NeedInputOptions — multiSelect 预留钩子（#250 D3）', () => {
  it('multiSelect prop 透传 aria-multiselectable；v1 仍单选即发送', () => {
    const onReply = vi.fn();
    const { container } = render(<NeedInputOptions options={OPTIONS} multiSelect onReply={onReply} />);
    expect(container.querySelector('[aria-multiselectable="true"]')).toBeTruthy();
    fireEvent.click(screen.getByText('studio'));
    expect(onReply).toHaveBeenCalledTimes(1);
  });

  it('缺省不标 multiSelect', () => {
    const { container } = render(<NeedInputOptions options={OPTIONS} onReply={vi.fn()} />);
    expect(container.querySelector('[aria-multiselectable]')).toBeNull();
  });
});
