/**
 * AES-256-GCM 加密工具
 * (从已删除的 meetings/encryption.ts 迁移)
 */

import crypto from 'crypto';

function getKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY || 'dev-key-change-in-production-32ch';
  return crypto.createHash('sha256').update(key).digest();
}

export function encrypt(plaintext: string): { encrypted: string; iv: string; tag: string } {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    encrypted: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export function decrypt(data: { encrypted: string; iv: string; tag: string }): string {
  const key = getKey();
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(data.iv, 'base64'));
  decipher.setAuthTag(Buffer.from(data.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(data.encrypted, 'base64')),
    decipher.final(),
  ]);
  return decrypted.toString('utf8');
}
