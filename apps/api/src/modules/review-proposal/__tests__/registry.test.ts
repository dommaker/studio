/**
 * review-proposal/registry (#351) — adapter 注册表测试
 *
 * 注册配置对象 `{ kind, cardType, storeNamespace, dataDir, fileStore, renderCardContent,
 * onApprove, onReject? }`；注册时按 storeNamespace 物化 `<dataDir>/<namespace>.jsonl` 存取。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { FileStore } from '@dommaker/studio-shared';
import {
  registerReviewProposalAdapter,
  getReviewProposalAdapter,
  clearReviewProposalAdapters,
  type ReviewProposalAdapterConfig,
} from '../registry.js';

interface TestProposal {
  id: string;
  createdAt: string;
}

function makeConfig(kind: string, dataDir: string): ReviewProposalAdapterConfig<TestProposal> {
  return {
    kind,
    cardType: `${kind}_proposal`,
    storeNamespace: `${kind}-proposals`,
    dataDir,
    fileStore: new FileStore(dataDir),
    renderCardContent: () => ({ content: 'x', cardData: {} }),
    onApprove: async () => ({ status: 'executed' as const }),
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-proposal-registry-'));
});

afterEach(() => {
  clearReviewProposalAdapters();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('review-proposal registry', () => {
  it('register → get 按 kind 取回；store 按 namespace 物化到 <dataDir>/<namespace>.jsonl', async () => {
    const adapter = registerReviewProposalAdapter(makeConfig('test', tmpDir));
    expect(getReviewProposalAdapter('test')).toBe(adapter);
    await adapter.store.appendProposal({ id: 'p-1', createdAt: new Date().toISOString() });
    expect(fs.existsSync(path.join(tmpDir, 'test-proposals.jsonl'))).toBe(true);
  });

  it('未注册 kind → undefined', () => {
    expect(getReviewProposalAdapter('nope')).toBeUndefined();
  });

  it('同 kind 重复注册 → 后注册生效（运行时装配幂等）', () => {
    const first = registerReviewProposalAdapter(makeConfig('test', tmpDir));
    const second = registerReviewProposalAdapter(makeConfig('test', tmpDir));
    expect(getReviewProposalAdapter('test')).toBe(second);
    expect(getReviewProposalAdapter('test')).not.toBe(first);
  });

  it('clearReviewProposalAdapters 清空注册表（测试隔离）', () => {
    registerReviewProposalAdapter(makeConfig('test', tmpDir));
    clearReviewProposalAdapters();
    expect(getReviewProposalAdapter('test')).toBeUndefined();
  });
});
