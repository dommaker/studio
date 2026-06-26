import { PrismaClient } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

interface SeedOptions {
  users?: number;
  channels?: number;
  messages?: number;
  password?: string;
  clean?: boolean;
}

const DEFAULT_CHANNELS = [
  { name: 'general', type: 'rnd', mode: 'broadcast' },
  { name: 'development', type: 'rnd', mode: 'broadcast' },
  { name: 'design', type: 'rnd', mode: 'broadcast' },
  { name: 'decisions', type: 'decision', mode: 'broadcast' },
  { name: 'system-alerts', type: 'system', mode: 'broadcast' },
  { name: 'ai-chat', type: 'rnd', mode: 'conversation', agentName: 'analyst' },
];

const SAMPLE_MESSAGES = [
  'Hello, everyone! This is a test message.',
  'Testing the channel functionality.',
  'Another test message for verification.',
  'This is a sample message from the test script.',
  'Checking message persistence.',
  'Verifying real-time updates.',
  'Test message with **Markdown** support.',
  'Message with `code` formatting.',
  'Testing message ordering.',
  'Final test message.',
];

async function cleanDatabase() {
  console.log('Cleaning existing test data...');

  // Delete in correct order to respect foreign key constraints
  await prisma.channelMessage.deleteMany({
    where: {
      meta: {
        contains: '"testMessage":true',
      },
    },
  });

  await prisma.channel.deleteMany({
    where: {
      name: {
        startsWith: 'test-channel',
      },
    },
  });

  await prisma.user.deleteMany({
    where: {
      email: {
        startsWith: 'testuser',
      },
    },
  });

  console.log('✓ Cleaned existing test data');
}

async function createUsers(count: number, password: string) {
  console.log(`\nCreating ${count} test users...`);

  const passwordHash = await bcrypt.hash(password, 10);
  const users = [];

  for (let i = 1; i <= count; i++) {
    const email = `testuser${i}@example.com`;
    const name = `Test User ${i}`;
    const role = i <= 2 ? 'ADMIN' : 'USER'; // First 2 users are admins

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
      console.log(`✓ Created user: ${email} (ID: ${user.id}, role: ${role})`);
    } catch (error) {
      console.error(`✗ Failed to create user ${email}:`, error);
    }
  }

  console.log(`Created ${users.length} users successfully.`);
  return users;
}

async function createChannels(count: number) {
  console.log(`\nCreating ${count} test channels...`);

  const channels = [];

  for (let i = 1; i <= count; i++) {
    const channelDef = DEFAULT_CHANNELS[i - 1];
    const name = channelDef?.name || `test-channel-${i}`;
    const type = channelDef?.type || 'rnd';
    const mode = channelDef?.mode || 'broadcast';
    const agentName = channelDef?.agentName || null;

    try {
      const channel = await prisma.channel.upsert({
        where: { name },
        update: {
          type,
          mode,
          agentName,
        },
        create: {
          name,
          type,
          mode,
          agentName,
        },
      });

      channels.push(channel);
      console.log(`✓ Created channel: #${name} (ID: ${channel.id}, type: ${type}, mode: ${mode})`);
    } catch (error) {
      console.error(`✗ Failed to create channel ${name}:`, error);
    }
  }

  console.log(`Created ${channels.length} channels successfully.`);
  return channels;
}

async function sendMessages(channels: Array<{ id: string; name: string }>, count: number) {
  console.log(`\nSending ${count} messages to each channel...`);

  let totalMessages = 0;

  for (const channel of channels) {
    const messages = [];

    for (let i = 1; i <= count; i++) {
      const content = SAMPLE_MESSAGES[(i - 1) % SAMPLE_MESSAGES.length] || `Test message ${i}`;
      const authorType = i % 3 === 0 ? 'agent' : 'human'; // Every 3rd message from agent
      const agentName = authorType === 'agent' ? 'test-agent' : null;

      try {
        const message = await prisma.channelMessage.create({
          data: {
            channelId: channel.id,
            authorType,
            agentName,
            content,
            meta: JSON.stringify({
              testMessage: true,
              messageIndex: i,
              channelName: channel.name,
            }),
          },
        });

        messages.push(message);
      } catch (error) {
        console.error(`✗ Failed to send message ${i} to ${channel.name}:`, error);
      }
    }

    totalMessages += messages.length;
    console.log(`✓ Sent ${messages.length} messages to #${channel.name}`);
  }

  console.log(`\nSent ${totalMessages} total messages successfully.`);
  return totalMessages;
}

async function printSummary(users: Array<{ email: string }>, channels: Array<{ name: string }>, messageCount: number) {
  console.log('\n' + '='.repeat(50));
  console.log('TEST DATA SUMMARY');
  console.log('='.repeat(50));

  console.log('\nUsers:');
  users.forEach((user, index) => {
    console.log(`  ${index + 1}. ${user.email}`);
  });

  console.log('\nChannels:');
  channels.forEach((channel, index) => {
    console.log(`  ${index + 1}. #${channel.name}`);
  });

  console.log(`\nMessages: ${messageCount} total`);

  console.log('\nLogin Credentials:');
  console.log('  Email: testuser1@example.com');
  console.log('  Password: test123456');
  console.log('  (All users have the same password)');

  console.log('\n' + '='.repeat(50));
}

// Parse command-line arguments
const args = process.argv.slice(2);
const options: SeedOptions = {};

for (let i = 0; i < args.length; i += 2) {
  const key = args[i]?.replace('--', '');
  const value = args[i + 1];

  switch (key) {
    case 'users':
      options.users = parseInt(value, 10);
      break;
    case 'channels':
      options.channels = parseInt(value, 10);
      break;
    case 'messages':
      options.messages = parseInt(value, 10);
      break;
    case 'password':
      options.password = value;
      break;
    case 'clean':
      options.clean = value === 'true';
      break;
  }
}

async function main() {
  const {
    users: userCount = 6,
    channels: channelCount = 6,
    messages: messageCount = 10,
    password = process.env.TEST_PASSWORD || 'test123456',
    clean = true,
  } = options;

  console.log('Starting test data seed...');
  console.log(`Configuration: ${userCount} users, ${channelCount} channels, ${messageCount} messages per channel`);

  // Clean existing test data if requested
  if (clean) {
    await cleanDatabase();
  }

  // Create users
  const users = await createUsers(userCount, password);

  // Create channels
  const channels = await createChannels(channelCount);

  // Send messages
  const totalMessages = await sendMessages(channels, messageCount);

  // Print summary
  await printSummary(users, channels, totalMessages);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
