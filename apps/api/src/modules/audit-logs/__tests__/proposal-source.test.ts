/**
 * audit-logs/proposal-source (#591 A 类) — review-proposal 聚合读面测试
 *
 * 聚合 7 种 kind 的 *-proposals.jsonl（折叠归各 adapter store 正本，零新写入点），
 * 映射为 audit-logs 行形状（actorType='agent', action='propose', resource=kind）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import {
  registerReviewProposalAdapter,
  clearReviewProposalAdapters,
} from '../../review-proposal/registry.js';
import {
  collectProposalDecisionRows,
  filterProposalDecisionRows,
  type ProposalDecisionRow,
} from '../proposal-source.js';

interface TestProposal {
  id: string;
  createdAt: string;
  title?: string;
}

function register(kind: string, dataDir: string) {
  return registerReviewProposalAdapter<TestProposal>({
    kind,
    cardType: `${kind}_card`,
    storeNamespace: `${kind}-proposals`,
    dataDir,
    fileStore: new FileStore(dataDir),
    renderCardContent: () => ({ content: 'x', cardData: {} }),
    onApprove: async () => ({ status: 'executed' as const }),
  });
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-source-'));
});

afterEach(() => {
  clearReviewProposalAdapters();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('collectProposalDecisionRows', () => {
  it('聚合多 kind，折叠取最新状态，映射 audit 行形状', async () => {
    const a = register('distill', tmpDir);
    const b = register('skill', tmpDir);
    await a.store.appendProposal({ id: 'p-1', createdAt: '2026-09-01T00:00:00.000Z', title: '蒸馏提案' });
    await a.store.appendStatus('p-1', 'executed');
    await b.store.appendProposal({ id: 'p-2', createdAt: '2026-09-02T00:00:00.000Z' });
    await b.store.appendStatus('p-2', 'rejected');

    const rows = await collectProposalDecisionRows();

    expect(rows).toHaveLength(2);
    const p1 = rows.find(r => r.id === 'p-1')!;
    expect(p1.actorType).toBe('agent');
    expect(p1.action).toBe('propose');
    expect(p1.resource).toBe('distill');
    expect(p1.resourceId).toBe('p-1');
    expect(p1.status).toBe('executed');
    expect(p1.createdAt).toBe('2026-09-01T00:00:00.000Z');
    const details = JSON.parse(p1.details!);
    expect(details.summary).toBe('蒸馏提案');
    expect(details.author).toBe('KK'); // 卡片作者缺省（ADR：正本含提案作者）
    expect(details.statusAt).toBeDefined();
    expect(details.proposal).toBeUndefined(); // 列表行保持薄行
    expect(rows.find(r => r.id === 'p-2')!.status).toBe('rejected');
  });

  it('full=true 时 details 带提案全文（详情端点语义）', async () => {
    const a = register('gc', tmpDir);
    await a.store.appendProposal({ id: 'p-full', createdAt: '2026-09-01T00:00:00.000Z', title: 'GC 提案' });

    const rows = await collectProposalDecisionRows({ full: true });

    const details = JSON.parse(rows[0].details!);
    expect(details.proposal).toMatchObject({ id: 'p-full', title: 'GC 提案', status: 'pending' });
  });

  it('无终态墓碑时 status=pending（appendProposal 自带 pending 墓碑口径）', async () => {
    const a = register('knowledge', tmpDir);
    await a.store.appendProposal({ id: 'p-9', createdAt: '2026-09-03T00:00:00.000Z' });

    const rows = await collectProposalDecisionRows();

    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('pending');
    expect(rows[0].details && 'summary' in JSON.parse(rows[0].details)).toBe(false);
  });

  it('单 kind 读取失败不拖垮整列（跳过并留其余 kind）', async () => {
    const good = register('good', tmpDir);
    await good.store.appendProposal({ id: 'p-ok', createdAt: '2026-09-01T00:00:00.000Z' });
    registerReviewProposalAdapter<TestProposal>({
      kind: 'broken',
      cardType: 'broken_card',
      storeNamespace: 'broken-proposals',
      dataDir: tmpDir,
      fileStore: new FileStore(tmpDir),
      store: { listProposals: async () => { throw new Error('boom'); } } as never,
      renderCardContent: () => ({ content: 'x', cardData: {} }),
      onApprove: async () => ({ status: 'executed' as const }),
    });

    const rows = await collectProposalDecisionRows();

    expect(rows.map(r => r.id)).toEqual(['p-ok']);
  });
});

describe('filterProposalDecisionRows', () => {
  const rows: ProposalDecisionRow[] = [
    { id: 'p-1', actorType: 'agent', action: 'propose', resource: 'distill', resourceId: 'p-1', status: 'executed', createdAt: '2026-09-01T00:00:00.000Z', details: null },
    { id: 'p-2', actorType: 'agent', action: 'propose', resource: 'skill', resourceId: 'p-2', status: 'rejected', createdAt: '2026-09-05T00:00:00.000Z', details: null },
    { id: 'p-3', actorType: 'agent', action: 'propose', resource: 'skill', resourceId: 'p-3', status: 'pending', createdAt: '2026-09-10T00:00:00.000Z', details: null },
  ];

  it('actorType=human → 空（提案行恒 agent）', () => {
    expect(filterProposalDecisionRows(rows, { actorType: 'human' })).toHaveLength(0);
    expect(filterProposalDecisionRows(rows, { actorType: 'agent' })).toHaveLength(3);
  });

  it('resource/status 等值过滤', () => {
    expect(filterProposalDecisionRows(rows, { resource: 'skill' }).map(r => r.id)).toEqual(['p-2', 'p-3']);
    expect(filterProposalDecisionRows(rows, { status: 'rejected' }).map(r => r.id)).toEqual(['p-2']);
  });

  it('action=propose 命中；其他 action 排除全部', () => {
    expect(filterProposalDecisionRows(rows, { action: 'propose' })).toHaveLength(3);
    expect(filterProposalDecisionRows(rows, { action: 'claim' })).toHaveLength(0);
  });

  it('人的维度（userId/roleId/companyId/anonymousId）过滤排除提案行', () => {
    expect(filterProposalDecisionRows(rows, { userId: 'u1' })).toHaveLength(0);
    expect(filterProposalDecisionRows(rows, { roleId: 'r1' })).toHaveLength(0);
    expect(filterProposalDecisionRows(rows, { companyId: 'c1' })).toHaveLength(0);
    expect(filterProposalDecisionRows(rows, { anonymousId: 'anon_x' })).toHaveLength(0);
  });

  it('时间范围过滤（createdAt）', () => {
    const out = filterProposalDecisionRows(rows, {
      startTime: new Date('2026-09-04T00:00:00.000Z'),
      endTime: new Date('2026-09-06T00:00:00.000Z'),
    });
    expect(out.map(r => r.id)).toEqual(['p-2']);
  });
});
