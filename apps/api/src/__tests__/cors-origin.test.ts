/**
 * cors-origin 白名单判定单测（2026-08-25 安全收口）。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { isAllowedOrigin, allowedOrigins } from '../cors-origin.js';

afterEach(() => {
  delete process.env.CORS_ORIGINS;
});

describe('isAllowedOrigin', () => {
  it('无 Origin 头（同源/curl/agent）放行', () => {
    expect(isAllowedOrigin(undefined)).toBe(true);
  });

  it('默认白名单：dommaker.cn 两域放行', () => {
    expect(isAllowedOrigin('https://dommaker.cn')).toBe(true);
    expect(isAllowedOrigin('https://www.dommaker.cn')).toBe(true);
  });

  it('本地开发源放行（localhost/127.0.0.1 任意端口，http/https）', () => {
    expect(isAllowedOrigin('http://localhost:13000')).toBe(true);
    expect(isAllowedOrigin('http://127.0.0.1:5173')).toBe(true);
    expect(isAllowedOrigin('https://localhost')).toBe(true);
  });

  it('cloudflared quick tunnel 放行', () => {
    expect(isAllowedOrigin('https://abc-def-123.trycloudflare.com')).toBe(true);
  });

  it('任意外域拒绝', () => {
    expect(isAllowedOrigin('https://evil.com')).toBe(false);
  });

  it('域名后缀伪装拒绝（dommaker.cn.evil.com）', () => {
    expect(isAllowedOrigin('https://dommaker.cn.evil.com')).toBe(false);
    expect(isAllowedOrigin('https://evil.trycloudflare.com.evil.com')).toBe(false);
  });

  it('CORS_ORIGINS 环境变量覆盖默认白名单', () => {
    process.env.CORS_ORIGINS = 'https://a.example.com, https://b.example.com';
    expect(allowedOrigins()).toEqual(['https://a.example.com', 'https://b.example.com']);
    expect(isAllowedOrigin('https://a.example.com')).toBe(true);
    expect(isAllowedOrigin('https://dommaker.cn')).toBe(false);
  });
});
