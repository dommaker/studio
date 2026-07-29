export function createPrismaDBAdapter(prisma) {
    // 辅助：把 { contains: "x" } 翻译为 Prisma contains
    const translateFilter = (filter) => {
        const result = {};
        for (const [key, value] of Object.entries(filter)) {
            if (key === 'OR') {
                result.OR = value.map(translateFilter);
            }
            else if (key === 'AND') {
                result.AND = value.map(translateFilter);
            }
            else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
                if ('contains' in value) {
                    result[key] = { contains: value.contains, mode: 'insensitive' };
                }
                else if ('gte' in value || 'lte' in value || 'gt' in value || 'lt' in value) {
                    result[key] = value;
                }
                else {
                    result[key] = value;
                }
            }
            else {
                result[key] = value;
            }
        }
        return result;
    };
    return {
        async create(table, data) {
            return prisma[table].create({ data });
        },
        async findMany(table, filter, options) {
            const where = translateFilter(filter);
            const query = { where };
            if (options?.take)
                query.take = options.take;
            if (options?.skip)
                query.skip = options.skip;
            if (options?.orderBy)
                query.orderBy = options.orderBy;
            if (options?.select) {
                query.select = {};
                for (const k of options.select)
                    query.select[k] = true;
            }
            return prisma[table].findMany(query);
        },
        async findUnique(table, filter) {
            const where = translateFilter(filter);
            return prisma[table].findUnique({ where });
        },
        async update(table, filter, data) {
            const where = translateFilter(filter);
            return prisma[table].update({ where, data });
        },
        async delete(table, filter) {
            const where = translateFilter(filter);
            const result = await prisma[table].deleteMany({ where });
            return result.count;
        },
        async count(table, filter) {
            const where = filter ? translateFilter(filter) : {};
            return prisma[table].count({ where });
        },
        async groupBy(table, by, filter) {
            const where = filter ? translateFilter(filter) : {};
            return prisma[table].groupBy({ by, where, _count: true });
        },
    };
}
//# sourceMappingURL=prisma-db.adapter.js.map