// #277（决策 #248 D5）：mention chip 正则拆分单测——口径同后端 detectMention，
// 邮箱/@@ 误染排除；renderWithMentions 的 chip 结构由 ChannelMessageItem-layout 组件测试覆盖。
import { describe, it, expect } from 'vitest';
import { MENTION_RE } from '../mentions';

const names = (text: string) => [...text.matchAll(MENTION_RE)].map(m => m[1]);

describe('MENTION_RE — @name 识别口径（#277）', () => {
  it('基本 mention：ASCII / 连字符 / 下划线', () => {
    expect(names('找 @pm 和 @dev-agent_2 看一下')).toEqual(['pm', 'dev-agent_2']);
  });

  it('中文名（Unicode 字母口径）', () => {
    expect(names('@图书管理员 查一下')).toEqual(['图书管理员']);
  });

  it('邮箱不误染：@ 前紧跟字母/数字', () => {
    expect(names('发到 a@b.com 或 x1@p2.io')).toEqual([]);
  });

  it('@@ 转义不误染第二个 @', () => {
    expect(names('@@pm')).toEqual([]);
  });

  it('行首/标点后的 @ 正常命中', () => {
    expect(names('@pm，（@coder）')).toEqual(['pm', 'coder']);
  });

  it('无 mention 返回空', () => {
    expect(names('纯文本没有提及')).toEqual([]);
  });
});
