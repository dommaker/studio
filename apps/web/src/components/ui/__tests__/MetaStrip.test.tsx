// MetaStrip（#440 Phase 3）— 标题下密排元信息条：空值项省略不渲染，全空不占位
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MetaStrip } from '../MetaStrip';

describe('MetaStrip', () => {
  it('渲染 label: value 项', () => {
    render(<MetaStrip items={[
      { key: 'stage', label: '当前阶段', value: '进行中' },
      { key: 'ac', label: 'AC 数', value: 3 },
    ]} />);
    expect(screen.getByText('当前阶段:')).toBeTruthy();
    expect(screen.getByText('进行中')).toBeTruthy();
    expect(screen.getByText('AC 数:')).toBeTruthy();
    expect(screen.getByText('3')).toBeTruthy();
  });

  it('空值项（null/undefined/空串）省略不渲染', () => {
    render(<MetaStrip items={[
      { key: 'role', label: '涉及角色', value: null },
      { key: 'ac', label: 'AC 数', value: undefined },
      { key: 'eta', label: '预计耗时', value: '' },
      { key: 'stage', label: '当前阶段', value: '待验收' },
    ]} />);
    expect(screen.queryByText('涉及角色:')).toBeNull();
    expect(screen.queryByText('AC 数:')).toBeNull();
    expect(screen.queryByText('预计耗时:')).toBeNull();
    expect(screen.getByText('当前阶段:')).toBeTruthy();
  });

  it('全部为空 → 整体不渲染（不占位）', () => {
    const { container } = render(<MetaStrip items={[
      { key: 'a', label: '甲', value: null },
      { key: 'b', label: '乙', value: '' },
    ]} />);
    expect(container.firstChild).toBeNull();
  });

  it('value 支持 ReactNode（如链接）', () => {
    render(<MetaStrip items={[
      { key: 'role', label: '涉及角色', value: <a href="/agents/r1">@coder-01</a> },
    ]} />);
    expect(screen.getByText('@coder-01').closest('a')?.getAttribute('href')).toBe('/agents/r1');
  });
});
