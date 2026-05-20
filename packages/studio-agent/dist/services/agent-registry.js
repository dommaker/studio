"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.AgentRegistry = void 0;
const ajv_1 = __importDefault(require("ajv"));
const ajv_formats_1 = __importDefault(require("ajv-formats"));
const studio_shared_1 = require("@dommaker/studio-shared");
const ajv = new ajv_1.default({ allErrors: true, useDefaults: true });
(0, ajv_formats_1.default)(ajv);
class AgentRegistry {
    prisma;
    store;
    cachePrefix = 'agent:';
    cacheTTL = 3600; // 1 hour
    constructor(prisma, store) {
        this.prisma = prisma;
        this.store = store;
    }
    /**
     * 注册新 Agent
     */
    async register(metadata) {
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
                inputSchema: metadata.inputSchema,
                outputSchema: metadata.outputSchema,
                configSchema: metadata.configSchema,
                endpoint: metadata.endpoint,
                timeout: metadata.timeout || 1800,
                retryPolicy: metadata.retryPolicy,
                rateLimit: metadata.rateLimit,
                metadata: metadata.metadata,
            },
        });
        // 缓存 Agent
        await this.cacheAgent(agent.id, agent.version, this.toMetadata(agent));
        studio_shared_1.logger.info('Agent registered', { agentId: agent.id, version: agent.version });
        return this.toMetadata(agent);
    }
    /**
     * 获取 Agent 列表
     */
    async list(options) {
        const page = options?.page || 1;
        const limit = options?.limit || 20;
        const skip = (page - 1) * limit;
        const where = {};
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
    async get(id, version) {
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
    async update(id, version, updates) {
        const agent = await this.prisma.agent.update({
            where: { id_version: { id, version } },
            data: {
                name: updates.name,
                description: updates.description,
                icon: updates.icon,
                tags: JSON.stringify(updates.tags),
                inputSchema: updates.inputSchema,
                outputSchema: updates.outputSchema,
                configSchema: updates.configSchema,
                endpoint: updates.endpoint,
                timeout: updates.timeout,
                retryPolicy: updates.retryPolicy,
                rateLimit: updates.rateLimit,
                metadata: updates.metadata,
                updatedAt: new Date(),
            },
        });
        // 失效缓存
        await this.invalidateCache(id, version);
        studio_shared_1.logger.info('Agent updated', { agentId: id, version });
        return this.toMetadata(agent);
    }
    /**
     * 删除 Agent
     */
    async delete(id, version) {
        await this.prisma.agent.delete({
            where: { id_version: { id, version } },
        });
        // 失效缓存
        await this.invalidateCache(id, version);
        studio_shared_1.logger.info('Agent deleted', { agentId: id, version });
    }
    /**
     * 验证 Schema
     */
    validateSchemas(metadata) {
        try {
            ajv.compile(metadata.inputSchema);
            ajv.compile(metadata.outputSchema);
            ajv.compile(metadata.configSchema);
        }
        catch (error) {
            throw new Error(`Invalid JSON Schema: ${error}`);
        }
    }
    /**
     * 缓存 Agent
     */
    async cacheAgent(id, version, metadata) {
        const key = `${this.cachePrefix}${id}:${version}`;
        await this.store.setex(key, this.cacheTTL, JSON.stringify(metadata));
    }
    /**
     * 失效缓存
     */
    async invalidateCache(id, version) {
        const keys = await this.store.keys(`${this.cachePrefix}${id}:*`);
        if (keys.length > 0) {
            await this.store.del(...keys);
        }
    }
    /**
     * 转换为 AgentMetadata
     */
    toMetadata(agent) {
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
exports.AgentRegistry = AgentRegistry;
