/**
 * Path Sandbox tests — P6-02 path traversal protection
 */
import { describe, it, expect } from 'vitest';
import { resolveSafePath } from '../path-sandbox.js';

describe('resolveSafePath', () => {
  const root = '/home/user/workspace';

  it('resolves simple relative path', () => {
    expect(resolveSafePath(root, 'src')).toBe('/home/user/workspace/src');
  });

  it('resolves nested path', () => {
    expect(resolveSafePath(root, 'src/components')).toBe('/home/user/workspace/src/components');
  });

  it('returns root for empty string', () => {
    expect(resolveSafePath(root, '')).toBe(root);
  });

  it('returns root for "."', () => {
    expect(resolveSafePath(root, '.')).toBe(root);
  });

  it('returns root for "/"', () => {
    expect(resolveSafePath(root, '/')).toBe(root);
  });

  it('blocks ../ traversal', () => {
    expect(() => resolveSafePath(root, '../../etc/passwd')).toThrow('Path traversal blocked');
  });

  it('blocks encoded traversal', () => {
    expect(() => resolveSafePath(root, '../..')).toThrow('Path traversal blocked');
  });

  it('blocks absolute path escape', () => {
    expect(() => resolveSafePath(root, '/etc/passwd')).toThrow('Path traversal blocked');
  });

  it('allows paths that stay within root', () => {
    expect(resolveSafePath(root, 'a/b/c')).toBe('/home/user/workspace/a/b/c');
  });

  it('blocks path that resolves outside root', () => {
    expect(() => resolveSafePath(root, 'a/../../tmp')).toThrow('Path traversal blocked');
  });

  it('handles trailing slash in root', () => {
    expect(resolveSafePath('/home/user/workspace/', 'src')).toBe('/home/user/workspace/src');
  });

  it('handles dots in valid path', () => {
    expect(resolveSafePath(root, 'src/../src/file.ts')).toBe('/home/user/workspace/src/file.ts');
  });
});
