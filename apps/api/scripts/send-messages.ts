import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

console.error('[DEPRECATED] ChannelMessage/Channel model 已从 Prisma schema 删除。请使用 FileStore。');
process.exit(0);
