import { describe, it, expect } from 'vitest';
import { isLoopbackHost, resolveListenHost } from '../listen-host.js';

describe('resolveListenHost', () => {
  it('默认绑 127.0.0.1（HOST 未设置）', () => {
    expect(resolveListenHost({})).toBe('127.0.0.1');
    expect(resolveListenHost({ STUDIO_AUTH: 'on' })).toBe('127.0.0.1');
  });

  it('显式 HOST 原样返回（STUDIO_AUTH=on）', () => {
    expect(resolveListenHost({ HOST: '0.0.0.0', STUDIO_AUTH: 'on' })).toBe('0.0.0.0');
    expect(resolveListenHost({ HOST: '::', STUDIO_AUTH: 'on' })).toBe('::');
  });

  it('STUDIO_AUTH 未设置（默认 none）+ 非回环 HOST → 拒启', () => {
    expect(() => resolveListenHost({ HOST: '0.0.0.0' })).toThrow(/STUDIO_AUTH=none/);
    expect(() => resolveListenHost({ HOST: '49.232.195.87' })).toThrow();
  });

  it('STUDIO_AUTH=none + 回环 HOST → 放行', () => {
    expect(resolveListenHost({ HOST: '127.0.0.1', STUDIO_AUTH: 'none' })).toBe('127.0.0.1');
    expect(resolveListenHost({ HOST: 'localhost', STUDIO_AUTH: 'none' })).toBe('localhost');
    expect(resolveListenHost({ HOST: '::1', STUDIO_AUTH: 'none' })).toBe('::1');
    expect(resolveListenHost({ STUDIO_AUTH: 'none' })).toBe('127.0.0.1');
  });

  it('isLoopbackHost', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('::')).toBe(false);
  });
});
