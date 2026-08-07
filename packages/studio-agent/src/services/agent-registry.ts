// Agent Registry - Agent 注册中心
import { FileStore, logger } from '@dommaker/studio-shared';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { AgentMetadata, JSONSchema } from '../types';

// Cache store interface
interface CacheStore {
  get(key: string): Promise<string | null>;
  setex(key: string, ttl: number, value: string): Promise<void>;
  keys(pattern: string): Promise<string[]>;
  del(...keys: string[]): Promise<void>;
}

const ajv = new Ajv({ allErrors: true, useDefaults: true });
addFormats(ajv);

export class AgentRegistry {
  private fileStore: FileStore;
  private store: CacheStore;
  private agentsDir = path.join(os.homedir(), '.studio', 'agents-registry');
  private cachePrefix = 'agent:';
  private cacheTTL = 3600; // 1 hour

  constructor(store: CacheStore) {
    this.fileStore = new FileStore();
    this.store = store;
  }

  private agentPath(id: string, version: string): string {
    return path.join(this.agentsDir, `${id}_${version}.json`);
  }

  private async scanAgents(filter?: { category?: string; tags?: string[] }): Promise<any[]> {
    const files = await fs.promises.readdir(this.agentsDir).catch(() => [] as string[]);
    const agents: any[] = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      const data = await this.fileStore.readJson<any>(path.join(this.agentsDir, f));
      if (data) {
        if (typeof data.createdAt === 'string') data.createdAt = new Date(data.createdAt);
        if (typeof data.updatedAt === 'string') data.updatedAt = new Date(data.updatedAt);
        if (filter?.category && data.category !== filter.category) continue;
        if (filter?.tags?.length) {
          const agentTags: string[] = typeof data.tags === 'string' ? JSON.parse(data.tags) : (data.tags || []);
          if (!filter.tags.some((t: string) => agentTags.includes(t))) continue;
        }
        agents.push(data);
      }
    }
    return agents;
  }

  /**
   * 注册新 Agent
   */
  async register(metadata: Omit<AgentMetadata, 'createdAt' | 'updatedAt'>): Promise<AgentMetadata> {
    // 验证 Schema
    this.validateSchemas(metadata);

    // 检查是否已存在
    const existingPath = this.agentPath(metadata.id, metadata.version);
    const existing = await this.fileStore.readJson<any>(existingPath);
    if (existing) {
      throw new Error(`Agent ${metadata.id} version ${metadata.version} already exists`);
    }

    // 创建 Agent
    const now = new Date();
    const agent = {
      id: metadata.id,
      name: metadata.name,
      version: metadata.version,
      description: metadata.description,
      category: metadata.category,
      icon: metadata.icon,
      tags: metadata.tags || [],
      inputSchema: metadata.inputSchema,
      outputSchema: metadata.outputSchema,
      configSchema: metadata.configSchema,
      endpoint: metadata.endpoint,
      timeout: metadata.timeout || 1800,
      retryPolicy: metadata.retryPolicy,
      rateLimit: metadata.rateLimit,
      metadata: metadata.metadata,
      createdAt: now,
      updatedAt: now,
    };

    await this.fileStore.writeJson(existingPath, agent);

    // 缓存 Agent
    await this.cacheAgent(agent.id, agent.version, this.toMetadata(agent));

    logger.info('Agent registered', { agentId: agent.id, version: agent.version });

    return this.toMetadata(agent);
  }

  /**
   * 获取 Agent 列表
   */
  async list(options?: {
    category?: string;
    tags?: string[];
    page?: number;
    limit?: number;
  }): Promise<{ data: AgentMetadata[]; total: number }> {
    const page = options?.page || 1;
    const limit = options?.limit || 20;

    const agents = await this.scanAgents({
      category: options?.category,
      tags: options?.tags,
    });

    // Sort by createdAt desc
    agents.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = agents.length;
    const skip = (page - 1) * limit;
    const paged = agents.slice(skip, skip + limit);

    return {
      data: paged.map((a) => this.toMetadata(a)),
      total,
    };
  }

  /**
   * 获取 Agent 详情
   */
  async get(id: string, version?: string): Promise<AgentMetadata | null> {
    // 尝试从缓存获取
    const cacheKey = `${this.cachePrefix}${id}:${version || 'latest'}`;
    const cached = await this.store.get(cacheKey);
    if (cached) {
      return JSON.parse(cached);
    }

    let agent: any = null;

    if (version) {
      // 精确版本查找
      const data = await this.fileStore.readJson<any>(this.agentPath(id, version));
      if (data) {
        if (typeof data.createdAt === 'string') data.createdAt = new Date(data.createdAt);
        if (typeof data.updatedAt === 'string') data.updatedAt = new Date(data.updatedAt);
        agent = data;
      }
    } else {
      // 查找最新版本
      const agents = await this.scanAgents();
      const matches = agents.filter((a) => a.id === id);
      if (matches.length > 0) {
        matches.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
        agent = matches[0];
      }
    }

    if (!agent) {
      return null;
    }

    const metadata = this.toMetadata(agent);

    // 缓存
    await this.cacheAgent(agent.id, agent.version, metadata);

    return metadata;
  }

  /**
   * 更新 Agent
   */
  async update(
    id: string,
    version: string,
    updates: Partial<AgentMetadata>
  ): Promise<AgentMetadata> {
    const filePath = this.agentPath(id, version);
    const agent = await this.fileStore.readJson<any>(filePath);

    if (!agent) {
      throw new Error(`Agent ${id} version ${version} not found`);
    }

    const updated = {
      ...agent,
      name: updates.name ?? agent.name,
      description: updates.description ?? agent.description,
      icon: updates.icon ?? agent.icon,
      tags: updates.tags ?? agent.tags,
      inputSchema: updates.inputSchema ?? agent.inputSchema,
      outputSchema: updates.outputSchema ?? agent.outputSchema,
      configSchema: updates.configSchema ?? agent.configSchema,
      endpoint: updates.endpoint ?? agent.endpoint,
      timeout: updates.timeout ?? agent.timeout,
      retryPolicy: updates.retryPolicy ?? agent.retryPolicy,
      rateLimit: updates.rateLimit ?? agent.rateLimit,
      metadata: updates.metadata ?? agent.metadata,
      updatedAt: new Date(),
    };

    await this.fileStore.writeJson(filePath, updated);

    // 失效缓存
    await this.invalidateCache(id, version);

    logger.info('Agent updated', { agentId: id, version });

    return this.toMetadata({
      ...updated,
      createdAt: typeof agent.createdAt === 'string' ? new Date(agent.createdAt) : agent.createdAt,
    });
  }

  /**
   * 删除 Agent
   */
  async delete(id: string, version: string): Promise<void> {
    const filePath = this.agentPath(id, version);
    await fs.promises.unlink(filePath);

    // 失效缓存
    await this.invalidateCache(id, version);

    logger.info('Agent deleted', { agentId: id, version });
  }

  /**
   * 验证 Schema
   */
  private validateSchemas(metadata: {
    inputSchema: JSONSchema;
    outputSchema: JSONSchema;
    configSchema: JSONSchema;
  }): void {
    try {
      ajv.compile(metadata.inputSchema);
      ajv.compile(metadata.outputSchema);
      ajv.compile(metadata.configSchema);
    } catch (error) {
      throw new Error(`Invalid JSON Schema: ${error}`);
    }
  }

  /**
   * 缓存 Agent
   */
  private async cacheAgent(id: string, version: string, metadata: AgentMetadata): Promise<void> {
    const key = `${this.cachePrefix}${id}:${version}`;
    await this.store.setex(key, this.cacheTTL, JSON.stringify(metadata));
  }

  /**
   * 失效缓存
   */
  private async invalidateCache(id: string, _version: string): Promise<void> {
    const keys = await this.store.keys(`${this.cachePrefix}${id}:*`);
    if (keys.length > 0) {
      await this.store.del(...keys);
    }
  }

  /**
   * 转换为 AgentMetadata
   */
  private toMetadata(agent: any): AgentMetadata {
    return {
      id: agent.id,
      name: agent.name,
      version: agent.version,
      description: agent.description || undefined,
      category: agent.category,
      icon: agent.icon || undefined,
      tags: agent.tags || undefined,
      inputSchema: agent.inputSchema,
      outputSchema: agent.outputSchema,
      configSchema: agent.configSchema,
      endpoint: agent.endpoint || undefined,
      timeout: agent.timeout,
      retryPolicy: agent.retryPolicy || undefined,
      rateLimit: agent.rateLimit || undefined,
      metadata: agent.metadata || undefined,
      createdAt: agent.createdAt.toISOString(),
      updatedAt: agent.updatedAt.toISOString(),
    };
  }
}
