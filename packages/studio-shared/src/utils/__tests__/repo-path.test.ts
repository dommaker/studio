// stripTrailingSlashes：尾斜杠/反斜杠归一 —— PMO gitRepo、workspaceRoot、
// 扫描发现路径的写法差（尾斜杠有无、Windows 反斜杠）不应影响比较/去重键。
import { describe, it, expect } from 'vitest';
import { stripTrailingSlashes } from '../repo-path';

describe('stripTrailingSlashes', () => {
  it('去除末尾连续斜杠与反斜杠', () => {
    expect(stripTrailingSlashes('/repo/studio/')).toBe('/repo/studio');
    expect(stripTrailingSlashes('/repo/studio//')).toBe('/repo/studio');
    expect(stripTrailingSlashes('C:\\repo\\studio\\\\')).toBe('C:\\repo\\studio');
    expect(stripTrailingSlashes('/repo/mixed/\\/')).toBe('/repo/mixed');
  });

  it('无尾斜杠原样返回；中间斜杠不动', () => {
    expect(stripTrailingSlashes('/repo/studio')).toBe('/repo/studio');
    expect(stripTrailingSlashes('/a/b/c')).toBe('/a/b/c');
  });

  it('边界：空串与全斜杠', () => {
    expect(stripTrailingSlashes('')).toBe('');
    expect(stripTrailingSlashes('/')).toBe('');
  });
});
