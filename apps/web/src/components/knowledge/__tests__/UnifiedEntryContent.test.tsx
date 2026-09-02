// #435 B7：UnifiedEntryContent——JSON 结构化键值 / 长文本截断+展开收起
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UnifiedEntryContent } from '../UnifiedEntryContent';

describe('UnifiedEntryContent', () => {
  it('JSON 对象内容 → 键值列表，不裸出原文', () => {
    render(<UnifiedEntryContent content='{"responseStyle":"简洁","activeHours":[9,10]}' />);
    expect(screen.getByText('responseStyle')).toBeTruthy();
    expect(screen.getByText('简洁')).toBeTruthy();
    expect(screen.getByText('activeHours')).toBeTruthy();
    expect(screen.getByText('[9,10]')).toBeTruthy();
    expect(screen.queryByText(/\{"responseStyle"/)).toBeNull();
  });

  it('短文本（≤200）直出，无展开钮', () => {
    render(<UnifiedEntryContent content="一条普通知识" />);
    expect(screen.getByText('一条普通知识')).toBeTruthy();
    expect(screen.queryByText('展开')).toBeNull();
  });

  it('长文本截断 + 展开/收起往返', () => {
    const longText = '告警内容。'.repeat(60);
    render(<UnifiedEntryContent content={longText} />);
    expect(screen.queryByText(longText)).toBeNull();
    fireEvent.click(screen.getByText('展开'));
    expect(screen.getByText(longText)).toBeTruthy();
    fireEvent.click(screen.getByText('收起'));
    expect(screen.queryByText(longText)).toBeNull();
  });

  it('空内容不炸', () => {
    const { container } = render(<UnifiedEntryContent content={undefined} />);
    expect(container).toBeTruthy();
  });
});

describe('UnifiedEntryContent JSON 折叠（review 跟进：长内容截断+展开覆盖 JSON 分支）', () => {
  const bigJson = JSON.stringify(Object.fromEntries(
    Array.from({ length: 9 }, (_, i) => [`field${i}`, `v${i}`])
  ));

  it('字段 >6 默认收起前 6 个，展开全部后收起往返', () => {
    render(<UnifiedEntryContent content={bigJson} />);
    expect(screen.getByText('field5')).toBeTruthy();
    expect(screen.queryByText('field6')).toBeNull();
    fireEvent.click(screen.getByText('展开全部 9 字段'));
    expect(screen.getByText('field8')).toBeTruthy();
    fireEvent.click(screen.getByText('收起'));
    expect(screen.queryByText('field6')).toBeNull();
  });

  it('字段 ≤6 全部直出，无展开钮', () => {
    render(<UnifiedEntryContent content='{"a":"1","b":"2"}' />);
    expect(screen.getByText('a')).toBeTruthy();
    expect(screen.getByText('b')).toBeTruthy();
    expect(screen.queryByText(/展开全部/)).toBeNull();
  });
});
