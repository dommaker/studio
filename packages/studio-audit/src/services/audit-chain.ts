/**
 * 审计链模块
 * 
 * 功能：
 * 1. 链式审计记录（previous_hash → current_hash）
 * 2. 操作签名防篡改
 * 3. 链完整性验证
 * 4. 审计查询
 */

import * as crypto from 'crypto';
import type { ContextSharer } from '@dommaker/studio-meeting';

// ==================== 类型定义 ====================

/**
 * 审计操作类型
 */
export type AuditAction =
  | 'task_created'
  | 'task_transitioned'
  | 'task_completed'
  | 'gate_checked'
  | 'gate_passed'
  | 'gate_failed'
  | 'meeting_created'
  | 'meeting_started'
  | 'meeting_completed'
  | 'role_joined'
  | 'role_left'
  | 'message_sent'
  | 'decision_made'
  | 'spec_changed'
  | 'skill_executed'
  | 'mcp_accessed'
  | 'balance_changed'
  | 'salary_paid';

/**
 * 审计条目
 */
export interface AuditChainEntry {
  // 唯一 ID
  id: string;

  // 链式结构
  previousHash: string;
  currentHash: string;

  // 时间戳
  timestamp: string;

  // 操作类型
  action: AuditAction;

  // 操作详情
  data: Record<string, any>;

  // 签名（防篡改）
  signature: string;

  // 签名者
  signer?: string;
}

/**
 * 审计链验证结果
 */
export interface ChainValidationResult {
  valid: boolean;
  totalEntries: number;
  invalidEntries: number;
  errors: Array<{
    entryId: string;
    error: string;
  }>;
}

/**
 * 审计链统计
 */
export interface AuditChainStats {
  totalEntries: number;
  firstEntryAt?: string;
  lastEntryAt?: string;
  actionsByType: Record<AuditAction, number>;
  signers: string[];
}

/**
 * 审计链配置
 */
export interface AuditChainConfig {
  contextSharer: ContextSharer;
  signingKey?: string;  // 签名密钥
  chainId?: string;     // 链 ID（默认 'default'）
}

// ==================== 常量 ====================

const MAX_AUDIT_ENTRIES = 10_000;  // 审计链最大保留条目数

// ==================== AuditChain 类 ====================

export class AuditChain {
  private contextSharer: ContextSharer;
  private signingKey: string;
  private chainId: string;

  constructor(config: AuditChainConfig) {
    this.contextSharer = config.contextSharer;
    this.signingKey = config.signingKey ?? 'default-signing-key';
    this.chainId = config.chainId ?? 'default';
  }

  // ==================== 记录审计 ====================

  /**
   * 记录审计条目
   */
  async record(
    action: AuditAction,
    data: Record<string, any>,
    signer?: string
  ): Promise<AuditChainEntry> {
    const timestamp = new Date().toISOString();

    // 获取上一条记录的 hash
    const previousEntry = await this.getLastEntry();
    const previousHash = previousEntry?.currentHash ?? 'genesis';

    // 创建条目
    const entry: Omit<AuditChainEntry, 'currentHash' | 'signature'> = {
      id: this.generateId(timestamp),
      previousHash,
      timestamp,
      action,
      data,
      signer,
    };

    // 计算 hash
    const currentHash = this.computeHash(entry);

    // 生成签名
    const signature = this.sign(entry, currentHash);

    // 完整条目
    const fullEntry: AuditChainEntry = {
      ...entry,
      currentHash,
      signature,
    };

    // 存储
    await this.appendEntry(fullEntry);

    return fullEntry;
  }

  /**
   * 批量记录审计
   */
  async recordBatch(
    entries: Array<{ action: AuditAction; data: Record<string, any>; signer?: string }>
  ): Promise<AuditChainEntry[]> {
    const results: AuditChainEntry[] = [];

    for (const entry of entries) {
      const recorded = await this.record(entry.action, entry.data, entry.signer);
      results.push(recorded);
    }

    return results;
  }

  // ==================== 验证链 ====================

  /**
   * 验证链完整性
   */
  async validateChain(): Promise<ChainValidationResult> {
    const entries = await this.getAllEntries();
    const errors: Array<{ entryId: string; error: string }> = [];

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      const previousEntry = i > 0 ? entries[i - 1] : null;

      // 验证 previousHash
      if (i === 0) {
        if (entry.previousHash !== 'genesis') {
          errors.push({
            entryId: entry.id,
            error: 'First entry should have genesis as previousHash',
          });
        }
      } else {
        if (entry.previousHash !== previousEntry?.currentHash) {
          errors.push({
            entryId: entry.id,
            error: `previousHash mismatch: expected ${previousEntry?.currentHash}, got ${entry.previousHash}`,
          });
        }
      }

      // 验证 currentHash
      const computedHash = this.computeHash({
        id: entry.id,
        previousHash: entry.previousHash,
        timestamp: entry.timestamp,
        action: entry.action,
        data: entry.data,
        signer: entry.signer,
      });

      if (entry.currentHash !== computedHash) {
        errors.push({
          entryId: entry.id,
          error: 'currentHash mismatch: entry may have been tampered',
        });
      }

      // 验证签名
      const signatureValid = this.verifySignature(entry);
      if (!signatureValid) {
        errors.push({
          entryId: entry.id,
          error: 'Invalid signature',
        });
      }
    }

    return {
      valid: errors.length === 0,
      totalEntries: entries.length,
      invalidEntries: errors.length,
      errors,
    };
  }

  /**
   * 验证单个条目
   */
  validateEntry(entry: AuditChainEntry, previousEntry?: AuditChainEntry): boolean {
    // 验证 previousHash
    if (previousEntry) {
      if (entry.previousHash !== previousEntry.currentHash) {
        return false;
      }
    } else {
      if (entry.previousHash !== 'genesis') {
        return false;
      }
    }

    // 验证 currentHash
    const computedHash = this.computeHash({
      id: entry.id,
      previousHash: entry.previousHash,
      timestamp: entry.timestamp,
      action: entry.action,
      data: entry.data,
      signer: entry.signer,
    });

    if (entry.currentHash !== computedHash) {
      return false;
    }

    // 验证签名
    return this.verifySignature(entry);
  }

  // ==================== 查询审计 ====================

  /**
   * 获取所有条目
   */
  async getAllEntries(): Promise<AuditChainEntry[]> {
    const data = await this.contextSharer.getValue<AuditChainEntry[]>(this.getChainKey());
    return data ?? [];
  }

  /**
   * 获取最后 N 条条目
   */
  async getRecentEntries(limit: number = 100): Promise<AuditChainEntry[]> {
    const entries = await this.getAllEntries();
    return entries.slice(-limit);
  }

  /**
   * 按操作类型查询
   */
  async getEntriesByAction(action: AuditAction): Promise<AuditChainEntry[]> {
    const entries = await this.getAllEntries();
    return entries.filter(e => e.action === action);
  }

  /**
   * 按时间范围查询
   */
  async getEntriesByTimeRange(start: string, end: string): Promise<AuditChainEntry[]> {
    const entries = await this.getAllEntries();
    return entries.filter(e => e.timestamp >= start && e.timestamp <= end);
  }

  /**
   * 按签名者查询
   */
  async getEntriesBySigner(signer: string): Promise<AuditChainEntry[]> {
    const entries = await this.getAllEntries();
    return entries.filter(e => e.signer === signer);
  }

  /**
   * 获取统计信息
   */
  async getStats(): Promise<AuditChainStats> {
    const entries = await this.getAllEntries();

    const actionsByType: Record<string, number> = {};
    const signers = new Set<string>();

    for (const entry of entries) {
      actionsByType[entry.action] = (actionsByType[entry.action] ?? 0) + 1;
      if (entry.signer) {
        signers.add(entry.signer);
      }
    }

    return {
      totalEntries: entries.length,
      firstEntryAt: entries[0]?.timestamp,
      lastEntryAt: entries[entries.length - 1]?.timestamp,
      actionsByType: actionsByType as Record<AuditAction, number>,
      signers: Array.from(signers),
    };
  }

  // ==================== 导出/导入 ====================

  /**
   * 导出审计链
   */
  async export(): Promise<string> {
    const entries = await this.getAllEntries();
    return JSON.stringify(entries, null, 2);
  }

  /**
   * 导入审计链
   */
  async import(data: string): Promise<void> {
    const entries = JSON.parse(data) as AuditChainEntry[];
    await this.contextSharer.set(this.getChainKey(), entries);
  }

  // ==================== 私有方法 ====================

  private getChainKey(): string {
    return `audit-chain:${this.chainId}`;
  }

  private generateId(timestamp: string): string {
    const random = Math.random().toString(36).slice(2, 9);
    return `audit-${timestamp.replace(/[:.]/g, '-')}-${random}`;
  }

  private async getLastEntry(): Promise<AuditChainEntry | null> {
    const entries = await this.getAllEntries();
    return entries.length > 0 ? entries[entries.length - 1] : null;
  }

  private async appendEntry(entry: AuditChainEntry): Promise<void> {
    const entries = await this.getAllEntries();
    entries.push(entry);
    
    // 只保留最近 N 条
    const trimmed = entries.slice(-MAX_AUDIT_ENTRIES);
    await this.contextSharer.set(this.getChainKey(), trimmed);
  }

  /**
   * 计算 hash
   */
  private computeHash(entry: Omit<AuditChainEntry, 'currentHash' | 'signature'>): string {
    const content = JSON.stringify({
      id: entry.id,
      previousHash: entry.previousHash,
      timestamp: entry.timestamp,
      action: entry.action,
      data: entry.data,
      signer: entry.signer,
    });

    return 'sha256:' + crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * 生成签名
   */
  private sign(
    entry: Omit<AuditChainEntry, 'currentHash' | 'signature'>,
    hash: string
  ): string {
    const content = JSON.stringify({
      ...entry,
      currentHash: hash,
    });

    const hmac = crypto.createHmac('sha256', this.signingKey);
    hmac.update(content);
    return 'sig:' + hmac.digest('hex');
  }

  /**
   * 验证签名
   */
  private verifySignature(entry: AuditChainEntry): boolean {
    try {
      const content = JSON.stringify({
        id: entry.id,
        previousHash: entry.previousHash,
        timestamp: entry.timestamp,
        action: entry.action,
        data: entry.data,
        signer: entry.signer,
        currentHash: entry.currentHash,
      });

      const hmac = crypto.createHmac('sha256', this.signingKey);
      hmac.update(content);
      const expectedSignature = 'sig:' + hmac.digest('hex');

      return entry.signature === expectedSignature;
    } catch {
      return false;
    }
  }
}

// ==================== 实现 Auditor 接口 ====================

import type { Auditor, AuditEntry } from '@dommaker/studio-meeting/orchestration/state-listener';

/**
 * 审计链适配器
 * 
 * 实现 Auditor 接口，使用 AuditChain 存储
 */
export class AuditChainAdapter implements Auditor {
  private chain: AuditChain;

  constructor(chain: AuditChain) {
    this.chain = chain;
  }

  async record(entry: AuditEntry): Promise<void> {
    await this.chain.record(entry.type as AuditAction, {
      ...entry.data,
      meetingId: entry.meetingId,
    });
  }
}

// ==================== 工厂函数 ====================

export function createAuditChain(config: AuditChainConfig): AuditChain {
  return new AuditChain(config);
}

export function createAuditChainAdapter(chain: AuditChain): Auditor {
  return new AuditChainAdapter(chain);
}
