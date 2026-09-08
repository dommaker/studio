// header「更多」下拉：收纳 sidebar 四主项之外的入口（知识库/阅览室/监控/审计日志/设置；PMO 是主项不重复）
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import { MoreDropdown } from '../MoreDropdown';

const renderDropdown = () =>
  render(
    <MemoryRouter initialEntries={['/channels']}>
      <MoreDropdown />
    </MemoryRouter>,
  );

describe('MoreDropdown — header 更多菜单', () => {
  it('默认折叠：菜单项不可达', () => {
    renderDropdown();
    for (const label of ['知识库', '阅览室', '监控', '审计日志', '设置']) {
      expect(screen.queryByRole('link', { name: new RegExp(label) })).toBeNull();
    }
  });

  it('展开后全部菜单项可达且 href 正确（不含 sidebar 主项 PMO）', () => {
    renderDropdown();
    fireEvent.click(screen.getByRole('button', { name: /更多/ }));
    const expected: Array<[string, string]> = [
      ['知识库', '/knowledge'],
      ['阅览室', '/library'],
      ['监控', '/monitoring'],
      ['审计日志', '/audit-logs'],
      ['设置', '/settings'],
    ];
    for (const [label, href] of expected) {
      const link = screen.getByRole('link', { name: new RegExp(label) });
      expect(link.getAttribute('href')).toBe(href);
    }
    expect(screen.queryByRole('link', { name: /PMO/ })).toBeNull();
  });

  it('点击菜单项后下拉收起', () => {
    renderDropdown();
    fireEvent.click(screen.getByRole('button', { name: /更多/ }));
    fireEvent.click(screen.getByRole('link', { name: /知识库/ }));
    expect(screen.queryByRole('link', { name: /阅览室/ })).toBeNull();
  });
});
