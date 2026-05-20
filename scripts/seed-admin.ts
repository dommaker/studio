#!/usr/bin/env tsx
/**
 * 初始化管理员账号
 * 运行：npx tsx scripts/seed-admin.ts
 */

import { PrismaClient } from '@prisma/client';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

const DEFAULT_ADMIN = {
  email: 'admin@agent-studio.local',
  password: 'admin123',
  name: 'Admin',
  role: 'Admin',
};

/**
 * 使用 SHA-256 加密密码（简化版）
 * 生产环境应使用 bcrypt
 */
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto
    .pbkdf2Sync(password, salt, 1000, 64, 'sha256')
    .toString('hex');
  return `${salt}:${hash}`;
}

async function main() {
  console.log('🔍 检查管理员账号...');
  
  const existingAdmin = await prisma.user.findUnique({
    where: { email: DEFAULT_ADMIN.email },
  });
  
  if (existingAdmin) {
    console.log('✅ 管理员账号已存在:', DEFAULT_ADMIN.email);
    console.log('   如需重置密码，请手动删除后重新运行此脚本');
    return;
  }
  
  console.log('🔐 加密密码...');
  const passwordHash = hashPassword(DEFAULT_ADMIN.password);
  
  console.log('👤 创建管理员账号...');
  const admin = await prisma.user.create({
    data: {
      email: DEFAULT_ADMIN.email,
      passwordHash,
      name: DEFAULT_ADMIN.name,
      role: DEFAULT_ADMIN.role,
    },
  });
  
  console.log('\n✅ 管理员账号创建成功！');
  console.log('   邮箱:', DEFAULT_ADMIN.email);
  console.log('   密码:', DEFAULT_ADMIN.password);
  console.log('   ID:', admin.id);
  console.log('\n⚠️  生产环境请立即修改密码！');
}

main()
  .catch((e) => {
    console.error('❌ 创建失败:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
