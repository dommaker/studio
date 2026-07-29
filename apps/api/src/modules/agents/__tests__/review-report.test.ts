// P0 修复（reviewReport 回传断链）：
// - parseReviewReport：REVIEW_RESULT 行 JSON 优先，尾部 verdict 关键词兜底，失败 → null
// - agentStep：review 子 WU complete 时把 reviewer 输出解析写入 metadataUpdates.reviewReport
// - recordResult：review 子 WU complete → in_review → done（收口，触发 dispatcher 路径 B）
// - ReviewDispatcher：scope 含 REVIEW_RESULT 约定；无 report → 父保持 in_review + 频道转人工
// - ReviewDispatcher：scope 含 REVIEW_RESULT 约定；无 report → 父保持 in_review + 频道转人工
// - F4: members 损坏/非数组 → 不抛错，按成员未知保守创建自评兜底子 WU（评审链不断）
// 真实 FileStore（tmpdir）+ 真实 WorkUnitService；CLI 执行与 knowledge-service mock
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore, eventBus, stringifyChannels, type AgentProfileData } from '@dommaker/studio-shared';
import { WorkUnitService, type WorkUnitMetadata } from '../../workunit/workunit.service.js';

const { mockExecuteLightweight } = vi.hoisted(() => ({
  mockExecuteLightweight: vi.fn(),
}));

vi.mock('@dommaker/studio-agent', () => ({
  agentRunner: {
    executeLightweight: mockExecuteLightweight,
  },
}));

vi.mock('../../knowledge/knowledge-service', () => ({
  knowledgeService: {
    injectContext: vi.fn().mockResolvedValue({ prompt: '', injectedIds: [] }),
    recordOutcome: vi.fn().mockResolvedValue(undefined),
    extractFromExecution: vi.fn().mockResolvedValue(undefined),
  },
}));

import { AgentLoop, parseReviewReport } from '../agent-loop';
import { ReviewDispatcher } from '../review-dispatcher.js';

const mockRole = {
  id: 'reviewer-1',
  name: 'Reviewer',
  description: 'code reviewer 角色',
  channels: '[]',
  status: 'active',
  createdAt: new Date(),
  updatedAt: new Date(),
};

const reviewerProfile: AgentProfileData = {
  id: 'reviewer-1',
  name: 'Reviewer',
  description: 'code reviewer 角色',
  channels: '[]',
  status: 'active',
  provider: 'claude',
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
};

interface RecordResultCapable {
  recordResult(target: unknown, result: unknown): Promise<void>;
  agentStep(target: unknown): Promise<{ action: string; summary: string; metadataUpdates?: Partial<WorkUnitMetadata> }>;
}

describe('parseReviewReport', () => {
  it('解析 REVIEW_RESULT 行（pass + summary + issues）', () => {
    const text = [
      '审查完毕，整体质量不错。',
      'ACTION: COMPLETE:审查通过',
      'REVIEW_RESULT: {"verdict":"pass","summary":"代码质量良好","issues":[{"severity":"info","message":"建议补充注释"}]}',
    ].join('\n');
    const report = parseReviewReport(text);
    expect(report).toEqual({
      approved: true,
      reason: '代码质量良好',
      issues: [{ severity: 'info', message: '建议补充注释' }],
    });
  });

  it('解析 REVIEW_RESULT 行（reject），issues 缺省 → undefined', () => {
    const report = parseReviewReport('REVIEW_RESULT: {"verdict":"reject","summary":"缺少错误处理"}');
    expect(report).toEqual({ approved: false, reason: '缺少错误处理', issues: undefined });
  });

  it('取最末一条 REVIEW_RESULT 行', () => {
    const text = [
      'REVIEW_RESULT: {"verdict":"reject","summary":"过早的结论"}',
      '（补充审查后改判）',
      'REVIEW_RESULT: {"verdict":"pass","summary":"最终通过"}',
    ].join('\n');
    expect(parseReviewReport(text)?.approved).toBe(true);
  });

  it('REVIEW_RESULT JSON 损坏 → 尾部 verdict 关键词兜底', () => {
    const text = '审查完成。\nREVIEW_RESULT: {broken json verdict: "reject"';
    const report = parseReviewReport(text);
    expect(report).not.toBeNull();
    expect(report!.approved).toBe(false);
  });

  it('无 REVIEW_RESULT 行 → 尾部 verdict 关键词兜底（pass）', () => {
    const report = parseReviewReport('分析过程……\n最终结论: verdict: pass');
    expect(report).toEqual({ approved: true, reason: '（关键词兜底判定）' });
  });

  it('完全无结论 → null（不写 reviewReport）', () => {
    expect(parseReviewReport('ACTION: COMPLETE:做完了但没有结论行')).toBeNull();
    expect(parseReviewReport('')).toBeNull();
  });
});

describe('P0: reviewReport 回传链路', () => {
  let testDir: string;
  let fileStore: FileStore;
  let wuService: WorkUnitService;
  let channelId: string;
  let agentLoop: AgentLoop;
  let dispatcher: ReviewDispatcher;

  beforeEach(async () => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-report-'));
    fileStore = new FileStore(testDir);
    wuService = new WorkUnitService(fileStore);
    channelId = `ch-review-${Date.now()}`;
    eventBus.unsubscribeAll?.('workunit.status_changed');
    dispatcher = new ReviewDispatcher(fileStore, wuService);

    await fileStore.createProfile(reviewerProfile);
    await fileStore.createChannel({
      id: channelId, name: '#review-test', type: 'rnd',
      defaultWorkspaceId: null, defaultPath: null,
      discordChannelId: null, discordWebhookUrl: null,
      members: stringifyChannels([reviewerProfile.id]),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    dispatcher.subscribeToEvents();
    // 不 start()：recordResult/agentStep 不依赖运行中的 loop 实例
    agentLoop = new AgentLoop(mockRole, fileStore);
  });

  afterEach(() => {
    eventBus.unsubscribeAll?.('workunit.status_changed');
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  /** 父 WU 进入 in_review → dispatcher 创建 review 子 WU */
  async function setupParentInReview() {
    const parent = await wuService.create({
      scope: '实现功能 X', type: 'feature', channelId,
      status: 'active', assigneeId: 'instance-exec',
    });
    await wuService.transitionStatus(parent.id, 'in_review');
    await new Promise(r => setTimeout(r, 100));
    const snapshots = await fileStore.getIndex();
    const child = snapshots.find(s => s.parentId === parent.id && s.type === 'review');
    return { parent, child };
  }

  it('创建的 review 子 WU scope 含 REVIEW_RESULT 输出约定', async () => {
    const { child } = await setupParentInReview();
    expect(child).toBeDefined();
    expect(child!.scope).toContain('REVIEW_RESULT:');
    expect(child!.scope).toContain('"verdict"');
  });

  it('agentStep: review 子 WU complete + REVIEW_RESULT → metadataUpdates.reviewReport', async () => {
    const { child } = await setupParentInReview();
    const reviewWu = (await wuService.getById(child!.id))!;

    mockExecuteLightweight.mockResolvedValue({
      success: true,
      outputText: [
        '逐行审查了 diff，没有发现问题。',
        'ACTION: COMPLETE:审查通过',
        'REVIEW_RESULT: {"verdict":"pass","summary":"实现正确，测试齐全"}',
      ].join('\n'),
      worktree: '/tmp/wt', outputFiles: [], logFile: '/tmp/log', sessionCount: 1,
    });

    const loop = agentLoop as unknown as RecordResultCapable;
    const stepResult = await loop.agentStep({ workUnit: reviewWu });

    expect(stepResult.action).toBe('complete');
    expect(stepResult.metadataUpdates?.reviewReport).toEqual({
      approved: true,
      reason: '实现正确，测试齐全',
      issues: undefined,
    });
  });

  it('recordResult: review 子 WU complete → 收口 done（非停在 in_review），reviewReport 持久化', async () => {
    const { parent, child } = await setupParentInReview();
    const claimed = await wuService.claim(child!.id, 'instance-reviewer');

    const loop = agentLoop as unknown as RecordResultCapable;
    await loop.recordResult({ workUnit: claimed }, {
      action: 'complete',
      summary: '审查通过',
      metadataUpdates: {
        reviewReport: { approved: true, reason: '实现正确' },
      },
    });
    await new Promise(r => setTimeout(r, 100));

    // 子 WU 直接收口 done；路径 B 消费 reviewReport → 父 WU reviewPassed → done
    const childAfter = (await wuService.getById(child!.id))!;
    expect(childAfter.status).toBe('done');
    const childMeta: WorkUnitMetadata = JSON.parse(childAfter.metadata!);
    expect(childMeta.reviewReport).toEqual({ approved: true, reason: '实现正确' });

    const parentAfter = (await wuService.getById(parent.id))!;
    expect(parentAfter.status).toBe('done');
  });

  it('非 review 类型 WU complete 不受影响（仍停在 in_review）', async () => {
    const wu = await wuService.create({
      scope: '普通任务', type: 'task', channelId: null,
      status: 'active', assigneeId: 'instance-1',
    });
    const loop = agentLoop as unknown as RecordResultCapable;
    await loop.recordResult({ workUnit: wu }, { action: 'complete', summary: '做完了' });
    expect((await wuService.getById(wu.id))!.status).toBe('in_review');
  });

  it('路径 B：review 子 WU done 但无 reviewReport → 父保持 in_review + 频道转人工系统消息', async () => {
    const { parent, child } = await setupParentInReview();

    // reviewer 完成但未输出 REVIEW_RESULT：子 WU 走到 done，无 reviewReport
    await wuService.transitionStatus(child!.id, 'active');
    await wuService.transitionStatus(child!.id, 'in_review');
    await wuService.transitionStatus(child!.id, 'done');
    await new Promise(r => setTimeout(r, 100));

    // 父 WU 不再被默认 reviewRejected（误杀），保持 in_review 等人工
    const parentAfter = (await wuService.getById(parent.id))!;
    expect(parentAfter.status).toBe('in_review');

    const messages = await fileStore.queryMessages(channelId, { workUnitId: parent.id });
    const sysMsg = messages.find(m => m.authorType === 'agent' && m.agentName === 'Studio');
    expect(sysMsg).toBeDefined();
    expect(sysMsg!.content).toContain('转人工');
    expect(sysMsg!.content).toContain('REVIEW_RESULT');
  });

  it('F4: members 损坏/非数组 → 不抛错，按成员未知保守创建自评兜底子 WU', async () => {
    // 非数组 JSON 值（旧裸 JSON.parse 会得到 "oops"）—— F4 后不再静默跳过派发：
    // 成员未知 → 自评兜底（不排除实现者 + selfReview 标记），评审链不断
    await fileStore.updateChannel(channelId, { members: '"oops"' });

    const parent = await wuService.create({
      scope: '实现功能 Y', type: 'feature', channelId,
      status: 'active', assigneeId: 'instance-exec',
    });
    await wuService.transitionStatus(parent.id, 'in_review');
    await new Promise(r => setTimeout(r, 100));

    const snapshots = await fileStore.getIndex();
    const child = snapshots.find(s => s.parentId === parent.id && s.type === 'review');
    expect(child).toBeDefined();
    const meta: WorkUnitMetadata = JSON.parse(child!.metadata!);
    expect(meta.excludeAssignee).toBeUndefined();
    expect(meta.selfReview).toBe(true);

    // 损坏 JSON 同样安全
    await fileStore.updateChannel(channelId, { members: '{broken json' });
    const parent2 = await wuService.create({
      scope: '实现功能 Z', type: 'feature', channelId,
      status: 'active', assigneeId: 'instance-exec',
    });
    await wuService.transitionStatus(parent2.id, 'in_review');
    await new Promise(r => setTimeout(r, 100));

    const snapshots2 = await fileStore.getIndex();
    const child2 = snapshots2.find(s => s.parentId === parent2.id && s.type === 'review');
    expect(child2).toBeDefined();
    expect(JSON.parse(child2!.metadata!).selfReview).toBe(true);
  });
});
