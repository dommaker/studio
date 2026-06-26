import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface CreateChannelsOptions {
  count?: number;
  prefix?: string;
  type?: string;
  mode?: string;
}

const DEFAULT_CHANNELS = [
  { name: 'general', type: 'rnd', mode: 'broadcast' },
  { name: 'development', type: 'rnd', mode: 'broadcast' },
  { name: 'design', type: 'rnd', mode: 'broadcast' },
  { name: 'decisions', type: 'decision', mode: 'broadcast' },
  { name: 'system-alerts', type: 'system', mode: 'broadcast' },
  { name: 'ai-chat', type: 'rnd', mode: 'conversation', agentName: 'analyst' },
];

async function createChannels(options: CreateChannelsOptions = {}) {
  const {
    count = 6,
    prefix = 'test-channel',
    type = 'rnd',
    mode = 'broadcast',
  } = options;

  console.log(`Creating ${count} test channels...`);

  const channels = [];

  for (let i = 1; i <= count; i++) {
    const channelDef = DEFAULT_CHANNELS[i - 1];
    const name = channelDef?.name || `${prefix}-${i}`;
    const channelType = channelDef?.type || type;
    const channelMode = channelDef?.mode || mode;
    const agentName = channelDef?.agentName || null;

    try {
      const channel = await prisma.channel.upsert({
        where: { name },
        update: {
          type: channelType,
          mode: channelMode,
          agentName,
        },
        create: {
          name,
          type: channelType,
          mode: channelMode,
          agentName,
        },
      });

      channels.push(channel);
      console.log(`✓ Created channel: #${name} (ID: ${channel.id}, type: ${channelType}, mode: ${channelMode})`);
    } catch (error) {
      console.error(`✗ Failed to create channel ${name}:`, error);
    }
  }

  console.log(`\nCreated ${channels.length} channels successfully.`);
  return channels;
}

// Parse command-line arguments
const args = process.argv.slice(2);
const options: CreateChannelsOptions = {};

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
    case 'type':
      options.type = value;
      break;
    case 'mode':
      options.mode = value;
      break;
  }
}

createChannels(options)
  .catch(console.error)
  .finally(() => prisma.$disconnect());
