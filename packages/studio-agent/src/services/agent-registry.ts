// Agent Registry - Agent 注册中心
import type { ExtendedPrismaClient } from '@dommaker/studio-prisma';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import { v4 as uuidv4 } from 'uuid';
// Cache store interface
interface CacheStore {
  get(key: string): Promise<string | null>;
  setex(key: string, ttl: number, value: string): Promise<void>;
  keys(pattern: string): Promise<string[]>;
  del(...keys: string[]): Promise<void>;
}
import { logger } from '@dommaker/studio-shared';
import type { AgentMetadata, JSONSchema } from '../types';

const ajv = new Ajv({ allErrors: true, useDefaults: true });
addFormats(ajv);

export class AgentRegistry {
  private prisma: ExtendedPrismaClient;
  private store: CacheStore;
  private cachePrefix = 'agent:';
  private cacheTTL = 3600; // 1 hour

  constructor(prisma: ExtendedPrismaClient, store: CacheStore) {
    this.prisma = prisma;
    this.store = store;
  }

  /**
   * 注册新 Agent
   */
  async register(metadata: Omit<AgentMetadata, 'createdAt' | 'updatedAt'>): Promise<AgentMetadata> {
    // 验证 Schema
    this.validateSchemas(metadata);

    // 检查是否已存在
    const existing = await this.prisma.agent.findFirst({
      where: { id: metadata.id, version: metadata.version },
    });

    if (existing) {
      throw new Error(`Agent ${metadata.id} version ${metadata.version} already exists`);
    }

    // 创建 Agent
    const agent = await this.prisma.agent.create({
      data: {
        id: metadata.id,
        name: metadata.name,
        version: metadata.version,
        description: metadata.description,
        category: metadata.category,
        icon: metadata.icon,
        tags: JSON.stringify(metadata.tags || []),
        inputSchema: metadata.inputSchema as any,
        outputSchema: metadata.outputSchema as any,
        configSchema: metadata.configSchema as any,
        endpoint: metadata.endpoint,
        timeout: metadata.timeout || 1800,
        retryPolicy: metadata.retryPolicy as any,
        rateLimit: metadata.rateLimit as any,
        metadata: metadata.metadata as any,
      },
    });

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
    const skip = (page - 1) * limit;

    const where: any = {};
    if (options?.category) {
      where.category = options.category;
    }
    if (options?.tags && options.tags.length > 0) {
      where.tags = { hasSome: options.tags };
    }

    const [agents, total] = await Promise.all([
      this.prisma.agent.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ createdAt: 'desc' }],
      }),
      this.prisma.agent.count({ where }),
    ]);

    return {
      data: agents.map((a) => this.toMetadata(a)),
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

    // 从数据库获取
    const agent = await this.prisma.agent.findFirst({
      where: version ? { id, version } : { id },
      orderBy: version ? undefined : { createdAt: 'desc' },
    });

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
    const agent = await this.prisma.agent.update({
      where: { id_version: { id, version } },
      data: {
        name: updates.name,
        description: updates.description,
        icon: updates.icon,
        tags: JSON.stringify(updates.tags),
        inputSchema: updates.inputSchema as any,
        outputSchema: updates.outputSchema as any,
        configSchema: updates.configSchema as any,
        endpoint: updates.endpoint,
        timeout: updates.timeout,
        retryPolicy: updates.retryPolicy as any,
        rateLimit: updates.rateLimit as any,
        metadata: updates.metadata as any,
        updatedAt: new Date(),
      },
    });

    // 失效缓存
    await this.invalidateCache(id, version);

    logger.info('Agent updated', { agentId: id, version });

    return this.toMetadata(agent);
  }

  /**
   * 删除 Agent
   */
  async delete(id: string, version: string): Promise<void> {
    await this.prisma.agent.delete({
      where: { id_version: { id, version } },
    });

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
  private async invalidateCache(id: string, version: string): Promise<void> {
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
