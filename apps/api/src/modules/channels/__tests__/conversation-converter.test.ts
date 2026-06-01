// ConversationConverter test (AS-020 P10-03)
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { prisma } from '@dommaker/studio-prisma';

// Mock analystTriggerService to prevent actual pipeline execution
vi.mock('../analyst-trigger.service.js', () => ({
  analystTriggerService: {
    trigger: vi.fn().mockResolvedValue(undefined),
  },
}));

import { convertConversationToPipeline } from '../conversation-converter.js';
import { analystTriggerService } from '../analyst-trigger.service.js';

let channelId: string;

describe('convertConversationToPipeline', () => {
  beforeAll(async () => {
    const channel = await prisma.channel.create({
      data: { name: `#test-convert-${Date.now()}`, type: 'rnd' },
    });
    channelId = channel.id;
  });

  afterAll(async () => {
    await prisma.channelMessage.deleteMany({ where: { channelId } });
    await prisma.channel.deleteMany({ where: { id: channelId } });
  });

  beforeEach(async () => {
    await prisma.channelMessage.deleteMany({ where: { channelId } });
    vi.mocked(analystTriggerService.trigger).mockClear();
  });

  // ── Conversation packaging ──

  it('packages human and agent messages into conversation text', async () => {
    await prisma.channelMessage.create({
      data: {
        channelId,
        authorType: 'human',
        content: 'I need a login feature',
        meta: '{}',
      },
    });
    await prisma.channelMessage.create({
      data: {
        channelId,
        authorType: 'agent',
        agentName: 'Analyst',
        content: 'What auth provider do you want?',
        meta: '{}',
      },
    });
    await prisma.channelMessage.create({
      data: {
        channelId,
        authorType: 'human',
        content: 'OAuth2 with Google',
        meta: '{}',
      },
    });

    const result = await convertConversationToPipeline(channelId);

    expect(result.messageCount).toBe(3);
    expect(result.hasRequirementsDoc).toBe(false);
    expect(result.contextLength).toBeGreaterThan(0);

    // Verify trigger was called with formatted conversation
    expect(analystTriggerService.trigger).toHaveBeenCalledTimes(1);
    const [calledChannelId, triggerMsgId, context] =
      vi.mocked(analystTriggerService.trigger).mock.calls[0];

    expect(calledChannelId).toBe(channelId);
    expect(triggerMsgId).toBeNull();
    expect(context).toContain('用户: I need a login feature');
    expect(context).toContain('@Analyst: What auth provider do you want?');
    expect(context).toContain('用户: OAuth2 with Google');
    expect(context).toContain('---');
  });

  it('uses agentName from message field', async () => {
    await prisma.channelMessage.create({
      data: {
        channelId,
        authorType: 'human',
        content: 'Hello',
        meta: '{}',
      },
    });
    await prisma.channelMessage.create({
      data: {
        channelId,
        authorType: 'agent',
        agentName: 'Executor',
        content: 'Ready to execute',
        meta: '{}',
      },
    });

    await convertConversationToPipeline(channelId);

    const context = vi.mocked(analystTriggerService.trigger).mock.calls[0][2];
    expect(context).toContain('@Executor: Ready to execute');
  });

  it('falls back to meta.agentName when agentName field is null', async () => {
    await prisma.channelMessage.create({
      data: {
        channelId,
        authorType: 'agent',
        agentName: null,
        content: 'Fallback test',
        meta: JSON.stringify({ agentName: 'KK' }),
      },
    });

    await convertConversationToPipeline(channelId);

    const context = vi.mocked(analystTriggerService.trigger).mock.calls[0][2];
    expect(context).toContain('@KK: Fallback test');
  });

  it('defaults to @Agent when no agentName available', async () => {
    await prisma.channelMessage.create({
      data: {
        channelId,
        authorType: 'agent',
        agentName: null,
        content: 'Anonymous agent',
        meta: '{}',
      },
    });

    await convertConversationToPipeline(channelId);

    const context = vi.mocked(analystTriggerService.trigger).mock.calls[0][2];
    expect(context).toContain('@Agent: Anonymous agent');
  });

  // ── RequirementsDoc injection ──

  it('injects RequirementsDoc when present in messages', async () => {
    await prisma.channelMessage.create({
      data: {
        channelId,
        authorType: 'human',
        content: 'Build a dashboard',
        meta: '{}',
      },
    });
    await prisma.channelMessage.create({
      data: {
        channelId,
        authorType: 'agent',
        agentName: 'Analyst',
        content: '# Dashboard Requirements\n\n## AC Groups\n...',
        meta: JSON.stringify({ cardType: 'requirements_doc', requirementsDocId: 'doc-123' }),
      },
    });

    const result = await convertConversationToPipeline(channelId);

    expect(result.hasRequirementsDoc).toBe(true);

    const context = vi.mocked(analystTriggerService.trigger).mock.calls[0][2];
    expect(context).toContain('[已生成 RequirementsDoc]');
    expect(context).toContain('# Dashboard Requirements');
  });

  // ── Empty conversation ──

  it('throws on empty conversation', async () => {
    await expect(convertConversationToPipeline(channelId)).rejects.toThrow(
      'No conversation messages found in channel',
    );
  });

  it('ignores system messages (non-human/non-agent)', async () => {
    // Only system message — should still throw
    await prisma.channelMessage.create({
      data: {
        channelId,
        authorType: 'system',
        content: 'System notification',
        meta: '{}',
      },
    });

    await expect(convertConversationToPipeline(channelId)).rejects.toThrow(
      'No conversation messages found in channel',
    );
  });

  // ── Mixed message types ──

  it('filters out system messages from conversation', async () => {
    await prisma.channelMessage.create({
      data: {
        channelId,
        authorType: 'human',
        content: 'Question',
        meta: '{}',
      },
    });
    await prisma.channelMessage.create({
      data: {
        channelId,
        authorType: 'system',
        content: 'System event',
        meta: '{}',
      },
    });
    await prisma.channelMessage.create({
      data: {
        channelId,
        authorType: 'agent',
        agentName: 'Analyst',
        content: 'Answer',
        meta: '{}',
      },
    });

    const result = await convertConversationToPipeline(channelId);

    expect(result.messageCount).toBe(2); // human + agent, not system

    const context = vi.mocked(analystTriggerService.trigger).mock.calls[0][2];
    expect(context).not.toContain('System event');
    expect(context).toContain('Question');
    expect(context).toContain('Answer');
  });
});
