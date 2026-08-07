/**
 * knowledge-maintenance — F1 每日维护算子单元测试
 *
 * 自足测试（不依赖真实 LLM / 真实 git）：
 * - systemExecutor.runJson mock：控制去重/质量/过期/矛盾判断结果
 * - sharedStore mock（list/get/update）：控制语料条目
 * - child_process.exec mock（自定义 promisify）：控制 validateFreshness 的 git log 输出
 *
 * 覆盖：
 *  - semanticDedup：条目不足早退 / 合并（archive + sourceReferences 转移去重）/ 无重复 / 批次失败容错
 *  - assessQuality：低质量 archive / proven 不动 / 空语料早退
 *  - validateFreshness：无变更早退 / stillValid=false 标 draft / true 不动
 *  - resolveContradictions：按 maturity 保留高者、低者标 draft
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  mockRunJson, mockLogger, mockStoreList, mockStoreGet, mockStoreUpdate, mockGitLog,
} = vi.hoisted(() => ({
  mockRunJson: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  mockStoreList: vi.fn(() => [] as any[]),
  mockStoreGet: vi.fn(),
  mockStoreUpdate: vi.fn(),
  mockGitLog: { stdout: '' as string | Error },
}));

vi.mock('@dommaker/studio-shared', () => ({
  logger: mockLogger,
}));

vi.mock('../system-executor.js', () => ({
  getSystemExecutor: () => ({ runJson: mockRunJson }),
}));

vi.mock('../../knowledge/knowledge-bus.service.js', () => ({
  sharedStore: { list: mockStoreList, get: mockStoreGet, update: mockStoreUpdate },
}));

vi.mock('child_process', () => {
  const execFn: any = (_cmd: string, _opts: any, cb: any) => {
    if (mockGitLog.stdout instanceof Error) cb(mockGitLog.stdout);
    else cb(null, mockGitLog.stdout, '');
  };
  execFn[Symbol.for('nodejs.util.promisify.custom')] = (_cmd: string, _opts: any) =>
    mockGitLog.stdout instanceof Error
      ? Promise.reject(mockGitLog.stdout)
      : Promise.resolve({ stdout: mockGitLog.stdout, stderr: '' });
  return { exec: execFn };
});

import { semanticDedup, assessQuality, validateFreshness, resolveContradictions } from '../knowledge/knowledge-maintenance.js';

function entry(id: string, over: Record<string, any> = {}): any {
  return {
    id,
    type: 'pitfall',
    title: `title-${id}`,
    content: `content-${id}`,
    tags: ['t1'],
    maturity: 'draft',
    sourceReferences: [],
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStoreList.mockReturnValue([]);
  mockGitLog.stdout = '';
});

describe('semanticDedup (F1a)', () => {
  it('条目 < 2 → 0，不调 LLM', async () => {
    mockStoreList.mockReturnValue([entry('a')]);
    expect(await semanticDedup()).toBe(0);
    expect(mockRunJson).not.toHaveBeenCalled();
  });

  it('LLM 判定重复 → archive 重复项并把 sourceReferences 去重转移到保留项', async () => {
    mockStoreList.mockReturnValue([entry('a'), entry('b')]);
    mockStoreGet.mockImplementation((id: string) =>
      id === 'a'
        ? entry('a', { sourceReferences: [{ workflow: 'w1', timestamp: '1' }] })
        : entry('b', { sourceReferences: [{ workflow: 'w1', timestamp: '1' }, { workflow: 'w2', timestamp: '2' }] }));
    mockRunJson.mockResolvedValue({ duplicates: [{ keep: 'a', merge: ['b'], reason: '同一问题' }] });

    expect(await semanticDedup()).toBe(1);
    expect(mockStoreUpdate).toHaveBeenCalledWith('b', { maturity: 'archived' });
    expect(mockStoreUpdate).toHaveBeenCalledWith('a', {
      sourceReferences: [{ workflow: 'w1', timestamp: '1' }, { workflow: 'w2', timestamp: '2' }],
    });
    expect(mockLogger.info).toHaveBeenCalledWith('[KnowledgeCurator] Semantic dedup merged', {
      keep: 'a', archived: 'b', reason: '同一问题',
    });
  });

  it('无重复 → 0 且不更新', async () => {
    mockStoreList.mockReturnValue([entry('a'), entry('b')]);
    mockRunJson.mockResolvedValue({ duplicates: [] });
    expect(await semanticDedup()).toBe(0);
    expect(mockStoreUpdate).not.toHaveBeenCalled();
  });

  it('LLM 批次失败 → warn 容错，返回 0', async () => {
    mockStoreList.mockReturnValue([entry('a'), entry('b')]);
    mockRunJson.mockRejectedValue(new Error('down'));
    expect(await semanticDedup()).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith('[KnowledgeCurator] Semantic dedup batch failed', expect.objectContaining({ type: 'pitfall' }));
  });
});

describe('assessQuality (F1b)', () => {
  it('空语料 → 0，不调 LLM', async () => {
    expect(await assessQuality()).toBe(0);
    expect(mockRunJson).not.toHaveBeenCalled();
  });

  it('keep=false 且非 proven → archive；proven 保留不动', async () => {
    mockStoreList.mockReturnValue([entry('x'), entry('y', { maturity: 'proven' })]);
    mockStoreGet.mockImplementation((id: string) =>
      id === 'x' ? entry('x') : entry('y', { maturity: 'proven' }));
    mockRunJson.mockResolvedValue({
      assessments: [
        { id: 'x', keep: false, reason: '泛泛而谈', score: 2 },
        { id: 'y', keep: false, reason: '低质', score: 1 },
      ],
    });

    expect(await assessQuality()).toBe(1);
    expect(mockStoreUpdate).toHaveBeenCalledTimes(1);
    expect(mockStoreUpdate).toHaveBeenCalledWith('x', { maturity: 'archived' });
  });

  it('全部 keep → 0', async () => {
    mockStoreList.mockReturnValue([entry('x')]);
    mockRunJson.mockResolvedValue({ assessments: [{ id: 'x', keep: true, reason: '有价值', score: 9 }] });
    expect(await assessQuality()).toBe(0);
    expect(mockStoreUpdate).not.toHaveBeenCalled();
  });
});

describe('validateFreshness (F1c)', () => {
  it('近 7 天无 git 变更 → 0 早退，不调 LLM', async () => {
    mockGitLog.stdout = '';
    expect(await validateFreshness()).toBe(0);
    expect(mockRunJson).not.toHaveBeenCalled();
  });

  it('条目内容命中变更文件且 stillValid=false → 标 draft', async () => {
    mockGitLog.stdout = 'apps/api/src/foo-service.ts\n';
    mockStoreList.mockReturnValue([
      entry('s1', { title: 'foo-service 的重试逻辑', content: 'foo-service 使用指数退避' }),
      entry('s2', { title: '无关条目', content: '完全无关的内容' }),
    ]);
    mockRunJson.mockResolvedValue({
      results: [
        { id: 's1', stillValid: false, reason: '代码已重写' },
      ],
    });

    expect(await validateFreshness()).toBe(1);
    expect(mockStoreUpdate).toHaveBeenCalledWith('s1', { maturity: 'draft' });
    // s2 未命中变更文件 → 不进入 LLM 批次
    const prompt = mockRunJson.mock.calls[0][0] as string;
    expect(prompt).toContain('s1');
    expect(prompt).not.toContain('s2');
  });

  it('stillValid=true → 不更新', async () => {
    mockGitLog.stdout = 'foo.ts\n';
    mockStoreList.mockReturnValue([entry('s1', { title: 'foo 说明', content: 'foo 行为' })]);
    mockRunJson.mockResolvedValue({ results: [{ id: 's1', stillValid: true, reason: '仍正确' }] });
    expect(await validateFreshness()).toBe(0);
    expect(mockStoreUpdate).not.toHaveBeenCalled();
  });

  it('git 命令失败 → warn 容错返回 0', async () => {
    mockGitLog.stdout = new Error('not a git repo');
    expect(await validateFreshness()).toBe(0);
    expect(mockLogger.warn).toHaveBeenCalledWith('[KnowledgeCurator] Freshness validation failed', expect.objectContaining({}));
  });
});

describe('resolveContradictions (F1d)', () => {
  it('矛盾组按 maturity 排序，低成熟度标 draft，保留高者', async () => {
    mockStoreList.mockReturnValue([
      entry('a', { maturity: 'proven', tags: ['cache'] }),
      entry('b', { maturity: 'draft', tags: ['cache'] }),
    ]);
    mockStoreGet.mockImplementation((id: string) =>
      id === 'a' ? entry('a', { maturity: 'proven', tags: ['cache'] }) : entry('b', { maturity: 'draft', tags: ['cache'] }));
    mockRunJson.mockResolvedValue({
      contradictions: [{ entries: ['a', 'b'], description: '缓存策略相反', resolution: '保留 a' }],
    });

    expect(await resolveContradictions()).toBe(1);
    expect(mockStoreUpdate).toHaveBeenCalledTimes(1);
    expect(mockStoreUpdate).toHaveBeenCalledWith('b', { maturity: 'draft' });
    expect(mockLogger.info).toHaveBeenCalledWith('[KnowledgeCurator] Contradiction detected', expect.objectContaining({ tag: 'cache' }));
  });

  it('无矛盾 → 0；无共同 tag 的分组 → 不调 LLM', async () => {
    mockStoreList.mockReturnValue([entry('a', { tags: ['x'] }), entry('b', { tags: ['y'] })]);
    expect(await resolveContradictions()).toBe(0);
    expect(mockRunJson).not.toHaveBeenCalled();
  });
});
