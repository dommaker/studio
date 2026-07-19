// Design Lab 原型壳 smoke test：三栏渲染 + 关键交互（抽屉 / NEED_INPUT 回复 / 已完成折叠）
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PrototypeShell } from '../PrototypeShell';

const renderShell = (direction: 'a' | 'b' = 'a') =>
  render(
    <MemoryRouter>
      <PrototypeShell direction={direction} />
    </MemoryRouter>,
  );

describe('PrototypeShell', () => {
  it('renders three-column IA: channel rail, message stream, input bar', () => {
    const { container } = renderShell();
    expect(container.querySelector('.dl-rail')).toBeTruthy();
    expect(container.querySelector('.dl-main')).toBeTruthy();
    expect(container.querySelector('.dl-stream')).toBeTruthy();
    expect(screen.getAllByText('design-视觉方向', { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByLabelText('发送消息')).toBeTruthy();
  });

  it('switches selected channel in the rail', () => {
    renderShell();
    const chan = screen.getByText('rnd-主研发').closest('button')!;
    fireEvent.click(chan);
    expect(chan.className).toContain('dl-chan-active');
    expect(screen.getByText('#rnd-主研发')).toBeTruthy();
  });

  it('opens and closes the WorkUnit drawer from a message card', () => {
    renderShell();
    fireEvent.click(screen.getByText('WU-1017 ›'));
    expect(screen.getByLabelText('详情抽屉')).toBeTruthy();
    expect(screen.getByText('token 开销')).toBeTruthy();
    expect(screen.getByText(/红线 1\.2x/)).toBeTruthy();
    fireEvent.click(screen.getByLabelText('关闭抽屉'));
    expect(screen.queryByLabelText('详情抽屉')).toBeNull();
  });

  it('opens REQ chain drawer from a REQ chip', () => {
    renderShell();
    fireEvent.click(screen.getAllByText(/REQ-0042 · 主界面视觉方向稿/)[0]);
    expect(screen.getByText('REQ-0042 全链路')).toBeTruthy();
    expect(screen.getByText(/WorkUnit 链路/)).toBeTruthy();
  });

  it('replies inside a NEED_INPUT card (front-end state only)', () => {
    renderShell();
    const input = screen.getByLabelText('回复 WU-1018');
    fireEvent.change(input, { target: { value: '同意注入 SDD-012' } });
    fireEvent.click(screen.getByText('回复'));
    expect(screen.getByText(/已回复/)).toBeTruthy();
  });

  it('collapses completed messages by default and expands on toggle', () => {
    renderShell();
    expect(screen.queryByText(/需求文档 · REQ-0041/)).toBeNull();
    fireEvent.click(screen.getByText(/条已完成消息/));
    expect(screen.getByText(/需求文档 · REQ-0041/)).toBeTruthy();
  });

  it('expands thread replies on the anchor card', () => {
    renderShell();
    expect(screen.queryByText(/技术侦察完成/)).toBeNull();
    fireEvent.click(screen.getByText(/条线程回复/));
    expect(screen.getByText(/技术侦察完成/)).toBeTruthy();
  });

  it('approves an approval card (front-end state only)', () => {
    renderShell();
    fireEvent.click(screen.getByText('通过'));
    expect(screen.getByText(/已通过/)).toBeTruthy();
  });
});
