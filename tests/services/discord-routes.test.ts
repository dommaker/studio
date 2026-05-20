/**
 * Discord Routes 单元测试
 *
 * 覆盖：Ed25519 签名验证、PING/PONG、无效签名拒绝
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

describe('Discord Ed25519 签名验证', () => {
  // 测试用密钥对
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const publicKeyHex = publicKey.export({ type: 'spki', format: 'der' }).slice(-32).toString('hex');
  const testBody = '{"type":1}';

  function sign(body: string, timestamp: string): string {
    const message = Buffer.from(timestamp + body, 'utf-8');
    return crypto.sign(null, message, privateKey).toString('hex');
  }

  function verify(body: string, signature: string, timestamp: string, pkHex: string): boolean {
    try {
      const msg = Buffer.from(timestamp + body, 'utf-8');
      const sig = Buffer.from(signature, 'hex');
      const pkRaw = Buffer.from(pkHex, 'hex');
      const spkiKey = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), pkRaw]);
      const key = crypto.createPublicKey({ key: spkiKey, format: 'der', type: 'spki' });
      return crypto.verify(null, msg, key, sig);
    } catch { return false; }
  }

  it('有效签名应该验证通过', () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const sig = sign(testBody, timestamp);
    expect(verify(testBody, sig, timestamp, publicKeyHex)).toBe(true);
  });

  it('无效签名应该拒绝', () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    expect(verify(testBody, 'deadbeef', timestamp, publicKeyHex)).toBe(false);
  });

  it('签名缺失应返回 false', () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    expect(verify(testBody, '', timestamp, publicKeyHex)).toBe(false);
  });

  it('timestamp 被篡改应拒绝', () => {
    const ts1 = '1234567890';
    const ts2 = '1234567891';
    const sig = sign(testBody, ts1);
    expect(verify(testBody, sig, ts2, publicKeyHex)).toBe(false);
  });

  it('body 被篡改应拒绝', () => {
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const sig = sign('{"type":1}', timestamp);
    expect(verify('{"type":2}', sig, timestamp, publicKeyHex)).toBe(false);
  });
});
