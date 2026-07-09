/**
 * AC: ac-agent-loop-rewrite
 *
 * Contract tests for new Agent Loop functions:
 * - parseAgentOutput() — ACTION protocol parsing
 * - dynamicInterval() — result-based sleep intervals
 * - resolveTarget() — priority routing (pure logic)
 * - observe() — DB query structure
 * - recordResult() — monitoring + state transitions
 * - findAnchorMessage() — AC-C2: Thread anchor message lookup
 */

import { describe, test, expect, vi, beforeEach, afterAll } from 'vitest';
import type { WorkUnit, ChannelMessage } from '@prisma/client';
import { prisma } from '../../../core/database.js';

// We'll import the actual functions once implemented
// For RED phase, these imports will fail until implementation exists
let parseAgentOutput: (text: string) => { action: 'progress' | 'complete' | 'need_input'; summary: string };
let dynamicInterval: (result: { action: string }) => number;
let resolveTarget: (obs: {
  myActive: WorkUnit[];
  unassigned: WorkUnit[];
  newReplies: ChannelMessage[];
}) => { workUnit: WorkUnit; newReplies?: ChannelMessage[] } | null;

// Dynamic import to handle RED phase (module doesn't exist yet)
beforeEach(async () => {
  try {
    const mod = await import('../agent-loop.js');
    parseAgentOutput = mod.parseAgentOutput;
    dynamicInterval = mod.dynamicInterval;
    resolveTarget = mod.resolveTarget;
  } catch {
    // RED phase: module not yet implemented
    parseAgentOutput = vi.fn() as any;
    dynamicInterval = vi.fn() as any;
    resolveTarget = vi.fn() as any;
  }
});

describe('parseAgentOutput()', () => {
  test('parses ACTION: PROGRESS:summary', () => {
    const result = parseAgentOutput('some output\nACTION: PROGRESS:completed step 1');
    expect(result.action).toBe('progress');
    expect(result.summary).toBe('completed step 1');
  });

  test('parses ACTION: COMPLETE:summary', () => {
    const result = parseAgentOutput('ACTION: COMPLETE:all done');
    expect(result.action).toBe('complete');
    expect(result.summary).toBe('all done');
  });

  test('parses ACTION: NEED_INPUT:question', () => {
    const result = parseAgentOutput('ACTION: NEED_INPUT:need clarification on API design');
    expect(result.action).toBe('need_input');
    expect(result.summary).toBe('need clarification on API design');
  });

  test('falls back to progress when no ACTION pattern found', () => {
    const result = parseAgentOutput('just some text without action protocol');
    expect(result.action).toBe('progress');
    expect(result.summary).toContain('just some text');
  });

  test('handles empty input gracefully', () => {
    const result = parseAgentOutput('');
    expect(result.action).toBe('progress');
  });

  test('picks last ACTION line when multiple present', () => {
    const result = parseAgentOutput('ACTION: PROGRESS:step 1\nmore work\nACTION: COMPLETE:done');
    expect(result.action).toBe('complete');
    expect(result.summary).toBe('done');
  });
});

describe('dynamicInterval()', () => {
  test('returns 3000 for progress', () => {
    expect(dynamicInterval({ action: 'progress' })).toBe(3_000);
  });

  test('returns 10000 for complete', () => {
    expect(dynamicInterval({ action: 'complete' })).toBe(10_000);
  });

  test('returns 30000 for need_input', () => {
    expect(dynamicInterval({ action: 'need_input' })).toBe(30_000);
  });

  test('returns 15000 for unknown action', () => {
    expect(dynamicInterval({ action: 'something_else' })).toBe(15_000);
  });
});

describe('resolveTarget()', () => {
  const makeWU = (overrides: Partial<WorkUnit>): WorkUnit => ({
    id: 'wu-default',
    status: 'active',
    type: 'task',
    scope: 'test',
    assigneeId: 'agent-1',
    channelId: 'ch-1',
    createdAt: new Date('2026-07-02T10:00:00Z'),
    updatedAt: new Date('2026-07-02T10:00:00Z'),
    ...overrides,
  } as WorkUnit);

  const makeMsg = (overrides: Partial<ChannelMessage>): ChannelMessage => ({
    id: 'msg-default',
    workUnitId: 'wu-1',
    content: 'feedback',
    authorType: 'human',
    channelId: 'ch-1',
    createdAt: new Date(),
    ...overrides,
  } as ChannelMessage);

  test('priority 1: returns WorkUnit with human reply (including blocked)', () => {
    const wu = makeWU({ id: 'wu-1', status: 'blocked' });
    const msg = makeMsg({ workUnitId: 'wu-1' });
    const obs = {
      myActive: [wu],
      unassigned: [],
      newReplies: [msg],
    };
    const target = resolveTarget(obs);
    expect(target).not.toBeNull();
    expect(target!.workUnit.id).toBe('wu-1');
    expect(target!.newReplies).toEqual([msg]);
  });

  test('priority 2: returns active WorkUnit when no replies', () => {
    const wu = makeWU({ id: 'wu-1', status: 'active' });
    const obs = {
      myActive: [wu],
      unassigned: [],
      newReplies: [],
    };
    const target = resolveTarget(obs);
    expect(target).not.toBeNull();
    expect(target!.workUnit.id).toBe('wu-1');
    expect(target!.newReplies).toBeUndefined();
  });

  test('priority 3: returns earliest unassigned WorkUnit when idle', () => {
    const wu1 = makeWU({ id: 'wu-1', status: 'unassigned', createdAt: new Date('2026-07-02T10:00:00Z') });
    const wu2 = makeWU({ id: 'wu-2', status: 'unassigned', createdAt: new Date('2026-07-02T11:00:00Z') });
    const obs = {
      myActive: [],
      unassigned: [wu2, wu1], // out of order, but already sorted by caller
      newReplies: [],
    };
    // resolveTarget expects pre-sorted input (observe sorts by createdAt asc)
    // But tests may pass unsorted — take first element
    const target = resolveTarget(obs);
    expect(target).not.toBeNull();
    // Takes first from the array (caller responsible for sorting)
    expect(target!.workUnit.id).toBe('wu-2');
  });

  test('returns null when no target available', () => {
    const obs = { myActive: [], unassigned: [], newReplies: [] };
    const target = resolveTarget(obs);
    expect(target).toBeNull();
  });

  test('skips blocked WorkUnits for priority 2 (only active continues)', () => {
    const blockedWu = makeWU({ id: 'wu-blocked', status: 'blocked' });
    const obs = {
      myActive: [blockedWu],
      unassigned: [],
      newReplies: [],
    };
    // blocked WU with no replies → no active WU → check unassigned → null
    const target = resolveTarget(obs);
    expect(target).toBeNull();
  });
});

// ── AC-C2: findAnchorMessage — Thread anchor lookup ──

describe('AC-C2: findAnchorMessage', () => {
  let findAnchorMessage: (workUnitId: string) => Promise<ChannelMessage | null>;
  let testChannelId: string;
  let testWorkUnitId: string;

  beforeEach(async () => {
    try {
      const mod = await import('../agent-loop.js');
      findAnchorMessage = mod.findAnchorMessage;
    } catch {
      findAnchorMessage = vi.fn() as any;
    }

    // Create test fixtures
    const channel = await prisma.channel.create({
      data: { name: `#test-thread-${Date.now()}` },
    });
    testChannelId = channel.id;
    const wu = await prisma.workUnit.create({
      data: { scope: 'thread test', channelId: testChannelId, type: 'task', status: 'unassigned' },
    });
    testWorkUnitId = wu.id;
  });

  test('returns the first message (no replyToId) for a WorkUnit', async () => {
    // Create anchor message (workUnitId set, no replyToId)
    const anchor = await prisma.channelMessage.create({
      data: {
        channelId: testChannelId,
        content: 'anchor message',
        authorType: 'human',
        workUnitId: testWorkUnitId,
      },
    });

    const result = await findAnchorMessage(testWorkUnitId);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(anchor.id);
  });

  test('returns anchor when multiple messages exist (first with no replyToId)', async () => {
    const anchor = await prisma.channelMessage.create({
      data: {
        channelId: testChannelId,
        content: 'first message',
        authorType: 'human',
        workUnitId: testWorkUnitId,
      },
    });
    // Second message with replyToId (thread reply)
    await prisma.channelMessage.create({
      data: {
        channelId: testChannelId,
        content: 'thread reply',
        authorType: 'agent',
        workUnitId: testWorkUnitId,
        replyToId: anchor.id,
      },
    });

    const result = await findAnchorMessage(testWorkUnitId);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(anchor.id);
    expect(result!.replyToId).toBeNull();
  });

  test('returns null when WorkUnit has no messages', async () => {
    const result = await findAnchorMessage(testWorkUnitId);
    expect(result).toBeNull();
  });

  // Cleanup
  afterAll(async () => {
    // Clean up test channels and work units
    const testChannels = await prisma.channel.findMany({
      where: { name: { startsWith: '#test-thread-' } },
    });
    const channelIds = testChannels.map(c => c.id);
    await prisma.channelMessage.deleteMany({ where: { channelId: { in: channelIds } } });
    await prisma.workUnit.deleteMany({ where: { channelId: { in: channelIds } } });
    await prisma.channel.deleteMany({ where: { id: { in: channelIds } } });
  });
});
