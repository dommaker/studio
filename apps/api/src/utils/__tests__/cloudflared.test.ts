/**
 * cloudflared.ts 单元测试（#571 冲突 5 冻结结论：外联隧道默认关）。
 *
 * 行为翻转：仅显式 CLOUDFLARED_ENABLED=true 才启用；
 * 未设置 / 'false' / 其他值（含 '1'、'yes'）一律不启用。
 */
import { describe, it, expect } from 'vitest';
import { isCloudflaredEnabled } from '../cloudflared.js';

describe('isCloudflaredEnabled', () => {
  it('未设置 → 默认关', () => {
    expect(isCloudflaredEnabled({})).toBe(false);
  });

  it("CLOUDFLARED_ENABLED='true' → 开", () => {
    expect(isCloudflaredEnabled({ CLOUDFLARED_ENABLED: 'true' })).toBe(true);
  });

  it("CLOUDFLARED_ENABLED='false' → 关", () => {
    expect(isCloudflaredEnabled({ CLOUDFLARED_ENABLED: 'false' })).toBe(false);
  });

  it("其他值（'1'/'yes'/空串）→ 关（仅精确 'true' 开启）", () => {
    expect(isCloudflaredEnabled({ CLOUDFLARED_ENABLED: '1' })).toBe(false);
    expect(isCloudflaredEnabled({ CLOUDFLARED_ENABLED: 'yes' })).toBe(false);
    expect(isCloudflaredEnabled({ CLOUDFLARED_ENABLED: '' })).toBe(false);
  });

  it('缺省读 process.env', () => {
    const prev = process.env.CLOUDFLARED_ENABLED;
    delete process.env.CLOUDFLARED_ENABLED;
    try {
      expect(isCloudflaredEnabled()).toBe(false);
      process.env.CLOUDFLARED_ENABLED = 'true';
      expect(isCloudflaredEnabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.CLOUDFLARED_ENABLED;
      else process.env.CLOUDFLARED_ENABLED = prev;
    }
  });
});
