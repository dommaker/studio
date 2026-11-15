/**
 * #717 端到端接缝：蒸馏 Skill 提案经通用审批发布后，后续 WU 注入选择器能按规则发现。
 * SKILLS_DIR 必须早于 manifest-loader / review-adapter 动态 import。
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-approval-publication-'));
const skillsDir = path.join(tmpRoot, 'skills');
process.env.SKILLS_DIR = skillsDir;

const { mockSkillCreate, mockSkillGet, mockSkillList, mockSkillUpdate } = vi.hoisted(() => ({
  mockSkillCreate: vi.fn(),
  mockSkillGet: vi.fn(),
  mockSkillList: vi.fn(),
  mockSkillUpdate: vi.fn(),
}));

vi.mock('../skill-store.js', () => ({
  skillStore: { create: mockSkillCreate, get: mockSkillGet, list: mockSkillList, update: mockSkillUpdate },
}));

const { FileStore } = await import('@dommaker/studio-shared');
const { approveProposal, getProposalStatus } = await import('../../review-proposal/service.js');
const { registerChannelCardPoster } = await import('../../review-proposal/card.js');
const { registerSkillReviewAdapter } = await import('../review-adapter.js');
const { createSkillLanding } = await import('../../distill/distill-landings.js');
const { loadManifest } = await import('../manifest-loader.js');
const { buildSkillSection } = await import('../../agent-loop/prompt-sections/prompt-section-skill.js');

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('蒸馏 Skill 审批 → 发布 → WU 注入候选', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('真实蒸馏 landing 产出的 Skill 一次 approve 后进入 WU 注入段', async () => {
    const fileStore = new FileStore(tmpRoot);
    vi.spyOn(fileStore, 'listChannels').mockResolvedValue([{ id: 'ch-sys', name: '#系统', type: 'system' }]);
    registerChannelCardPoster(vi.fn().mockResolvedValue({}));
    registerSkillReviewAdapter({ fileStore, dataDir: path.join(tmpRoot, 'data') });
    const companiesDir = path.join(tmpRoot, 'companies');
    fs.mkdirSync(companiesDir, { recursive: true });
    fs.writeFileSync(path.join(companiesDir, 'c1.json'), JSON.stringify({ id: 'company-1' }));
    const record = {
      id: 'skill-1',
      name: 'ci-fix',
      description: '先复现，再修复，最后跑受影响测试。',
      metadata: JSON.stringify({ tags: ['ci', 'test'], distillProductId: 'product-1' }),
    };
    mockSkillCreate.mockReturnValue(record);
    mockSkillGet.mockReturnValue(record);
    mockSkillList.mockReturnValue([{ ...record, status: 'approved' }]);

    const landed = await createSkillLanding({ fileStore, companiesDir })({
      type: 'skill', title: 'ci-fix', content: record.description, tags: ['ci', 'test'],
    }, {
      materialIds: ['material-1'], proposalId: 'distill-1', runId: 'run-1', productId: 'product-1', recovery: false,
    });
    expect(landed).toMatchObject({ durable: true });
    const proposalId = typeof landed === 'object' && landed ? landed.id : '';
    expect(await approveProposal('skill', proposalId)).toMatchObject({ kind: 'executed' });
    expect(await getProposalStatus('skill', proposalId)).toMatchObject({ ok: true, status: 'executed' });

    expect(loadManifest()).toHaveLength(1);
    const injected = await buildSkillSection(
      { type: 'feature', scope: '修复 CI +ci-fix' } as never,
      { role: { skills: [] } as never, acceptedTypes: ['feature'] },
      1000,
    );
    expect(injected.matched).toEqual(['ci-fix']);
    expect(injected.section).toContain('### ci-fix');
    expect(injected.section).toContain('先复现，再修复，最后跑受影响测试。');
  });
});
