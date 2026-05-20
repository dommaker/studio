// 会议内容加密服务（P2-5）
// 使用 AES-256-GCM 加密敏感会议内容

import * as crypto from 'crypto';
import { logger } from '../../utils/logger.js';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // GCM 推荐 12 字节
const AUTH_TAG_LENGTH = 16;

export interface EncryptedData {
  encrypted: string; // Base64 编码的加密数据
  iv: string; // Base64 编码的初始化向量
  authTag: string; // Base64 编码的认证标签
}

/**
 * 获取加密密钥
 * 从环境变量读取，如果没有则生成一个临时密钥（仅用于开发）
 */
function getEncryptionKey(): Buffer {
  const key = process.env.MEETING_ENCRYPTION_KEY;
  
  if (key) {
    // 从 Base64 解码
    return Buffer.from(key, 'base64');
  }
  
  // 开发环境：使用固定密钥（生产环境必须设置环境变量）
  logger.warn('MEETING_ENCRYPTION_KEY not set, using development key');
  const devKey = crypto.scryptSync('agent-studio-dev', 'salt', 32);
  return devKey;
}

/**
 * 加密文本内容
 */
export function encrypt(text: string): EncryptedData {
  if (!text) {
    throw new Error('Text to encrypt cannot be empty');
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(text, 'utf8', 'base64');
  encrypted += cipher.final('base64');

  const authTag = cipher.getAuthTag();

  return {
    encrypted,
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
  };
}

/**
 * 解密文本内容
 */
export function decrypt(data: EncryptedData): string {
  if (!data.encrypted || !data.iv || !data.authTag) {
    throw new Error('Invalid encrypted data');
  }

  const key = getEncryptionKey();
  const iv = Buffer.from(data.iv, 'base64');
  const authTag = Buffer.from(data.authTag, 'base64');

  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let decrypted = decipher.update(data.encrypted, 'base64', 'utf8');
  decrypted += decipher.final('utf8');

  return decrypted;
}

/**
 * 生成新的加密密钥（用于配置环境变量）
 */
export function generateEncryptionKey(): string {
  const key = crypto.randomBytes(32);
  return key.toString('base64');
}

/**
 * 检查内容是否已加密
 */
export function isEncrypted(data: any): data is EncryptedData {
  return (
    typeof data === 'object' &&
    data !== null &&
    typeof data.encrypted === 'string' &&
    typeof data.iv === 'string' &&
    typeof data.authTag === 'string'
  );
}

/**
 * 加密会议消息内容
 * 如果会议标记为敏感，则加密消息内容
 */
export function encryptMessage(content: string, isSensitive: boolean): string | EncryptedData {
  if (isSensitive) {
    return encrypt(content);
  }
  return content;
}

/**
 * 解密会议消息内容
 */
export function decryptMessage(data: string | EncryptedData): string {
  if (typeof data === 'string') {
    return data;
  }
  return decrypt(data);
}

/**
 * 加密会议纪要
 */
export function encryptSummary(summary: string): EncryptedData {
  return encrypt(summary);
}

/**
 * 解密会议纪要
 */
export function decryptSummary(data: EncryptedData): string {
  return decrypt(data);
}
