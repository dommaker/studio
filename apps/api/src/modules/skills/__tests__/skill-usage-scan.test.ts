/**
 * skill-usage-scan（skill 度量地基票 B）单测
 *
 * transcript 后验使用扫描：WU done → readTranscript → 扫 rawOutput 中的
 * skills/<name>/SKILL.md 痕迹 → 每 skill 一条 knowledge:skill_used
 * （channel=transcript，level=info signal）。纯确定性零 LLM。
 * eventBus / writeStudioEvent / readTranscript 均 mock，不落盘。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockWriteStudioEvent, mockReadTranscript, mockSubscribe, state } = vi.hoisted(() => ({
  mockWriteStudioEvent: vi.fn().mockResolvedValue(true),
  mockReadTranscript: vi.fn(),
  mockSubscribe: vi.fn(),
  state: { statusChangedHandler: null as null | ((payload: { workunit: unknown }) => void) },
}));

vi.mock('@dommaker/studio-shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@dommaker/studio-shared')>();
  return {
    ...actual,
    writeStudioEvent: mockWriteStudioEvent,
    eventBus: {
      subscribe: (event: string, handler: (payload: { workunit: unknown }) => void) => {
        mockSubscribe(event, handler);
        if (event === 'workunit.status_changed') state.statusChangedHandler = handler;
      },
    },
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
  };
});

vi.mock('../../transcripts/transcript-archive.js', () => ({
  readTranscript: mockReadTranscript,
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

describe('SkillUsageScanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.statusChangedHandler = null;
  });

  it('done WU → 每命中 skill 恰好一条 skill_used（多步读同一 skill 只一条）', async () => {
    mockReadTranscript.mockResolvedValue([
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

  it('transcript 无命中 → 不发射事件', async () => {
    mockReadTranscript.mockResolvedValue([{ workUnitId: 'wu-2', step: 1, rawOutput: '普通输出' }]);
    const scanner = new SkillUsageScanner();
    expect(await scanner.scan({ id: 'wu-2' } as never)).toEqual([]);
    expect(mockWriteStudioEvent).not.toHaveBeenCalled();
  });

  it('transcript 缺失（readTranscript 返回 []）→ 不发射不抛错', async () => {
    mockReadTranscript.mockResolvedValue([]);
    const scanner = new SkillUsageScanner();
    expect(await scanner.scan({ id: 'wu-ghost' } as never)).toEqual([]);
    expect(mockWriteStudioEvent).not.toHaveBeenCalled();
  });

  it('订阅 workunit.status_changed：done 触发扫描，非 done 不触发', async () => {
    mockReadTranscript.mockResolvedValue([
      { workUnitId: 'wu-3', step: 1, rawOutput: 'skills/tdd-implement/SKILL.md' },
    ]);
    const scanner = new SkillUsageScanner();
    scanner.subscribeToEvents();
    expect(state.statusChangedHandler).not.toBeNull();

    state.statusChangedHandler!({ workunit: { id: 'wu-skip', status: 'active' } });
    expect(mockReadTranscript).not.toHaveBeenCalled();

    state.statusChangedHandler!({ workunit: { id: 'wu-3', status: 'done' } });
    await vi.waitFor(() => {
      expect(mockWriteStudioEvent).toHaveBeenCalledWith('knowledge:skill_used',
        expect.objectContaining({ skillName: 'tdd-implement', workUnitId: 'wu-3' }),
        expect.objectContaining({ level: 'info' }));
    });
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
