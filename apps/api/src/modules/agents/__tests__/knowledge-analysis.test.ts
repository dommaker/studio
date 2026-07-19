/**
 * knowledge-analysis — 会话分析子模块单元测试
 *
 * 自足测试（不依赖真实 LLM / 真实 HOME）：
 * - modelGateway.promptJson mock：控制决策/行为模式提取结果
 * - knowledge-bus mock：knowledgeBus.recordDecision + sharedStore（list/save/get）
 * - os.homedir mock → tmpHome：memory 规则读取与 Skill/memory 即时消费写入落在 tmp
 * - channelMessageService mock：隔离通知
 *
 * 覆盖：
 *  - extractDecision：空内容早退 / DecisionRecord 映射与 category 推断 / LLM 失败返回 null
 *  - extractUserBehavior：空转写早退 / 阈值过滤 / 标题去重（rejected）/
 *    高置信度即时消费（create_skill → SKILL.md，create_rule → feedback_*.md）/ 异常格式 warn
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const {
  tmpHome, mockPromptJson, mockLogger, mockRecordDecision,
  mockStoreList, mockStoreSave, mockStoreGet, mockCreateAgentMessage,
} = vi.hoisted(() => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  return {
    tmpHome: fs.mkdtempSync(path.join(os.tmpdir(), 'kas-home-')),
    mockPromptJson: vi.fn(),
    mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    mockRecordDecision: vi.fn().mockResolvedValue(undefined),
    mockStoreList: vi.fn(() => [] as any[]),
    mockStoreSave: vi.fn(),
    mockStoreGet: vi.fn(),
    mockCreateAgentMessage: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => tmpHome };
});

vi.mock('@dommaker/studio-shared', () => ({
  modelGateway: { promptJson: mockPromptJson },
  logger: mockLogger,
  FileStore: vi.fn().mockImplementation(() => ({
    listChannels: vi.fn().mockResolvedValue([]),
    createChannel: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock('../../knowledge/knowledge-bus.service.js', () => ({
  knowledgeBus: { recordDecision: mockRecordDecision },
  sharedStore: { list: mockStoreList, save: mockStoreSave, get: mockStoreGet },
}));

vi.mock('../../channels/channel-message.service.js', () => ({
  channelMessageService: { createAgentMessage: mockCreateAgentMessage },
}));

import { extractDecision, extractUserBehavior } from '../knowledge-analysis.js';

const fileStore: any = {
  listChannels: vi.fn().mockResolvedValue([{ id: 'ch-1', name: '#系统' }]),
  createChannel: vi.fn().mockResolvedValue(undefined),
};

beforeEach(() => {
  vi.clearAllMocks();
  mockStoreList.mockReturnValue([]);
});

describe('extractDecision', () => {
  it('空内容 → null，不调 LLM', async () => {
    expect(await extractDecision('  ', 'chat:x')).toBeNull();
    expect(mockPromptJson).not.toHaveBeenCalled();
  });

  it('提取到决策 → 映射 DecisionRecord 并写入 knowledgeBus', async () => {
    mockPromptJson.mockResolvedValue({
      decisions: [{
        topic: 'API 分层设计',
        context: '需要统一分层',
        options: [{ name: '三层', pros: ['清晰'], cons: ['繁琐'] }, { name: '两层' }],
        chosen: '三层',
        rationale: '可维护性',
        tradeoffs: '更多样板代码',
        revisitCondition: '模块数 < 5 时',
      }],
    });

    const record = await extractDecision('discussion text', 'chat:2026');
    expect(record).toMatchObject({
      topic: 'API 分层设计',
      category: 'architecture',
      context: '需要统一分层',
      decision: '三层',
      alternatives: ['三层', '两层'],
      rationale: '可维护性',
      consequences: '更多样板代码',
      participants: [],
      sourceType: 'llm-extraction',
      revisable: true,
      revisitCondition: '模块数 < 5 时',
    });
    expect(mockRecordDecision).toHaveBeenCalledWith(record);
    expect(mockPromptJson).toHaveBeenCalledWith(
      'discussion text',
      expect.stringContaining('决策分析师'),
      { provider: 'knowledge', tier: 'standard' },
    );
  });

  it('category 推断：工具/流程/默认 design', async () => {
    for (const [topic, expected] of [
      ['数据库 sqlite 选型', 'tooling'],
      ['部署 pipeline 优化', 'process'],
      ['按钮颜色', 'design'],
    ] as const) {
      mockPromptJson.mockResolvedValueOnce({ decisions: [{ topic, chosen: 'x' }] });
      const record = await extractDecision('text', 'chat:y');
      expect(record?.category).toBe(expected);
    }
  });

  it('无决策 → null 且不写库；LLM 失败 → null + warn', async () => {
    mockPromptJson.mockResolvedValue({ decisions: [] });
    expect(await extractDecision('text', 'chat:z')).toBeNull();
    expect(mockRecordDecision).not.toHaveBeenCalled();

    mockPromptJson.mockRejectedValue(new Error('down'));
    expect(await extractDecision('text', 'chat:z')).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith('[KnowledgeAgent] extractDecision failed', expect.objectContaining({}));
  });
});

describe('extractUserBehavior (KE-003)', () => {
  it('空转写 → 早退，不调 LLM', async () => {
    await extractUserBehavior(fileStore, '  ', 'session:abc');
    expect(mockPromptJson).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith('[KnowledgeAgent] Empty transcript, skipping behavior extraction', { source: 'session:abc' });
  });

  it('阈值过滤 + pending 存储 + 高置信度 create_skill 即时消费', async () => {
    mockPromptJson.mockResolvedValue([
      { category: 'correction', title: '先验证再动手', evidence: '先验证', pattern: '修改前先跑测试验证', suggestedAction: 'create_skill', confidence: 0.9 },
      { category: 'pattern', title: '低置信', evidence: 'x', pattern: 'y', suggestedAction: 'skip', confidence: 0.5 },
    ]);
    mockStoreGet.mockReturnValue({ id: 'x', tags: ['behavior', 'pending'] });

    await extractUserBehavior(fileStore, 'transcript', 'session:u-1.jsonl', 0.6);

    // 低于阈值（0.5 < 0.6）的被跳过，仅 1 条入库
    expect(mockStoreSave).toHaveBeenCalledTimes(2); // 1 次 pending 存储 + 1 次 applied 标记
    const savedEntry = mockStoreSave.mock.calls[0][0];
    expect(savedEntry).toMatchObject({
      type: 'guideline',
      title: '先验证再动手',
      maturity: 'active',
      layer: 'project',
      tags: ['behavior', 'pending'],
      contributors: ['knowledge-agent'],
    });
    const payload = JSON.parse(savedEntry.content);
    expect(payload).toMatchObject({
      sessionId: 'u-1',
      category: 'correction',
      suggestedAction: 'create_skill',
      confidence: 0.9,
      status: 'pending',
    });

    // 即时消费：confidence 0.9 ≥ 0.85 且 create_skill → 写 ~/.studio/skills/<slug>/SKILL.md
    // （非 ASCII 标题 slug 化为空串 → 落在 skills 根目录，与实现行为一致）
    const slug = '先验证再动手'.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const expectedSkill = path.join(tmpHome, '.studio', 'skills', slug, 'SKILL.md');
    expect(fs.existsSync(expectedSkill)).toBe(true);
    const skillContent = fs.readFileSync(expectedSkill, 'utf-8');
    expect(skillContent).toContain('trigger: always');
    expect(skillContent).toContain('修改前先跑测试验证');

    // applied 标记：tags pending → applied
    expect(mockStoreSave).toHaveBeenCalledTimes(2);
    expect(mockStoreSave.mock.calls[1][0].tags).toEqual(['behavior', 'applied']);

    // 通知
    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1);
    const [channelId, sender, content, opts] = mockCreateAgentMessage.mock.calls[0];
    expect(channelId).toBe('ch-1');
    expect(sender).toBe('KK');
    expect(content).toContain('提取了 1 条行为模式');
    expect(content).toContain('即时消费: 1 条');
    expect(opts.meta).toMatchObject({ cardType: 'behavior_extracted', sessionId: 'u-1', stored: 1, consumed: 1, total: 2 });
  });

  it('标题与已有模式子串匹配 → status=rejected，不即时消费', async () => {
    mockStoreList.mockReturnValue([{ title: '先验证再动手' }]);
    mockPromptJson.mockResolvedValue([
      { category: 'correction', title: '先验证再动手原则', evidence: 'e', pattern: 'p', suggestedAction: 'create_skill', confidence: 0.95 },
    ]);

    await extractUserBehavior(fileStore, 'transcript', 'session:u-2', 0.6);

    expect(mockStoreSave).toHaveBeenCalledTimes(1);
    const savedEntry = mockStoreSave.mock.calls[0][0];
    expect(savedEntry.tags).toEqual(['behavior', 'rejected']);
    expect(JSON.parse(savedEntry.content).status).toBe('rejected');
    // 不进入消费循环 → 无 applied 二次保存、无即时消费日志
    expect(mockLogger.info).not.toHaveBeenCalledWith('[KnowledgeAgent] Behavior profile consumed immediately', expect.anything());
  });

  it('create_rule → 写 memory feedback_<topic>.md', async () => {
    mockPromptJson.mockResolvedValue([
      { category: 'pattern', title: 'commit early', evidence: 'e', pattern: '小步提交', suggestedAction: 'create_rule', confidence: 0.95 },
    ]);
    mockStoreGet.mockReturnValue({ id: 'x', tags: ['behavior', 'pending'] });

    await extractUserBehavior(fileStore, 'transcript', 'session:u-3', 0.6);

    const rulePath = path.join(tmpHome, '.claude', 'projects', '-root-projects', 'memory', 'feedback_commit_early.md');
    expect(fs.existsSync(rulePath)).toBe(true);
    const ruleContent = fs.readFileSync(rulePath, 'utf-8');
    expect(ruleContent).toContain('# commit early');
    expect(ruleContent).toContain('小步提交');
  });

  it('LLM 返回异常格式 → warn 且不写库', async () => {
    mockPromptJson.mockResolvedValue({ foo: 'bar' });
    await extractUserBehavior(fileStore, 'transcript', 'session:u-4', 0.6);
    expect(mockLogger.warn).toHaveBeenCalledWith('[KnowledgeAgent] Unexpected behavior extraction format', expect.objectContaining({ keys: ['foo'] }));
    expect(mockStoreSave).not.toHaveBeenCalled();
  });

  it('LLM 抛错 → warn 静默返回', async () => {
    mockPromptJson.mockRejectedValue(new Error('down'));
    await expect(extractUserBehavior(fileStore, 'transcript', 'session:u-5', 0.6)).resolves.toBeUndefined();
    expect(mockLogger.warn).toHaveBeenCalledWith('[KnowledgeAgent] Behavior extraction failed', expect.objectContaining({}));
    expect(mockStoreSave).not.toHaveBeenCalled();
  });
});
