/**
 * Capability Service - 能力管理服务
 *
 * 负责能力的 CRUD、同步、统计
 *
 * AC-C4: 从 Prisma 迁移到 FileStore JSON 文件存储
 * 每个能力存储为 ~/.studio/capabilities/{name}.json
 */

import { FileStore, logger } from '@dommaker/studio-shared';
import { getRegistryPath } from '@dommaker/harness';
import * as fs from 'fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ─── 类型定义 ───

/** 能力数据接口（替换 PrismaCapability） */
interface CapabilityData {
  id: string;
  name: string;
  type: string;
  description: string | null;
  cost: number;
  status: string;
  metadata: Record<string, unknown> | null;
  ownershipType: string | null;
  ownerId: string | null;
  price: number | null;
  rating: number;
  usageCount: number;
  reviewStatus: string;
  autoTestStatus: string;
  userApprovalStatus: string;
  createdAt: string;
  updatedAt: string;
}

// 能力类型定义（来自 registry）
interface RegistryCapability {
  name: string;
  type: 'tool' | 'skill';
  category: string;
  description: string;
  path: string;
}

interface Registry {
  tools: RegistryCapability[];
}

// ─── 常量 ───

const CAPABILITIES_DIR = path.join(os.homedir(), '.studio', 'capabilities');

// 能力消耗配置（按类型）
const CAPABILITY_COST: Record<string, number> = {
  tool: 1000,
  step: 3000,
  skill: 5000,
};

export class CapabilityService {
  private registryPath: string;

  constructor(private fileStore: FileStore, registryPath?: string) {
    this.registryPath = registryPath || getRegistryPath();
  }

  // ─── 内部工具方法 ───

  /** 根据 name 生成文件路径 */
  private capPath(name: string): string {
    return path.join(CAPABILITIES_DIR, `${name}.json`);
  }

  /** 生成唯一 ID */
  private generateId(): string {
    return `cap_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  /** 扫描 capabilities 目录，读取所有能力文件 */
  private async scanAll(): Promise<CapabilityData[]> {
    try {
      await fs.promises.mkdir(CAPABILITIES_DIR, { recursive: true });
      const entries = await fs.promises.readdir(CAPABILITIES_DIR, { withFileTypes: true });
      const results: CapabilityData[] = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const data = await this.fileStore.readJson<CapabilityData>(path.join(CAPABILITIES_DIR, entry.name));
        if (data) results.push(data);
      }
      return results;
    } catch {
      return [];
    }
  }

  /**
   * 创建能力
   */
  async create(input: {
    name: string;
    type: string;
    description?: string;
    cost?: number;
    metadata?: Record<string, unknown>;
  }): Promise<CapabilityData> {
    const cost = input.cost || CAPABILITY_COST[input.type] || 1000;
    const now = new Date().toISOString();

    const data: CapabilityData = {
      id: this.generateId(),
      name: input.name,
      type: input.type,
      description: input.description || null,
      cost,
      status: 'active',
      metadata: input.metadata || null,
      ownershipType: null,
      ownerId: null,
      price: null,
      rating: 0,
      usageCount: 0,
      reviewStatus: 'pending',
      autoTestStatus: 'pending',
      userApprovalStatus: 'pending',
      createdAt: now,
      updatedAt: now,
    };

    const filePath = this.capPath(input.name);
    // 检查是否已存在
    try {
      await fs.promises.access(filePath, fs.constants.F_OK);
      throw new Error(`Capability already exists: ${input.name}`);
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith('Capability already exists')) throw err;
      // ENOENT — 文件不存在，继续创建
    }

    await this.fileStore.writeJson(filePath, data);
    logger.info(`Created capability: ${input.name}`);
    return data;
  }

  /**
   * 批量创建能力
   */
  async createMany(capabilities: Array<{
    name: string;
    type: string;
    description?: string;
    cost?: number;
    metadata?: Record<string, unknown>;
  }>): Promise<number> {
    let count = 0;
    for (const c of capabilities) {
      try {
        await this.create(c);
        count++;
      } catch (err) {
        logger.warn(`Failed to create capability ${c.name}`, { error: err instanceof Error ? err.message : String(err) });
      }
    }
    logger.info(`Created ${count} capabilities`);
    return count;
  }

  /**
   * 获取能力详情
   */
  async getById(capabilityId: string): Promise<CapabilityData | null> {
    const all = await this.scanAll();
    return all.find(c => c.id === capabilityId) || null;
  }

  /**
   * 按名称获取能力
   */
  async getByName(name: string, type?: string): Promise<CapabilityData | null> {
    const data = await this.fileStore.readJson<CapabilityData>(this.capPath(name));
    if (!data) return null;
    if (type && data.type !== type) return null;
    return data;
  }

  /**
   * 获取能力列表
   */
  async list(options?: {
    type?: string;
    status?: string;
    page?: number;
    limit?: number;
  }): Promise<{ data: CapabilityData[]; total: number }> {
    const { type, status, page = 1, limit = 50 } = options || {};

    let all = await this.scanAll();

    // 过滤
    if (type) all = all.filter(c => c.type === type);
    if (status) all = all.filter(c => c.status === status);

    // 排序：type asc, name asc
    all.sort((a, b) => {
      const typeCmp = a.type.localeCompare(b.type);
      if (typeCmp !== 0) return typeCmp;
      return a.name.localeCompare(b.name);
    });

    const total = all.length;
    const skip = (page - 1) * limit;
    const data = all.slice(skip, skip + limit);

    return { data, total };
  }

  /**
   * 更新能力
   */
  async update(capabilityId: string, input: {
    description?: string;
    cost?: number;
    status?: string;
    metadata?: Record<string, unknown>;
  }): Promise<CapabilityData> {
    const all = await this.scanAll();
    const existing = all.find(c => c.id === capabilityId);
    if (!existing) throw new Error(`Capability not found: ${capabilityId}`);

    const merged: CapabilityData = {
      ...existing,
      ...input,
      metadata: input.metadata !== undefined ? input.metadata : existing.metadata,
      updatedAt: new Date().toISOString(),
    };

    await this.fileStore.writeJson(this.capPath(existing.name), merged);
    return merged;
  }

  /**
   * 删除能力
   */
  async delete(capabilityId: string): Promise<void> {
    const all = await this.scanAll();
    const existing = all.find(c => c.id === capabilityId);
    if (!existing) throw new Error(`Capability not found: ${capabilityId}`);

    await fs.promises.unlink(this.capPath(existing.name));
    logger.info(`Deleted capability: ${existing.name}`);
  }

  /**
   * 从 Registry 同步能力到文件存储
   */
  async syncFromRegistry(): Promise<{
    added: number;
    updated: number;
    total: number;
  }> {
    // 读取 Registry
    const registry = this.loadRegistry();

    const allCapabilities: RegistryCapability[] = [
      ...registry.tools.map((c) => ({ ...c, type: 'tool' as const })),
    ];

    let added = 0;
    let updated = 0;

    for (const cap of allCapabilities) {
      const existing = await this.getByName(cap.name, cap.type);

      if (existing) {
        // 更新描述
        if (cap.description !== existing.description) {
          await this.fileStore.writeJson(this.capPath(existing.name), {
            ...existing,
            description: cap.description,
            updatedAt: new Date().toISOString(),
          });
          updated++;
        }
      } else {
        // 创建新能力
        await this.create({
          name: cap.name,
          type: cap.type,
          description: cap.description,
          metadata: {
            category: cap.category,
            path: cap.path,
          },
        });
        added++;
      }
    }

    logger.info(`Synced capabilities from registry: added ${added}, updated ${updated}`);

    return {
      added,
      updated,
      total: allCapabilities.length,
    };
  }

  /**
   * 加载 Registry 文件
   */
  private loadRegistry(): Registry {
    try {
      const content = fs.readFileSync(this.registryPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      logger.error('Failed to load registry', { error: error instanceof Error ? error.message : String(error) });
      return { tools: [] };
    }
  }

  /**
   * 获取能力统计
   */
  async getStats(): Promise<{
    total: number;
    byType: Record<string, number>;
    byStatus: Record<string, number>;
  }> {
    const capabilities = await this.scanAll();

    const byType: Record<string, number> = {};
    const byStatus: Record<string, number> = {};

    for (const cap of capabilities) {
      byType[cap.type] = (byType[cap.type] || 0) + 1;
      byStatus[cap.status] = (byStatus[cap.status] || 0) + 1;
    }

    return {
      total: capabilities.length,
      byType,
      byStatus,
    };
  }

  /**
   * 获取能力消耗配置
   */
  getCostConfig(): Record<string, number> {
    return CAPABILITY_COST;
  }
}