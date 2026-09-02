// #436 C9：阅览室文档页标题去重——正文首个 H1 与页头标题（doc.title）重复时剥除
import { describe, it, expect } from 'vitest';
import { stripDuplicateH1 } from '../stripDuplicateH1';

describe('stripDuplicateH1', () => {
  it('首行 H1 与标题相同 → 剥除该 H1', () => {
    const out = stripDuplicateH1('# 阅览室设计\n\n正文第一段', '阅览室设计');
    expect(out).toBe('正文第一段');
  });

  it('首行 H1 与标题不同 → 原文不动', () => {
    const content = '# 另一个标题\n\n正文';
    expect(stripDuplicateH1(content, '阅览室设计')).toBe(content);
  });

  it('H1 不在首行（前面有内容）→ 原文不动', () => {
    const content = '引言段落\n\n# 阅览室设计\n\n正文';
    expect(stripDuplicateH1(content, '阅览室设计')).toBe(content);
  });

  it('H1 前有空白行仍视为首个内容行 → 剥除', () => {
    const out = stripDuplicateH1('\n\n# 阅览室设计\n\n正文', '阅览室设计');
    expect(out).toBe('正文');
  });

  it('标题比较忽略首尾空白', () => {
    const out = stripDuplicateH1('#   阅览室设计  \n正文', '阅览室设计 ');
    expect(out).toBe('正文');
  });

  it('无 H1 → 原文不动', () => {
    const content = '## 二级标题\n\n正文';
    expect(stripDuplicateH1(content, '阅览室设计')).toBe(content);
  });

  it('`#` 后无空格（非 ATX H1）→ 原文不动', () => {
    const content = '#阅览室设计\n\n正文';
    expect(stripDuplicateH1(content, '阅览室设计')).toBe(content);
  });

  it('剥除后去掉紧跟的空行，余下正文保持原样', () => {
    const out = stripDuplicateH1('# T\n\n\n- a\n- b', 'T');
    expect(out).toBe('- a\n- b');
  });

  it('正文只有重复 H1 → 返回空串', () => {
    expect(stripDuplicateH1('# T', 'T')).toBe('');
  });

  it('空内容 / 空标题 → 原样返回', () => {
    expect(stripDuplicateH1('', 'T')).toBe('');
    expect(stripDuplicateH1('# T', '')).toBe('# T');
  });
});
