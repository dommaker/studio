// Studio Prisma — SQLite JSON 字段自动序列化/反序列化
// Prisma 5.22 $extends query hooks 替代 deprecated $use
import { PrismaClient } from '@prisma/client';

export { PrismaClient };

const JSON_FIELDS: Record<string, string[]> = {
  Agent: ['inputSchema', 'outputSchema', 'configSchema', 'retryPolicy', 'rateLimit', 'metadata'],
  ApiKey: ['permissions'],
  AuditLog: ['details', 'changes'],
  Capability: ['metadata'],
  OKR: ['objectives', 'keyResults'],
  Execution: ['parameters', 'nodeExecutions', 'error'],
  Project: ['spec', 'gitInfo'],
  Environment: ['envVars', 'mounts', 'resourceLimits'],
  AgentConfig: ['systemPrompt'],
  AgentConfigVersion: ['snapshot'],
  Task: ['input', 'output', 'metadata'],
  Document: ['content'],
  Countersign: ['config', 'signers'],
  DocumentFlow: ['steps'],
  RoleConfig: ['stances', 'boundSkills', 'boundConstraints', 'boundMcps', 'boundTools', 'executionParams', 'evolutionHooks', 'modelRouting'],

  MCPAuditLog: ['input', 'output'],
  DecisionAudit: ['evidence', 'context'],
  Incident: ['triageLog'],
};

// Build flat lookup set: "Model.field" → true
const jsonLookup = new Set<string>();
for (const [model, fields] of Object.entries(JSON_FIELDS)) {
  for (const f of fields) jsonLookup.add(`${model}.${f}`);
}

function serializeJsonFields(model: string | undefined, data: any): void {
  if (!model || !data || typeof data !== 'object') return;
  for (const [key, val] of Object.entries(data)) {
    if (val !== undefined && val !== null && typeof val === 'object' && !(val instanceof Date)) {
      if (jsonLookup.has(`${model}.${key}`)) {
        data[key] = JSON.stringify(val);
      }
    }
  }
}

function parseJsonFields(model: string | undefined, result: any): void {
  if (!model || !result) return;
  const items = Array.isArray(result) ? result : [result];
  for (const row of items) {
    if (!row || typeof row !== 'object') continue;
    for (const key of Object.keys(row)) {
      if (jsonLookup.has(`${model}.${key}`) && typeof row[key] === 'string') {
        try { row[key] = JSON.parse(row[key]); } catch (e) { console.warn('[Prisma] Failed to parse JSON field', { model, key, error: String(e) }); }
      }
    }
  }
}

const prisma = new PrismaClient({
  log: [
    { level: 'error', emit: 'stdout' },
    { level: 'warn', emit: 'stdout' },
  ],
}).$extends({
  query: {
    $allModels: {
      // Write hooks: serialize before DB write
      async create({ model, args, query }) {
        serializeJsonFields(model, (args as any).data);
        return query(args);
      },
      async createMany({ model, args, query }) {
        const data = (args as any).data;
        if (Array.isArray(data)) {
          for (const item of data) serializeJsonFields(model, item);
        } else {
          serializeJsonFields(model, data);
        }
        return query(args);
      },
      async update({ model, args, query }) {
        serializeJsonFields(model, (args as any).data);
        return query(args);
      },
      async updateMany({ model, args, query }) {
        serializeJsonFields(model, (args as any).data);
        return query(args);
      },
      async upsert({ model, args, query }) {
        serializeJsonFields(model, (args as any).create);
        serializeJsonFields(model, (args as any).update);
        return query(args);
      },
      // Read hooks: parse after DB read
      async findUnique({ model, args, query }) {
        const result = await query(args);
        parseJsonFields(model, result);
        return result;
      },
      async findUniqueOrThrow({ model, args, query }) {
        const result = await query(args);
        parseJsonFields(model, result);
        return result;
      },
      async findFirst({ model, args, query }) {
        const result = await query(args);
        parseJsonFields(model, result);
        return result;
      },
      async findFirstOrThrow({ model, args, query }) {
        const result = await query(args);
        parseJsonFields(model, result);
        return result;
      },
      async findMany({ model, args, query }) {
        const result = await query(args);
        parseJsonFields(model, result);
        return result;
      },
    },
  },
});

export type ExtendedPrismaClient = typeof prisma;
export { prisma };
