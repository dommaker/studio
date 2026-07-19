/**
 * knowledge-extraction — 提取子模块单元测试
 *
 * 自足测试（不依赖真实 LLM / 真实 git 仓库 / 真实 HOME）：
 * - modelGateway.promptJson mock：控制 LLM 提取结果
 * - child_process.exec mock（自定义 promisify）：控制 getDiff/getChangedFiles 输出
 * - channelMessageService / decision-chain-extractor / discord-notifier mock：隔离通知副作用
 * - safeIngest 以 SafeIngestFn 注入（实现保留在门面），此处用 vi.fn 验证调用契约
 *
 * 覆盖：
 *  - getExtractFromTextSystemPrompt：E1 override 命中/未命中
 *  - extract：无变更跳过 / 确认卡片推送 / #系统 缺失时 fallback 直写
 *  - extractFromReview：pmo tag 解析与注入
 *  - extractFromError：pitfall 类型与 error 标签
 *  - extractFromText：空文本早退 / 条目入库 + ChannelMessage + Discord 通知
 *  - getOrCreateSystemChannel：已存在复用 / 缺失创建 / 异常返回 null
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockPromptJson, mockLogger, mockReadPromptOverride, mockGit,
  mockCreateCardMessage, mockCreateAgentMessage, mockExtractFromExecution, mockDiscordSendText,
} = vi.hoisted(() => ({
  mockPromptJson: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockReadPromptOverride: vi.fn(() => null),
  mockGit: { stdout: '' as string | Error },
  mockCreateCardMessage: vi.fn().mockResolvedValue(undefined),
  mockCreateAgentMessage: vi.fn().mockResolvedValue(undefined),
  mockExtractFromExecution: vi.fn().mockResolvedValue(undefined),
  mockDiscordSendText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@dommaker/studio-shared', () => ({
  modelGateway: { promptJson: mockPromptJson },
  logger: mockLogger,
  readPromptOverride: mockReadPromptOverride,
  FileStore: vi.fn().mockImplementation(() => ({
    listChannels: vi.fn().mockResolvedValue([]),
    createChannel: vi.fn().mockResolvedValue(undefined),
    readJson: vi.fn().mockRejectedValue(new Error('not found')),
  })),
}));

vi.mock('child_process', () => {
  const execFn: any = (_cmd: string, _opts: any, cb: any) => {
    if (mockGit.stdout instanceof Error) cb(mockGit.stdout);
    else cb(null, mockGit.stdout, '');
  };
  execFn[Symbol.for('nodejs.util.promisify.custom')] = (_cmd: string, _opts: any) =>
    mockGit.stdout instanceof Error
      ? Promise.reject(mockGit.stdout)
      : Promise.resolve({ stdout: mockGit.stdout, stderr: '' });
  return { exec: execFn };
});

vi.mock('../../channels/channel-message.service.js', () => ({
  channelMessageService: {
    createCardMessage: mockCreateCardMessage,
    createAgentMessage: mockCreateAgentMessage,
  },
}));

vi.mock('../../knowledge/decision-chain-extractor.js', () => ({
  decisionChainExtractor: { extractFromExecution: mockExtractFromExecution },
}));

vi.mock('../../../utils/discord-notifier.js', () => ({
  discordNotifier: { sendText: mockDiscordSendText },
}));

import {
  extract,
  extractFromReview,
  extractFromError,
  extractFromText,
  getOrCreateSystemChannel,
  getExtractFromTextSystemPrompt,
  EXTRACT_FROM_TEXT_SYSTEM_PROMPT,
} from '../knowledge-extraction.js';

function makeFileStore(overrides: Record<string, any> = {}): any {
  return {
    listChannels: vi.fn().mockResolvedValue([{ id: 'ch-1', name: '#系统' }]),
    createChannel: vi.fn().mockResolvedValue(undefined),
    readJson: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

const baseParams = {
  taskId: 't-1',
  projectId: 'p-1',
  worktree: '/tmp/wt',
  taskDescription: '实现某功能',
  result: 'success' as const,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGit.stdout = '';
  mockReadPromptOverride.mockReturnValue(null);
});

describe('getExtractFromTextSystemPrompt (E1)', () => {
  it('无 override 时返回默认常量', () => {
    expect(getExtractFromTextSystemPrompt()).toBe(EXTRACT_FROM_TEXT_SYSTEM_PROMPT);
    expect(mockReadPromptOverride).toHaveBeenCalledWith('knowledge.extract-from-text');
  });

  it('override 命中时返回覆盖内容', () => {
    mockReadPromptOverride.mockReturnValue('custom-prompt');
    expect(getExtractFromTextSystemPrompt()).toBe('custom-prompt');
  });
});

describe('extract', () => {
  it('成功且无 diff 无变更文件 → 跳过，不调 LLM', async () => {
    const safeIngest = vi.fn();
    await extract(makeFileStore(), safeIngest, baseParams);

    expect(mockLogger.info).toHaveBeenCalledWith('[KnowledgeAgent] No changes to extract from, skipping', { taskId: 't-1' });
    expect(mockPromptJson).not.toHaveBeenCalled();
    expect(safeIngest).not.toHaveBeenCalled();
  });

  it('提取到条目 → 推送 knowledge_confirm 确认卡片到 #系统', async () => {
    mockGit.stdout = 'diff output';
    mockPromptJson.mockResolvedValue({
      entries: [
        { type: 'decision', title: '决策A', content: '内容A', tags: ['t1'] },
        { type: 'pitfall', title: '坑B', content: '内容B', tags: [] },
      ],
    });
    const safeIngest = vi.fn();
    await extract(makeFileStore(), safeIngest, { ...baseParams, result: 'failure', error: 'boom' });

    expect(mockPromptJson).toHaveBeenCalledTimes(1);
    expect(mockCreateCardMessage).toHaveBeenCalledTimes(1);
    const [channelId, sender, content, cardType, meta] = mockCreateCardMessage.mock.calls[0];
    expect(channelId).toBe('ch-1');
    expect(sender).toBe('KK');
    expect(content).toContain('发现 2 条知识');
    expect(content).toContain('决策A');
    expect(cardType).toBe('knowledge_confirm');
    expect(meta).toMatchObject({ taskId: 't-1', projectId: 'p-1', source: 'task:t-1' });
    expect(meta.entries).toHaveLength(2);
    expect(safeIngest).not.toHaveBeenCalled();
  });

  it('#系统 Channel 不可用 → fallback 直写（writeEntriesDirect → safeIngest）', async () => {
    mockGit.stdout = 'diff output';
    mockPromptJson.mockResolvedValue({
      entries: [{ type: 'pitfall', title: '坑B', content: '内容B', tags: ['x'] }],
    });
    const fileStore = makeFileStore({ listChannels: vi.fn().mockResolvedValue([]) });
    const safeIngest = vi.fn();
    await extract(fileStore, safeIngest, baseParams);

    expect(mockLogger.warn).toHaveBeenCalledWith('[KnowledgeAgent] #系统 channel not found, falling back to direct write', { taskId: 't-1' });
    expect(safeIngest).toHaveBeenCalledTimes(1);
    expect(safeIngest).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'pitfall', title: '坑B', projects: ['p-1'] }),
      expect.objectContaining({ source: 'task:t-1', layer: 'project', maturity: 'draft' }),
    );
    expect(mockCreateCardMessage).not.toHaveBeenCalled();
  });

  it('LLM 抛错 → 捕获并记 error，不向上抛出', async () => {
    mockGit.stdout = 'diff';
    mockPromptJson.mockRejectedValue(new Error('llm down'));
    await expect(extract(makeFileStore(), vi.fn(), baseParams)).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledWith('[KnowledgeAgent] Extraction failed', expect.objectContaining({ taskId: 't-1' }));
  });
});

describe('extractFromReview', () => {
  const reviewResult = {
    approved: false,
    score: 60,
    issues: [{ severity: 'high', message: '缺少测试', file: 'a.ts', line: 3 }],
    suggestions: ['补测试'],
  };

  it('解析 pmoNumber → 注入 pmo tag，source=review:<taskId>', async () => {
    mockPromptJson.mockResolvedValue({ entries: [{ type: 'pitfall', title: 'T', content: 'C', tags: ['k'] }] });
    const fileStore = makeFileStore({ readJson: vi.fn().mockResolvedValue({ pmoNumber: 'PMO-9' }) });
    const safeIngest = vi.fn();
    await extractFromReview(fileStore, safeIngest, reviewResult, 't-9', 'p-9');

    expect(safeIngest).toHaveBeenCalledTimes(1);
    expect(safeIngest).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ['k', 'pmo:PMO-9'], projects: ['p-9'] }),
      expect.objectContaining({ source: 'review:t-9', layer: 'project', maturity: 'draft', tags: ['k', 'pmo:PMO-9'] }),
    );
  });

  it('无条目 → 不写库', async () => {
    mockPromptJson.mockResolvedValue({ entries: [] });
    const safeIngest = vi.fn();
    await extractFromReview(makeFileStore(), safeIngest, reviewResult, 't-9', 'p-9');
    expect(safeIngest).not.toHaveBeenCalled();
  });
});

describe('extractFromError', () => {
  it('每条提取结果以 pitfall 入库，options.tags 追加 error', async () => {
    mockPromptJson.mockResolvedValue({
      entries: [
        { type: 'pitfall', title: 'E1', content: 'C1', tags: ['phantom-dependency'] },
        { type: 'pitfall', title: 'E2', content: 'C2' },
      ],
    });
    const safeIngest = vi.fn();
    await extractFromError(safeIngest, 'err text', 'chain text', '任务描述', 't-5', 'p-5');

    expect(safeIngest).toHaveBeenCalledTimes(2);
    expect(safeIngest).toHaveBeenNthCalledWith(1,
      expect.objectContaining({ type: 'pitfall', title: 'E1', tags: ['phantom-dependency'] }),
      expect.objectContaining({ source: 'error:t-5', tags: ['phantom-dependency', 'error'] }),
    );
    expect(safeIngest).toHaveBeenNthCalledWith(2,
      expect.objectContaining({ type: 'pitfall', title: 'E2' }),
      expect.objectContaining({ source: 'error:t-5', tags: ['error'] }),
    );
  });

  it('LLM 失败 → warn 并静默返回', async () => {
    mockPromptJson.mockRejectedValue(new Error('down'));
    const safeIngest = vi.fn();
    await expect(extractFromError(safeIngest, 'e', 'c', 'd', 't', 'p')).resolves.toBeUndefined();
    expect(safeIngest).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith('[KnowledgeAgent] extractFromError failed', expect.objectContaining({ taskId: 't' }));
  });
});

describe('extractFromText', () => {
  it('空文本 → 早退，不调 LLM', async () => {
    const safeIngest = vi.fn();
    await extractFromText(makeFileStore(), safeIngest, '   ', 'chat:x');
    expect(mockPromptJson).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith('[KnowledgeAgent] Empty text, skipping extraction', { source: 'chat:x' });
  });

  it('提取条目 → safeIngest 按 source/layer 入库 + ChannelMessage + Discord 通知', async () => {
    mockPromptJson.mockResolvedValue({
      entries: [{ type: 'guideline', title: 'G1', content: 'C1', tags: ['g'] }],
    });
    const safeIngest = vi.fn();
    await extractFromText(makeFileStore(), safeIngest, 'some conversation text', 'chat:20260719', 'project');

    expect(mockPromptJson).toHaveBeenCalledWith(
      'some conversation text',
      EXTRACT_FROM_TEXT_SYSTEM_PROMPT,
      { provider: 'knowledge', tier: 'standard' },
    );
    expect(safeIngest).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'guideline', title: 'G1' }),
      expect.objectContaining({ source: 'chat:20260719', layer: 'project', maturity: 'draft' }),
    );
    expect(mockCreateAgentMessage).toHaveBeenCalledTimes(1);
    const [channelId, sender, content, opts] = mockCreateAgentMessage.mock.calls[0];
    expect(channelId).toBe('ch-1');
    expect(sender).toBe('KK');
    expect(content).toContain('提取了 1 条知识');
    expect(opts.meta).toMatchObject({ cardType: 'knowledge_extracted', source: 'chat:20260719', entryCount: 1 });
    expect(mockDiscordSendText).toHaveBeenCalledWith('知识提取完成 (1 条)', expect.stringContaining('chat:20260719'));
  });
});

describe('getOrCreateSystemChannel', () => {
  it('已存在 → 直接复用，不创建', async () => {
    const fileStore = makeFileStore();
    const ch = await getOrCreateSystemChannel(fileStore);
    expect(ch).toEqual({ id: 'ch-1', name: '#系统' });
    expect(fileStore.createChannel).not.toHaveBeenCalled();
  });

  it('缺失 → 创建 #系统 system channel 后返回', async () => {
    const fileStore = makeFileStore({
      listChannels: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'ch-new', name: '#系统' }]),
    });
    const ch = await getOrCreateSystemChannel(fileStore);
    expect(fileStore.createChannel).toHaveBeenCalledTimes(1);
    expect(fileStore.createChannel).toHaveBeenCalledWith(expect.objectContaining({ name: '#系统', type: 'system' }));
    expect(ch).toEqual({ id: 'ch-new', name: '#系统' });
    expect(mockLogger.info).toHaveBeenCalledWith('[KnowledgeAgent] Created #系统 channel', { channelId: 'ch-new' });
  });

  it('listChannels 抛错 → 记 error 并返回 null', async () => {
    const fileStore = makeFileStore({ listChannels: vi.fn().mockRejectedValue(new Error('io')) });
    const ch = await getOrCreateSystemChannel(fileStore);
    expect(ch).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledWith('[KnowledgeAgent] Failed to get/create #系统 channel', expect.anything());
  });
});
