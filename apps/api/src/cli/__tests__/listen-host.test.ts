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

  it('只解析监听地址；组合安全性由统一 ExposurePolicy 判定', () => {
    expect(resolveListenHost({ HOST: '0.0.0.0' })).toBe('0.0.0.0');
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
