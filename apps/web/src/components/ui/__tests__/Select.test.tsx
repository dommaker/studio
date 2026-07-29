import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Select } from '../Select';

afterEach(() => {
  cleanup();
});

const opts = [
  { value: 'a', label: '选项 A' },
  { value: 'b', label: '选项 B' },
  { value: 'c', label: '选项 C' },
];

describe('Select', () => {
  it('渲染触发器 + 当前选中项文案', () => {
    render(<Select value="b" onChange={() => {}} options={opts} aria-label="选择" />);
    const trigger = screen.getByRole('button', { name: /选择/ });
    expect(trigger.textContent).toContain('选项 B');
  });

  it('value 为空时显示 placeholder', () => {
    render(
      <Select value="" onChange={() => {}} options={opts} placeholder="请选择" aria-label="选择" />,
    );
    expect(screen.getByRole('button', { name: /选择/ }).textContent).toContain('请选择');
  });

  it('点击触发器打开面板，选项以 role=option 暴露', () => {
    render(<Select value="a" onChange={() => {}} options={opts} aria-label="选择" />);
    expect(screen.queryByRole('listbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /选择/ }));
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.getByRole('option', { name: '选项 B' })).toBeTruthy();
  });

  it('点击选项 -> onChange 调用 + 面板关闭', () => {
    const onChange = vi.fn();
    render(<Select value="a" onChange={onChange} options={opts} aria-label="选择" />);
    fireEvent.click(screen.getByRole('button', { name: /选择/ }));
    fireEvent.click(screen.getByRole('option', { name: '选项 C' }));
    expect(onChange).toHaveBeenCalledWith('c');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('disabled=true 时点击不打开面板', () => {
    render(<Select value="a" onChange={() => {}} options={opts} disabled aria-label="选择" />);
    const trigger = screen.getByRole('button', { name: /选择/ });
    expect(trigger).toBeDisabled();
    fireEvent.click(trigger);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('disabled 选项不可选中', () => {
    const onChange = vi.fn();
    const optsWithDisabled = [
      { value: 'a', label: 'A' },
      { value: 'b', label: 'B', disabled: true },
    ];
    render(<Select value="a" onChange={onChange} options={optsWithDisabled} aria-label="选择" />);
    fireEvent.click(screen.getByRole('button', { name: /选择/ }));
    const disabledOpt = screen.getByRole('option', { name: 'B' });
    expect(disabledOpt).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(disabledOpt);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('键盘 Enter 打开面板，ArrowDown 移动高亮，Enter 选中', () => {
    const onChange = vi.fn();
    render(<Select value="a" onChange={onChange} options={opts} aria-label="选择" />);
    const trigger = screen.getByRole('button', { name: /选择/ });

    // 打开
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(screen.getByRole('listbox')).toBeTruthy();

    // 下移到选项 B（初始高亮 = 当前选中 a = 索引 0，下移一次到 b）
    fireEvent.keyDown(trigger, { key: 'ArrowDown' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('b');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('键盘 ArrowUp 反向移动高亮', () => {
    const onChange = vi.fn();
    render(<Select value="c" onChange={onChange} options={opts} aria-label="选择" />);
    const trigger = screen.getByRole('button', { name: /选择/ });

    fireEvent.keyDown(trigger, { key: 'Enter' });
    // 初始高亮 = 索引 2（c），上移一次到 b（索引 1）
    fireEvent.keyDown(trigger, { key: 'ArrowUp' });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('b');
  });

  it('Escape 关闭面板且不调用 onChange', () => {
    const onChange = vi.fn();
    render(<Select value="a" onChange={onChange} options={opts} aria-label="选择" />);
    const trigger = screen.getByRole('button', { name: /选择/ });

    fireEvent.click(trigger);
    expect(screen.getByRole('listbox')).toBeTruthy();
    fireEvent.keyDown(trigger, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('Tab 关闭面板', () => {
    render(<Select value="a" onChange={() => {}} options={opts} aria-label="选择" />);
    const trigger = screen.getByRole('button', { name: /选择/ });
    fireEvent.click(trigger);
    fireEvent.keyDown(trigger, { key: 'Tab' });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('点外部关闭面板', () => {
    render(<Select value="a" onChange={() => {}} options={opts} aria-label="选择" />);
    fireEvent.click(screen.getByRole('button', { name: /选择/ }));
    expect(screen.getByRole('listbox')).toBeTruthy();
    // mousedown 事件冒泡到 document
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('ARIA: haspopup=listbox + expanded 随状态变化', () => {
    render(<Select value="a" onChange={() => {}} options={opts} aria-label="选择" />);
    const trigger = screen.getByRole('button', { name: /选择/ });
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
  });

  it('选中项的 option 标记 aria-selected=true', () => {
    render(<Select value="b" onChange={() => {}} options={opts} aria-label="选择" />);
    fireEvent.click(screen.getByRole('button', { name: /选择/ }));
    const selectedOpt = screen.getByRole('option', { name: '选项 B' });
    expect(selectedOpt).toHaveAttribute('aria-selected', 'true');
    const otherOpt = screen.getByRole('option', { name: '选项 A' });
    expect(otherOpt).toHaveAttribute('aria-selected', 'false');
  });
});
