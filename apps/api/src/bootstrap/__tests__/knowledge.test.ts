import { beforeEach, describe, expect, it, vi } from 'vitest';

const { registerKnowledgeReviewAdapter } = vi.hoisted(() => ({
  registerKnowledgeReviewAdapter: vi.fn(),
}));

vi.mock('../../modules/knowledge/review-adapter.js', () => ({ registerKnowledgeReviewAdapter }));

import { registerKnowledgeAdapters } from '../knowledge.js';

describe('bootstrap Knowledge 装配（ARCH-06）', () => {
  beforeEach(() => registerKnowledgeReviewAdapter.mockClear());

  it('启动组合根显式注册；重复调用仍交给既有后者生效语义', () => {
    registerKnowledgeAdapters();
    registerKnowledgeAdapters();

    expect(registerKnowledgeReviewAdapter).toHaveBeenCalledTimes(2);
  });
});
