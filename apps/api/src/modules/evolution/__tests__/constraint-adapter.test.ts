/**
 * constraint-adapter 测试（ADR-0033 块 3 子项 7：知识→约束，新 kind `constraint`）
 *
 * 覆盖：
 *   - draftConstraintId / inferCheckerDraft 草稿推断
 *   - renderConstraintCard 白话卡面（含「待确认」分支；不摆 k=v 字段名原文）
 *   - scanConstraintCandidates：constraintCandidate 标签过滤 + 提案记录消耗标记防重复
 *   - approve 端到端：append 写 .harness/constraints.yml（不动既有条目）
 *     + getEffectiveConstraints 双验证 + git commit 留痕（Governance-Approved trailer）
 *   - 参数待确认 → aborted（保持 pending 不落 failed）；reject → rejected
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import { execFileSync } from 'node:child_process';
import type { KnowledgeEntry } from '@dommaker/harness';
import { FileStore } from '@dommaker/studio-shared';
import { approveProposal, rejectProposal, getProposalStatus } from '../../review-proposal/service.js';
import { clearReviewProposalAdapters } from '../../review-proposal/registry.js';
import {
  draftConstraintId,
  inferCheckerDraft,
  registerConstraintReviewAdapter,
  renderConstraintCard,
  scanConstraintCandidates,
  type ConstraintProposal,
} from '../constraint-adapter.js';

const { mockCreateCardMessage, mockCreateAgentMessage } = vi.hoisted(() => ({
  mockCreateCardMessage: vi.fn(),
  mockCreateAgentMessage: vi.fn(),
}));

vi.mock('../../channels/channel-message.service.js', () => ({
  channelMessageService: { createCardMessage: mockCreateCardMessage, createAgentMessage: mockCreateAgentMessage },
}));

let tmpDir: string;
let repoRoot: string;
let fileStore: FileStore;

function makeEntry(over?: Partial<KnowledgeEntry>): KnowledgeEntry {
  return {
    id: 'k-entry-1',
    type: 'guideline',
    title: 'no internal url in web code',
    content: '前端代码不得出现内网地址，如 `https?://10\\.\\d+\\.`',
    maturity: 'proven',
    layer: 'project',
    created: new Date().toISOString(),
    lastReferenced: new Date().toISOString(),
    contributors: ['a', 'b', 'c'],
    projects: [],
    tags: ['constraintCandidate'],
    applicablePhases: [],
    sourceReferences: [],
    referencedBy: ['t1', 't2', 't3', 't4', 't5'],
    executionResults: [],
    consumptionMode: 'rule',
    origin: 'agent',
    ...over,
  } as KnowledgeEntry;
}

function makeProposal(over?: Partial<ConstraintProposal>): ConstraintProposal {
  return {
    id: 'cp-test-1',
    createdAt: new Date().toISOString(),
    action: 'new',
    repoRoot,
    constraintId: 'app_no_internal_url',
    rule: '前端代码不得出现内网地址',
    checker: 'regex-scan',
    params: { pattern: 'https?://10\\.\\d+\\.', glob: 'apps/web/src/**' },
    severity: 'warning',
    message: '违反约束：前端代码不得出现内网地址',
    sourceEntry: { id: 'k-entry-1', title: 'no internal url in web code' },
    ...over,
  };
}

function readConstraintsFile(): Array<Record<string, unknown>> {
  const file = path.join(repoRoot, '.harness', 'constraints.yml');
  const raw = (yaml.load(fs.readFileSync(file, 'utf-8')) as { constraints?: Array<Record<string, unknown>> }) ?? {};
  return raw.constraints ?? [];
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockCreateCardMessage.mockResolvedValue({ id: 'msg-1' });
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'constraint-adapter-'));
  repoRoot = path.join(tmpDir, 'repo');
  fs.mkdirSync(path.join(repoRoot, '.harness'), { recursive: true });
  execFileSync('git', ['init'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
  execFileSync('git', ['config', 'user.name', 'test'], { cwd: repoRoot });
  fileStore = new FileStore(tmpDir);
  const now = new Date().toISOString();
  await fileStore.createChannel({
    id: 'ch-sys', name: '#系统', type: 'system',
    defaultWorkspaceId: null, defaultPath: null,
    discordChannelId: null, discordWebhookUrl: null,
    members: '[]', createdAt: now, updatedAt: now,
  });
  registerConstraintReviewAdapter({ fileStore, dataDir: tmpDir });
});

afterEach(() => {
  clearReviewProposalAdapters();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('草稿推断', () => {
  it('draftConstraintId：标题 slug 优先，纯中文标题退 entry id', () => {
    expect(draftConstraintId({ id: 'k1', title: 'No Hardcoded Credentials!' }))
      .toBe('app_no_hardcoded_credentials');
    expect(draftConstraintId({ id: 'k-Ab12', title: '前端不得硬编码' })).toBe('app_k_ab12');
  });

  it('inferCheckerDraft：内容含可编译正则 → regex-scan 预填；不含 → null 待确认', () => {
    const hit = inferCheckerDraft('不得出现内网地址，如 `https?://10\\.\\d+\\.`');
    expect(hit.checker).toBe('regex-scan');
    expect(hit.params.pattern).toBe('https?://10\\.\\d+\\.');

    const fence = inferCheckerDraft('示例：\n```\n^SECRET_[A-Z]+$\n```');
    expect(fence.checker).toBe('regex-scan');
    expect(fence.params.pattern).toBe('^SECRET_[A-Z]+$');

    const miss = inferCheckerDraft('提交前必须跑测试，不准跳过。');
    expect(miss.checker).toBeNull();
    expect(miss.params).toEqual({});
  });
});

describe('renderConstraintCard（action=new）', () => {
  it('白话卡面：来源知识/条文/检查器/参数齐全；无字段名原文', () => {
    const { content, cardData } = renderConstraintCard(makeProposal());
    expect(content).toContain('新约束提案 cp-test-1');
    expect(content).toContain('来源知识：no internal url in web code（k-entry-1）');
    expect(content).toContain('条文草稿：前端代码不得出现内网地址');
    expect(content).toContain('正则扫描');
    expect(content).toContain('pattern: "https?://10\\\\.\\\\d+\\\\."');
    expect(content).not.toContain('failRate');
    expect(content).not.toContain('evaluated');
    expect(cardData.proposalId).toBe('cp-test-1');
    expect(cardData.action).toBe('new');
    expect(cardData.constraintId).toBe('app_no_internal_url');
  });

  it('checker 推断不出 → 卡面标「待确认」并说明不可落盘', () => {
    const { content } = renderConstraintCard(makeProposal({ checker: null, params: {} }));
    expect(content).toContain('待确认');
    expect(content).toContain('无法从条目内容推断');
  });
});

describe('scanConstraintCandidates', () => {
  it('只吃 constraintCandidate 标签条目；发卡到 #系统；二轮扫描防重复（提案记录即消耗标记）', async () => {
    const adapter = registerConstraintReviewAdapter({ fileStore, dataDir: tmpDir });
    const entries = [
      makeEntry(),
      makeEntry({ id: 'k-entry-2', title: 'untagged', tags: [] }),
    ];
    const r1 = await scanConstraintCandidates({
      adapter, listEntries: () => entries, repoRoot, postCard: true,
    });
    expect(r1.created).toHaveLength(1);
    expect(r1.posted).toBe(1);
    expect(r1.created[0].constraintId).toBe('app_no_internal_url_in_web_code');
    expect(r1.created[0].checker).toBe('regex-scan');
    expect(mockCreateCardMessage).toHaveBeenCalledTimes(1);
    const [, author, , cardType, cardData] = mockCreateCardMessage.mock.calls[0];
    expect(author).toBe('Evolution');
    expect(cardType).toBe('constraint_proposal');
    expect((cardData as { proposalId: string }).proposalId).toBe(r1.created[0].id);

    // 第二轮：同条目已被提案消耗（含 pending），不再产卡
    const r2 = await scanConstraintCandidates({
      adapter, listEntries: () => entries, repoRoot, postCard: true,
    });
    expect(r2.created).toHaveLength(0);
    expect(r2.skipped['already-proposed']).toBe(1);
    expect(mockCreateCardMessage).toHaveBeenCalledTimes(1);
  });

  it('已驳回条目不再重复提案（rejected 也算消耗）', async () => {
    const adapter = registerConstraintReviewAdapter({ fileStore, dataDir: tmpDir });
    const entries = [makeEntry()];
    const r1 = await scanConstraintCandidates({
      adapter, listEntries: () => entries, repoRoot, postCard: true,
    });
    await rejectProposal('constraint', r1.created[0].id);

    const r2 = await scanConstraintCandidates({
      adapter, listEntries: () => entries, repoRoot, postCard: true,
    });
    expect(r2.created).toHaveLength(0);
    expect(r2.skipped['already-proposed']).toBe(1);
  });

  it('无候选 → 零提案零发卡（保守安静）', async () => {
    const adapter = registerConstraintReviewAdapter({ fileStore, dataDir: tmpDir });
    const r = await scanConstraintCandidates({
      adapter, listEntries: () => [makeEntry({ tags: [] })], repoRoot, postCard: true,
    });
    expect(r.created).toHaveLength(0);
    expect(mockCreateCardMessage).not.toHaveBeenCalled();
  });
});

describe('approve（action=new）端到端', () => {
  it('append 写 constraints.yml（不动既有条目）+ 生效集验证 + git commit 留痕 trailer', async () => {
    // 既有条目：append 不得动它
    const file = path.join(repoRoot, '.harness', 'constraints.yml');
    fs.writeFileSync(file, yaml.dump({
      constraints: [{
        id: 'app_existing', rule: '既有约束', checker: 'file-exists',
        params: { path: 'README.md' }, severity: 'info', message: '既有',
      }],
    }), 'utf-8');

    const adapter = registerConstraintReviewAdapter({ fileStore, dataDir: tmpDir });
    const p = makeProposal();
    await adapter.store.appendProposal(p);

    const result = await approveProposal('constraint', p.id);
    expect(result.kind).toBe('executed');

    const entries = readConstraintsFile();
    expect(entries.map(e => e.id)).toEqual(['app_existing', 'app_no_internal_url']);
    expect(entries[1]).toMatchObject({
      rule: '前端代码不得出现内网地址',
      checker: 'regex-scan',
      params: { pattern: 'https?://10\\.\\d+\\.', glob: 'apps/web/src/**' },
      severity: 'warning',
    });

    // git commit 留痕：正文带提案号 + Governance-Approved trailer
    const log = execFileSync('git', ['log', '--format=%B', '-1'], { cwd: repoRoot, encoding: 'utf-8' });
    expect(log).toContain('add app constraint app_no_internal_url (cp-test-1)');
    expect(log).toContain('Governance-Approved: cp-test-1');

    // 正本状态派生 + 幂等闸
    expect((await getProposalStatus('constraint', p.id)).status).toBe('executed');
    const again = await approveProposal('constraint', p.id);
    expect(again).toEqual({ kind: 'invalid', error: 'proposal-not-pending:executed' });
  });

  it('checker 待确认 → aborted（不落 failed 终态，提案保持 pending）', async () => {
    const adapter = registerConstraintReviewAdapter({ fileStore, dataDir: tmpDir });
    const p = makeProposal({ checker: null, params: {} });
    await adapter.store.appendProposal(p);

    const result = await approveProposal('constraint', p.id);
    expect(result.kind).toBe('aborted');
    expect((result as { error?: string }).error).toContain('待确认');
    expect(fs.existsSync(path.join(repoRoot, '.harness', 'constraints.yml'))).toBe(false);
    expect((await getProposalStatus('constraint', p.id)).status).toBe('pending');
  });

  it('非法 repoRoot → failed（落 failed 墓碑，不写文件）', async () => {
    const adapter = registerConstraintReviewAdapter({ fileStore, dataDir: tmpDir });
    const p = makeProposal({ repoRoot: path.join(tmpDir, 'not-exist') });
    await adapter.store.appendProposal(p);

    const result = await approveProposal('constraint', p.id);
    expect(result.kind).toBe('failed');
    expect((result as { error?: string }).error).toContain('invalid repoRoot');
  });

  it('reject → rejected 零副作用', async () => {
    const adapter = registerConstraintReviewAdapter({ fileStore, dataDir: tmpDir });
    const p = makeProposal();
    await adapter.store.appendProposal(p);

    const r = await rejectProposal('constraint', p.id);
    expect(r.ok).toBe(true);
    expect(fs.existsSync(path.join(repoRoot, '.harness', 'constraints.yml'))).toBe(false);
    expect((await getProposalStatus('constraint', p.id)).status).toBe('rejected');
  });
});

describe('approve（action=upgrade，子项 8）', () => {
  function seedAppConstraint(): void {
    const file = path.join(repoRoot, '.harness', 'constraints.yml');
    fs.writeFileSync(file, yaml.dump({
      constraints: [{
        id: 'app_no_internal_url', rule: '前端代码不得出现内网地址', checker: 'regex-scan',
        params: { pattern: 'https?://10\\.\\d+\\.' }, severity: 'warning', message: '检测到内网地址',
      }],
    }), 'utf-8');
  }

  it('approve → spawn pack-proposal 落材料 + 回帖 #系统（路径 + 摘要 + 人工开 issue 提示）', async () => {
    seedAppConstraint();
    mockCreateAgentMessage.mockResolvedValue({ id: 'msg-note-1' });
    const adapter = registerConstraintReviewAdapter({ fileStore, dataDir: tmpDir });
    const p = makeProposal({ action: 'upgrade', statsText: '累计评估 0 次，拦到 0 次', sourceEntry: undefined });
    await adapter.store.appendProposal(p);

    const result = await approveProposal('constraint', p.id);
    expect(result.kind).toBe('executed');
    const materialPath = (result as { data?: { materialPath?: string } }).data?.materialPath;
    expect(materialPath).toBeTruthy();
    expect(fs.existsSync(materialPath as string)).toBe(true);
    expect(fs.readFileSync(materialPath as string, 'utf-8')).toContain('约束升级提案材料：app_no_internal_url');

    // 回帖：纯文本 agent 消息到 #系统，带材料路径 + 脱敏人工确认提示
    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1);
    const [channelId, author, content] = mockCreateAgentMessage.mock.calls[0];
    expect(channelId).toBe('ch-sys');
    expect(author).toBe('Evolution');
    expect(content).toContain(materialPath);
    expect(content).toContain('开 issue');
    expect(content).toContain('不自动开');
  }, 30_000);

  it('pack-proposal 失败（约束不存在）→ failed 墓碑，无回帖', async () => {
    // 不 seed constraints.yml → CLI 找不到约束，退出码非零
    const adapter = registerConstraintReviewAdapter({ fileStore, dataDir: tmpDir });
    const p = makeProposal({ action: 'upgrade', sourceEntry: undefined });
    await adapter.store.appendProposal(p);

    const result = await approveProposal('constraint', p.id);
    expect(result.kind).toBe('failed');
    expect((result as { error?: string }).error).toContain('pack-proposal');
    expect(mockCreateAgentMessage).not.toHaveBeenCalled();
  }, 30_000);

  it('upgrade 卡面：条文 + checker 配置 + 统计白话（statsText）', () => {
    const { content, cardData } = renderConstraintCard(
      makeProposal({ action: 'upgrade', statsText: '累计评估 60 次，拦到 0 次', sourceEntry: undefined }),
    );
    expect(content).toContain('约束升级提案 cp-test-1');
    expect(content).toContain('应用层约束：app_no_internal_url');
    expect(content).toContain('使用情况：累计评估 60 次，拦到 0 次');
    expect(content).toContain('正则扫描');
    expect(cardData.action).toBe('upgrade');
  });
});
