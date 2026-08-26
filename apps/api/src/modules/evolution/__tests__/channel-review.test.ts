/**
 * Evolution channel review 单元测试（E1 约束进化，复用 F5 双向沟通机制）。
 *
 * 覆盖：
 *   - 新提案发布到 #系统 频道（含 id/target/diff 摘要/回复指引；无频道时跳过不炸）
 *   - 人类回复 approve EP-XXXX → 生效（目标文件写入 + 备份）+ 确认消息
 *   - reject EP-XXXX（附理由）→ rejected + ack
 *   - 幂等：已决策提案再次决策 → ack 忽略，状态不变
 *   - 未知 id / 非决策消息
 *   - parseDecisionReply 解析
 */
import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { eventBus, FileStore, formatEvolutionId, type EvolutionProposalData } from '@dommaker/studio-shared';
import { ChannelMessageService } from '../../channels/channel-message.service';
import { EvolutionService } from '../evolution.service';
import { initEvolutionChannelReview, parseDecisionReply, postProposalToChannel } from '../channel-review';
import { resolveEvolutionPaths, type EvolutionPaths } from '../signals';

let tmpDir: string;
let fileStore: FileStore;
let messageService: ChannelMessageService;
let service: EvolutionService;
let paths: EvolutionPaths;
let unsubscribe: (() => void) | null = null;
let prevEnv: string | undefined;

const CONSTRAINTS_FIXTURE = `# 自定义约束配置

custom_constraints:

  no_redis_import:
    id: no_redis_import
    level: iron_law
    rule: "NO REDIS/IREDIS IMPORTS"
    message: "禁止引入 Redis/ioredis 依赖"
    trigger: ["code_implementation"]
    description: "B0-002 已完成迁移"
`;

/**
 * 确定性等待一个 eventBus 事件：predicate 命中即 resolve 并退订（#331）。
 * eventBus.publish 是同步 emit，审核 handler 链是 fire-and-forget——用固定预算轮询
 * 赌链路墙钟耗时在高负载基线下会超时 flake；改为等事件本身，事件不到 = 链路真坏。
 */
function onceEvent<T>(channel: string, pred: (payload: T) => boolean): Promise<T> {
  return new Promise(resolve => {
    const handler = (payload: T) => {
      if (!pred(payload)) return;
      eventBus.unsubscribe(channel, handler);
      resolve(payload);
    };
    eventBus.subscribe(channel, handler);
  });
}

/** 等待频道里一条匹配的系统回帖（createAgentMessage 落库后同步 publish，resolve 时消息已可查）。 */
function waitForAgentReply(pred: (content: string) => boolean): Promise<void> {
  return onceEvent<{ message?: { authorType?: string; content?: unknown } }>(
    'channel.message_sent',
    p => p?.message?.authorType === 'agent' && typeof p.message.content === 'string' && pred(p.message.content),
  ).then(() => undefined);
}

async function seedProposal(patch?: Partial<EvolutionProposalData>): Promise<EvolutionProposalData> {
  const seq = await fileStore.allocateEvolutionSeq();
  const p: EvolutionProposalData = {
    id: formatEvolutionId(seq),
    seq,
    targetType: 'iron-law',
    targetId: 'no_redis_import',
    action: 'amend',
    constraintChange: 'message',
    currentText: '禁止引入 Redis/ioredis 依赖',
    proposedText: '禁止 Redis（含间接依赖），违者驳回',
    rationale: '绕过率 60%，文案过宽',
    evidence: { windowHours: 24, eventCounts: { constraintTraces: 10, anomalies: 1 } },
    status: 'pending',
    source: 'harness-autoEvolve',
    createdAt: new Date().toISOString(),
    ...patch,
  };
  await fileStore.createEvolutionProposal(p);
  return p;
}

async function messagesIn(channelId: string) {
  return fileStore.queryMessages(channelId);
}

const nochanDirs: string[] = [];
afterAll(() => {
  for (const d of nochanDirs) fs.rmSync(d, { recursive: true, force: true });
});

beforeEach(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-channel-test-'));
  fileStore = new FileStore(tmpDir);
  messageService = new ChannelMessageService(fileStore);
  prevEnv = process.env.STUDIO_PROMPT_OVERRIDES_DIR;
  process.env.STUDIO_PROMPT_OVERRIDES_DIR = path.join(tmpDir, 'prompt-overrides');
  fs.mkdirSync(path.join(tmpDir, '.harness'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, '.harness', 'custom-constraints.yml'), CONSTRAINTS_FIXTURE, 'utf-8');
  paths = resolveEvolutionPaths({
    repoRoot: tmpDir,
    eventsDir: path.join(tmpDir, 'events'),
    studioEventsFile: path.join(tmpDir, 'studio-events.jsonl'),
  });
  service = new EvolutionService({ fileStore, paths, messageService });
  const now = new Date().toISOString();
  await fileStore.createChannel({
    id: 'ch-sys', name: '#系统', type: 'system',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: '[]', createdAt: now, updatedAt: now,
  });
});

afterEach(() => {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  if (prevEnv === undefined) delete process.env.STUDIO_PROMPT_OVERRIDES_DIR;
  else process.env.STUDIO_PROMPT_OVERRIDES_DIR = prevEnv;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseDecisionReply', () => {
  it('parses approve/reject with optional reason, case-insensitive', () => {
    expect(parseDecisionReply('approve EP-0001')).toEqual({ decision: 'approve', id: 'EP-0001' });
    expect(parseDecisionReply('APPROVE ep-0001')).toEqual({ decision: 'approve', id: 'EP-0001' });
    expect(parseDecisionReply('reject EP-0002')).toEqual({ decision: 'reject', id: 'EP-0002' });
    expect(parseDecisionReply('reject EP-0002：本期不接受')).toEqual({ decision: 'reject', id: 'EP-0002', reason: '本期不接受' });
    expect(parseDecisionReply('approve EP-0003, 同意这个改法')).toEqual({ decision: 'approve', id: 'EP-0003', reason: '同意这个改法' });
  });

  it('ignores non-decision messages', () => {
    expect(parseDecisionReply('hello world')).toBeNull();
    expect(parseDecisionReply('approval of EP-0001')).toBeNull(); // approve 后必须紧跟 EP 编号
    expect(parseDecisionReply('EP-0001 怎么样')).toBeNull();
  });
});

describe('postProposalToChannel', () => {
  it('posts the proposal to #系统 with diff summary and instructions', async () => {
    const p = await seedProposal();
    const posted = await postProposalToChannel(fileStore, p, messageService);
    expect(posted).toBe(true);

    const msgs = await messagesIn('ch-sys');
    expect(msgs.length).toBe(1);
    expect(msgs[0].authorType).toBe('agent');
    expect(msgs[0].agentName).toBe('Evolution');
    expect(msgs[0].content).toContain('EP-0001');
    expect(msgs[0].content).toContain('iron-law / no_redis_import');
    expect(msgs[0].content).toContain('approve EP-0001');
    expect(msgs[0].content).toContain('reject EP-0001');
    expect(msgs[0].content).toContain('禁止引入 Redis/ioredis 依赖');
    expect(msgs[0].content).toContain('禁止 Redis（含间接依赖），违者驳回');
  });

  it('skips posting when no channel exists (proposal still queryable)', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-nochan-'));
    nochanDirs.push(emptyDir);
    const emptyStore = new FileStore(emptyDir);
    const p = await seedProposal();
    const posted = await postProposalToChannel(emptyStore, p, messageService);
    expect(posted).toBe(false);
  });
});

describe('channel review flow (approve/reject EP-XXXX)', () => {
  it('runScan posts new proposals to #系统', async () => {
    // heuristic (b) fixture：6 失败（3 注入）+ 2 成功
    const rows = [
      ...Array.from({ length: 3 }, (_, i) => ({ success: false, consumedKnowledge: [`k${i}`] })),
      ...Array.from({ length: 3 }, () => ({ success: false, consumedKnowledge: [] })),
      ...Array.from({ length: 2 }, () => ({ success: true, consumedKnowledge: [] })),
    ].map(o => ({
      type: `knowledge:outcome:${o.success ? 'success' : 'failure'}`,
      payload: JSON.stringify(o),
      createdAt: new Date().toISOString(),
    }));
    fs.writeFileSync(paths.studioEventsFile, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');

    const result = await service.runScan();
    expect(result.created.length).toBe(1);
    expect(result.posted).toBe(1);
    const msgs = await messagesIn('ch-sys');
    expect(msgs.length).toBe(1);
    expect(msgs[0].content).toContain(result.created[0].id);
  });

  it('human approve applies the proposal (target written + backup) and posts confirmation', { timeout: 15000 }, async () => {
    const p = await seedProposal();
    unsubscribe = initEvolutionChannelReview(service, messageService);

    // 确定性同步点（#331）：decide 落 applied 后同步 publish evolution.applied（apply 已完成）；
    // 回执帖落库后同步 publish channel.message_sent。先挂等待再触发，不错过事件。
    const applied = onceEvent<{ proposal?: { id?: string } }>('evolution.applied', pl => pl?.proposal?.id === p.id);
    const confirmed = waitForAgentReply(c => c.includes(p.id) && c.includes('已批准并生效'));

    await messageService.createHumanMessage('ch-sys', `approve ${p.id}`);
    await applied;

    // 目标文件已改 + 备份已建（applied 事件发布于 apply 与状态写库之后，无需轮询）
    const raw = fs.readFileSync(paths.constraintsFile, 'utf-8');
    expect(raw).toContain('禁止 Redis（含间接依赖），违者驳回');
    const backups = fs.readdirSync(path.dirname(paths.constraintsFile)).filter(f => f.includes('.bak-'));
    expect(backups.length).toBe(1);

    const decided = await service.get(p.id);
    expect(decided!.status).toBe('applied');
    expect(decided!.decidedBy).toBe('channel');
    expect(decided!.decidedAt).toBeTruthy();
    expect(decided!.appliedAt).toBeTruthy();

    // 确认回执（resolve 时消息已落库，直接断言内容）
    await confirmed;
    const msgs = await messagesIn('ch-sys');
    const confirmation = msgs.find(m => m.authorType === 'agent' && m.content.includes('已批准并生效'));
    expect(confirmation!.content).toContain(p.id);
  });

  it('human reject with reason marks rejected and posts ack', { timeout: 15000 }, async () => {
    const p = await seedProposal();
    unsubscribe = initEvolutionChannelReview(service, messageService);

    // 回执在 decide 落 rejected 之后才发（channel-review.ts），await 回执即保证状态已写库
    const acked = waitForAgentReply(c => c.includes(p.id) && c.includes('已拒绝'));
    await messageService.createHumanMessage('ch-sys', `reject ${p.id}：本期不接受`);
    await acked;

    const decided = await service.get(p.id);
    expect(decided!.status).toBe('rejected');
    expect(decided!.rejectReason).toBe('本期不接受');
    expect(decided!.appliedAt).toBeFalsy();
    // 目标文件未被改动
    expect(fs.readFileSync(paths.constraintsFile, 'utf-8')).toBe(CONSTRAINTS_FIXTURE);
  });

  it('double-decide is rejected with an ack, status unchanged', { timeout: 15000 }, async () => {
    const p = await seedProposal();
    unsubscribe = initEvolutionChannelReview(service, messageService);

    const rejected = waitForAgentReply(c => c.includes(p.id) && c.includes('已拒绝'));
    await messageService.createHumanMessage('ch-sys', `reject ${p.id}`);
    await rejected;

    const acked = waitForAgentReply(c => c.includes('已是 rejected 状态'));
    await messageService.createHumanMessage('ch-sys', `approve ${p.id}`);
    await acked;

    expect((await service.get(p.id))!.status).toBe('rejected');
    // 未生效
    expect(fs.readFileSync(paths.constraintsFile, 'utf-8')).toBe(CONSTRAINTS_FIXTURE);
  });

  it('replies "not found" for unknown proposal ids; ignores non-decision chatter', { timeout: 15000 }, async () => {
    unsubscribe = initEvolutionChannelReview(service, messageService);

    const notFound = waitForAgentReply(c => c.includes('未找到提案 EP-9999'));
    await messageService.createHumanMessage('ch-sys', 'approve EP-9999');
    await notFound;

    const before = (await messagesIn('ch-sys')).length;
    await messageService.createHumanMessage('ch-sys', '今天天气不错');
    await new Promise(r => setTimeout(r, 200));
    expect((await messagesIn('ch-sys')).length).toBe(before + 1); // 只有人类消息本身，无系统回帖
  });
});
