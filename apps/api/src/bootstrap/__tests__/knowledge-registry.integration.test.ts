import { afterEach, describe, expect, it } from 'vitest';
import { registerKnowledgeAdapters } from '../knowledge.js';
import { clearReviewProposalAdapters, getReviewProposalAdapter } from '../../modules/review-proposal/registry.js';

describe('Knowledge 真实 review-proposal 注册表集成（ARCH-06）', () => {
  afterEach(() => clearReviewProposalAdapters());

  it('组合根注册后可通过 kind=knowledge 取出预期 adapter，无需文件或外部副作用', () => {
    registerKnowledgeAdapters();
    const fromRegistry = getReviewProposalAdapter('knowledge');

    expect(fromRegistry).toBeDefined();
    expect(fromRegistry).toMatchObject({
      kind: 'knowledge',
      cardType: 'knowledge_proposal',
      storeNamespace: 'knowledge-proposals',
    });
    expect(fromRegistry?.renderCardContent).toBeTypeOf('function');
    expect(fromRegistry?.onApprove).toBeTypeOf('function');
    expect(fromRegistry?.onReject).toBeTypeOf('function');
  });
});
