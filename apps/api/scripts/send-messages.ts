import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface SendMessageOptions {
  channelId?: string;
  channelName?: string;
  count?: number;
  authorType?: string;
  agentName?: string;
}

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

async function sendMessages(options: SendMessageOptions = {}) {
  const {
    channelId,
    channelName = 'general',
    count = 10,
    authorType = 'human',
    agentName,
  } = options;

  console.log(`Sending ${count} test messages to channel: ${channelName}...`);

  // Find the channel
  let channel;
  if (channelId) {
    channel = await prisma.channel.findUnique({ where: { id: channelId } });
  } else {
    channel = await prisma.channel.findUnique({ where: { name: channelName } });
  }

  if (!channel) {
    console.error(`Channel not found: ${channelId || channelName}`);
    return [];
  }

  const messages = [];

  for (let i = 1; i <= count; i++) {
    const content = SAMPLE_MESSAGES[(i - 1) % SAMPLE_MESSAGES.length] || `Test message ${i}`;

    try {
      const message = await prisma.channelMessage.create({
        data: {
          channelId: channel.id,
          authorType,
          agentName: authorType === 'agent' ? agentName || 'test-agent' : null,
          content,
          meta: JSON.stringify({
            testMessage: true,
            messageIndex: i,
          }),
        },
      });

      messages.push(message);
      console.log(`✓ Sent message ${i}: ${content.substring(0, 50)}...`);
    } catch (error) {
      console.error(`✗ Failed to send message ${i}:`, error);
    }
  }

  console.log(`\nSent ${messages.length} messages successfully.`);
  return messages;
}

// Parse command-line arguments
const args = process.argv.slice(2);
const options: SendMessageOptions = {};

for (let i = 0; i < args.length; i += 2) {
  const key = args[i]?.replace('--', '');
  const value = args[i + 1];

  switch (key) {
    case 'channel-id':
      options.channelId = value;
      break;
    case 'channel':
      options.channelName = value;
      break;
    case 'count':
      options.count = parseInt(value, 10);
      break;
    case 'author-type':
      options.authorType = value;
      break;
    case 'agent-name':
      options.agentName = value;
      break;
  }
}

sendMessages(options)
  .catch(console.error)
  .finally(() => prisma.$disconnect());
