/**
 * skill-usage-scan（skill 度量地基票 B）单测
 *
 * transcript 后验使用扫描：WU done → skill-usage committed 增量 → 扫 rawOutput 中的
 * skills/<name>/SKILL.md 痕迹 → 每 skill 一条 knowledge:skill_used
 * （channel=transcript，level=info signal）。纯确定性零 LLM。
 * eventBus / writeStudioEvent / consumeTranscript 均 mock，不落盘。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockWriteStudioEvent, mockReadTranscript, mockConsumeTranscript, mockReconcile, mockSubscribe, state } = vi.hoisted(() => ({
  mockWriteStudioEvent: vi.fn().mockResolvedValue(true),
  mockReadTranscript: vi.fn(),
  mockConsumeTranscript: vi.fn(),
  mockReconcile: vi.fn().mockResolvedValue(undefined),
  mockSubscribe: vi.fn(),
  state: { statusChangedHandler: null as null | ((payload: { workunit: unknown; previousStatus?: string }) => void) },
}));

vi.mock('@dommaker/studio-shared/node', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared/node')>();
  return { ...actual, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } };
});

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    writeStudioEvent: mockWriteStudioEvent,
    eventBus: {
      subscribe: (event: string, handler: (payload: { workunit: unknown; previousStatus?: string }) => void) => {
        mockSubscribe(event, handler);
        if (event === 'workunit.status_changed') state.statusChangedHandler = handler;
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('../../transcripts/transcript-archive.js', () => ({
  readTranscript: mockReadTranscript,
  consumeTranscript: mockConsumeTranscript,
  reconcileTranscriptAssignments: mockReconcile,
}));

import { SkillUsageScanner, extractUsedSkillNames, initSkillUsageScan } from '../skill-usage-scan.js';

describe('extractUsedSkillNames', () => {
  it('命中绝对/相对路径，按 skill 名去重', () => {
    const text = [
      'Read /root/.studio/skills/code-review/SKILL.md 成功',
      'cat ~/.studio/skills/code-review/SKILL.md',
      '见 skills/tdd-implement/SKILL.md 全文',
    ].join('\n');
    expect(extractUsedSkillNames(text)).toEqual(['code-review', 'tdd-implement']);
  });

  it('无命中 → 空数组', () => {
    expect(extractUsedSkillNames('读取了 src/index.ts 和 README.md')).toEqual([]);
  });

  it('_ 前缀目录（_deprecated 等）不计入', () => {
    expect(extractUsedSkillNames('skills/_deprecated/old-skill/SKILL.md')).toEqual([]);
  });
});

function mockCommitted(entries: Array<Record<string, unknown>>): void {
  mockConsumeTranscript.mockImplementation(async (_wuId, _consumer, consume) => ({
    value: await consume(entries),
    consumed: entries.length,
    hasUncommitted: false,
  }));
}

describe('SkillUsageScanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCommitted([]);
    mockWriteStudioEvent.mockResolvedValue(true);
    state.statusChangedHandler = null;
  });

  it('done WU → 每命中 skill 恰好一条 skill_used（多步读同一 skill 只一条）', async () => {
    mockCommitted([
      { workUnitId: 'wu-1', step: 1, rawOutput: '读取 skills/code-review/SKILL.md' },
      { workUnitId: 'wu-1', step: 2, rawOutput: '再次引用 /root/.studio/skills/code-review/SKILL.md 和 skills/research/SKILL.md' },
    ]);
    const scanner = new SkillUsageScanner();
    const used = await scanner.scan({ id: 'wu-1' } as never);
    expect(used).toEqual(['code-review', 'research']);
    expect(mockWriteStudioEvent).toHaveBeenCalledTimes(2);
    expect(mockWriteStudioEvent).toHaveBeenCalledWith('knowledge:skill_used', {
      skillName: 'code-review', workUnitId: 'wu-1', channel: 'transcript',
    }, { source: 'skill-usage-scan', level: 'info' });
  });

  it('经 skill-usage 独立水位读取，事件写失败保持可重试', async () => {
    mockConsumeTranscript.mockImplementation(async (_wuId, consumer, consume) => ({
      value: await consume([{ workUnitId: 'wu-watermark', step: 1, rawOutput: 'skills/code-review/SKILL.md' }]),
      consumed: 1,
      hasUncommitted: false,
    }));
    mockWriteStudioEvent.mockResolvedValueOnce(false);
    const scanner = new SkillUsageScanner();

    await expect(scanner.scan({ id: 'wu-watermark' } as never)).rejects.toThrow('skill_used write failed');
    expect(mockConsumeTranscript).toHaveBeenCalledWith('wu-watermark', 'skill-usage', expect.any(Function));
  });

  it('transcript 无命中 → 不发射事件', async () => {
    mockCommitted([{ workUnitId: 'wu-2', step: 1, rawOutput: '普通输出' }]);
    const scanner = new SkillUsageScanner();
    expect(await scanner.scan({ id: 'wu-2' } as never)).toEqual([]);
    expect(mockWriteStudioEvent).not.toHaveBeenCalled();
  });

  it('transcript 缺失（readTranscript 返回 []）→ 不发射不抛错', async () => {
    mockCommitted([]);
    const scanner = new SkillUsageScanner();
    expect(await scanner.scan({ id: 'wu-ghost' } as never)).toEqual([]);
    expect(mockWriteStudioEvent).not.toHaveBeenCalled();
  });

  it('订阅 workunit.status_changed：done 触发扫描，非 done 不触发', async () => {
    mockCommitted([
      { workUnitId: 'wu-3', step: 1, rawOutput: 'skills/tdd-implement/SKILL.md' },
    ]);
    const scanner = new SkillUsageScanner();
    scanner.subscribeToEvents();
    expect(state.statusChangedHandler).not.toBeNull();

    state.statusChangedHandler!({ workunit: { id: 'wu-skip', status: 'active' } });
    expect(mockConsumeTranscript).not.toHaveBeenCalled();

    state.statusChangedHandler!({ workunit: { id: 'wu-evidence', status: 'done' }, previousStatus: 'done' });
    expect(mockConsumeTranscript).not.toHaveBeenCalled();

    state.statusChangedHandler!({ workunit: { id: 'wu-3', status: 'done' }, previousStatus: 'in_review' });
    await vi.waitFor(() => {
      expect(mockWriteStudioEvent).toHaveBeenCalledWith('knowledge:skill_used',
        expect.objectContaining({ skillName: 'tdd-implement', workUnitId: 'wu-3' }),
        expect.objectContaining({ level: 'info' }));
    });
  });

  it('启动续扫只恢复 done WU 的未消费内容', async () => {
    mockCommitted([{ workUnitId: 'wu-done', step: 1, rawOutput: 'skills/research/SKILL.md' }]);
    const fileStore = {
      listCurrentSnapshots: vi.fn().mockResolvedValue([{ id: 'wu-done', status: 'done' }, { id: 'wu-active', status: 'active' }]),
      getIndex: vi.fn().mockResolvedValue([]),
    };
    const scanner = new SkillUsageScanner(fileStore as never);

    await scanner.recoverPending();
    expect(mockConsumeTranscript).toHaveBeenCalledTimes(1);
    expect(mockConsumeTranscript).toHaveBeenCalledWith('wu-done', 'skill-usage', expect.any(Function));
    expect(mockWriteStudioEvent).toHaveBeenCalledWith('knowledge:skill_used',
      expect.objectContaining({ skillName: 'research', workUnitId: 'wu-done' }),
      expect.objectContaining({ level: 'info' }));
  });

  it('subscribeToEvents 幂等（重复订阅只挂一次）', () => {
    const scanner = new SkillUsageScanner();
    scanner.subscribeToEvents();
    const first = state.statusChangedHandler;
    scanner.subscribeToEvents();
    expect(state.statusChangedHandler).toBe(first);
  });

  it('initSkillUsageScan 返回单例并完成订阅', () => {
    const a = initSkillUsageScan();
    const b = initSkillUsageScan();
    expect(a).toBe(b);
    expect(state.statusChangedHandler).not.toBeNull();
  });
});
