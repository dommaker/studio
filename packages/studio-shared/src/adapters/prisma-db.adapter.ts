/**
 * PrismaDBAdapter — @dommaker/studio-toolbox 的 Prisma 实现
 *
 * 将 Prisma 的 typed API 映射到 toolbox 的抽象 DBAdapter 接口。
 */
import type { DBAdapter, QueryFilter } from '@dommaker/studio-toolbox';

export function createPrismaDBAdapter(prisma: any): DBAdapter {
  // 辅助：把 { contains: "x" } 翻译为 Prisma contains
  const translateFilter = (filter: QueryFilter): any => {
    const result: any = {};
    for (const [key, value] of Object.entries(filter)) {
      if (key === 'OR') {
        result.OR = (value as any[]).map(translateFilter);
      } else if (key === 'AND') {
        result.AND = (value as any[]).map(translateFilter);
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        if ('contains' in value) {
          result[key] = { contains: value.contains, mode: 'insensitive' };
        } else if ('gte' in value || 'lte' in value || 'gt' in value || 'lt' in value) {
          result[key] = value;
        } else {
          result[key] = value;
        }
      } else {
        result[key] = value;
      }
    }
    return result;
  };

  return {
    async create(table: string, data: Record<string, any>) {
      return prisma[table].create({ data });
    },

    async findMany(table: string, filter: QueryFilter, options?) {
      const where = translateFilter(filter);
      const query: any = { where };
      if (options?.take) query.take = options.take;
      if (options?.skip) query.skip = options.skip;
      if (options?.orderBy) query.orderBy = options.orderBy;
      if (options?.select) {
        query.select = {};
        for (const k of options.select) query.select[k] = true;
      }
      return prisma[table].findMany(query);
    },

    async findUnique(table: string, filter: QueryFilter) {
      const where = translateFilter(filter);
      return prisma[table].findUnique({ where });
    },

    async update(table: string, filter: QueryFilter, data: Record<string, any>) {
      const where = translateFilter(filter);
      return prisma[table].update({ where, data });
    },

    async delete(table: string, filter: QueryFilter) {
      const where = translateFilter(filter);
      const result = await prisma[table].deleteMany({ where });
      return result.count;
    },

    async count(table: string, filter?: QueryFilter) {
      const where = filter ? translateFilter(filter) : {};
      return prisma[table].count({ where });
    },

    async groupBy(table: string, by: string[], filter?: QueryFilter) {
      const where = filter ? translateFilter(filter) : {};
      return prisma[table].groupBy({ by, where, _count: true });
    },
  };
}
