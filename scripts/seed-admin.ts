#!/usr/bin/env tsx
/**
 * 初始化管理员账号
 * 运行：npx tsx scripts/seed-admin.ts
 */

import { PrismaClient } from '@prisma/client';
import { hashPassword } from '../apps/api/src/modules/auth/service.js';

const prisma = new PrismaClient();

const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@agent-studio.local';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

if (!ADMIN_PASSWORD) {
  console.error('❌ ADMIN_PASSWORD 环境变量未设置。用法: ADMIN_PASSWORD=<密码> npx tsx scripts/seed-admin.ts');
  process.exit(1);
}

const DEFAULT_ADMIN = {
  email: ADMIN_EMAIL,
  password: ADMIN_PASSWORD,
  name: 'Admin',
  role: 'Admin',
};

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
  console.log('   ID:', admin.id);
  console.log('\n⚠️  生产环境请立即修改密码！');
}

main()
  .catch((e) => {
    console.error('❌ 创建失败:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
