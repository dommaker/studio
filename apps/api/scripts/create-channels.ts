import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

console.error('[DEPRECATED] Channel model 已从 Prisma schema 删除。请使用 FileStore 或 Channel 服务。');
process.exit(0);
