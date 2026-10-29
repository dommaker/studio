import { describe, expect, it, vi } from 'vitest';

const { registerKnowledgeReviewAdapter } = vi.hoisted(() => ({
  registerKnowledgeReviewAdapter: vi.fn(),
}));

vi.mock('../review-adapter.js', () => ({ registerKnowledgeReviewAdapter }));

describe('Knowledge composition（ARCH-06）', () => {
  it('导入 KnowledgeService 不隐式注册 review adapter', async () => {
    vi.resetModules();
    registerKnowledgeReviewAdapter.mockClear();

    await import('../knowledge-service.js');

    expect(registerKnowledgeReviewAdapter).not.toHaveBeenCalled();
  });

  it('六能力窄端口由兼容 facade 提供且保持同一实例语义', async () => {
    const { knowledgeService } = await import('../knowledge-service.js');
    const { createKnowledgePorts } = await import('../knowledge-ports.js');

    const ports = createKnowledgePorts(knowledgeService);

    expect(ports.produce).toBe(knowledgeService);
    expect(ports.consume).toBe(knowledgeService);
    expect(ports.track).toBe(knowledgeService);
    expect(ports.lifecycle).toBe(knowledgeService);
    expect(ports.resolve).toBe(knowledgeService);
    expect(ports.measure).toBe(knowledgeService);
  });
});
