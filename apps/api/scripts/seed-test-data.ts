import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

console.error('[DEPRECATED] Channel/ChannelMessage model 已从 Prisma schema 删除。请使用 FileStore。');
process.exit(0);
