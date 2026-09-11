// ui/Modal — 批次 F-2 a11y 基座：Escape 关闭 / role+aria-modal / 焦点进出（开弹聚焦、关弹还焦）
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { Modal } from '../Modal';

describe('Modal（批次 F-2 a11y 基座）', () => {
  it('open=false 不渲染', () => {
    render(<Modal open={false} title="标题">内容</Modal>);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('弹窗带 role="dialog" + aria-modal="true"', () => {
    render(<Modal title="标题" onClose={() => {}}>内容</Modal>);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
  });

  it('Escape 触发 onClose', () => {
    const onClose = vi.fn();
    render(<Modal title="标题" onClose={onClose}>内容</Modal>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('无 onClose 时 Escape 不炸、不抛错', () => {
    render(<Modal title="标题">内容</Modal>);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('Select 选项面板在岗时 Escape 让 Select 自管，不关弹窗', () => {
    const onClose = vi.fn();
    render(<Modal title="标题" onClose={onClose}>内容</Modal>);
    const panel = document.createElement('div');
    panel.className = 'select-panel';
    document.body.appendChild(panel);
    try {
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      panel.remove();
    }
  });

  it('卸载后清理 keydown 监听（再按 Escape 不再触发）', () => {
    const onClose = vi.fn();
    const { unmount } = render(<Modal title="标题" onClose={onClose}>内容</Modal>);
    unmount();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('打开时焦点进弹窗首个可聚焦元素（标题栏关闭 ✕）', () => {
    render(<Modal title="标题" onClose={() => {}}>内容</Modal>);
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '关闭' }));
  });

  it('弹窗内无可聚焦元素时焦点落弹窗本体', () => {
    render(<Modal>纯文本</Modal>);
    expect(document.activeElement).toBe(screen.getByRole('dialog'));
  });

  it('关闭时还焦到打开前的 document.activeElement（触发元素）', () => {
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>打开</button>
          <Modal open={open} onClose={() => setOpen(false)} title="标题">内容</Modal>
        </>
      );
    }
    render(<Harness />);
    const trigger = screen.getByRole('button', { name: '打开' });
    trigger.focus();

    fireEvent.click(trigger);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(document.activeElement).not.toBe(trigger); // 焦点已进弹窗

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger); // 还焦触发元素
  });
});
