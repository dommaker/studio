/**
 * MCP Tools — Channel 消息（P2，#566）
 *
 * 只读：getChannelMessages 包 FileStore.readMessagesTail（热层尾部倒扫，新→旧）。
 * 冷层穿透分页不外放（方案 §P2：先热层）。
 */

import type { RegisteredTool } from './tool-registry.js';
import { fileStore } from './tool-store.js';

const MAX_LIMIT = 100;

const getChannelMessages: RegisteredTool = {
  name: 'getChannelMessages',
  exposure: 'external',
  description: '读取频道最新消息（热层尾部，返回新→旧顺序；冷层归档不含）',
  inputSchema: {
    type: 'object',
    properties: {
      channelId: { type: 'string', description: 'Channel ID' },
      limit: { type: 'number', description: `返回条数（默认 20，上限 ${MAX_LIMIT}）` },
    },
    required: ['channelId'],
  },
  handler: async (input) => {
    const limit = Math.min(Math.max(Number(input.limit) || 20, 1), MAX_LIMIT);
    const { messages } = await fileStore.readMessagesTail(input.channelId, { limit });
    return { messages, total: messages.length };
  },
};

export const channelTools: RegisteredTool[] = [
  getChannelMessages,
];
