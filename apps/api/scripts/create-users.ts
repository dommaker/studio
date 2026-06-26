import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

interface CreateUserOptions {
  count?: number;
  prefix?: string;
  password?: string;
  role?: 'USER' | 'ADMIN' | 'MODERATOR';
}

async function createUsers(options: CreateUserOptions = {}) {
  const {
    count = 6,
    prefix = 'testuser',
    password = process.env.TEST_PASSWORD || 'test123456',
    role = 'USER',
  } = options;

  console.log(`Creating ${count} test users...`);

  const passwordHash = await bcrypt.hash(password, 10);

  const users = [];

  for (let i = 1; i <= count; i++) {
    const email = `${prefix}${i}@example.com`;
    const name = `Test User ${i}`;

    try {
      const user = await prisma.user.upsert({
        where: { email },
        update: {
          name,
          passwordHash,
          role,
        },
        create: {
          email,
          name,
          passwordHash,
          role,
        },
      });

      users.push(user);
      console.log(`✓ Created user: ${email} (ID: ${user.id})`);
    } catch (error) {
      console.error(`✗ Failed to create user ${email}:`, error);
    }
  }

  console.log(`\nCreated ${users.length} users successfully.`);
  return users;
}

// Parse command-line arguments
const args = process.argv.slice(2);
const options: CreateUserOptions = {};

for (let i = 0; i < args.length; i += 2) {
  const key = args[i]?.replace('--', '');
  const value = args[i + 1];

  switch (key) {
    case 'count':
      options.count = parseInt(value, 10);
      break;
    case 'prefix':
      options.prefix = value;
      break;
    case 'password':
      options.password = value;
      break;
    case 'role':
      options.role = value as 'USER' | 'ADMIN' | 'MODERATOR';
      break;
  }
}

createUsers(options)
  .catch(console.error)
  .finally(() => prisma.$disconnect());
