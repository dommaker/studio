/**
 * transcript-archive (#97) — transcript 归档器接口级测试
 *
 * 覆盖：路径隔离、按 WU 归档、sessionId、原文完整保留，以及 #712 的 Assignment
 * committed prefix、contentId/terminal、独立 consumer watermark、失败重试与对账恢复。
 * 通过模块公共接口验证，不测 FileStore 内部实现。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isTestEnv,
  transcriptsDir,
  transcriptPath,
  appendTranscriptStep,
  consumeTranscript,
  finalizeTranscriptAssignment,
  readTranscript,
  reconcileTranscriptAssignments,
} from '../transcript-archive.js';

describe('isTestEnv', () => {
  it('VITEST 存在 → true', () => {
    expect(isTestEnv({ VITEST: 'true' })).toBe(true);
    expect(isTestEnv({ VITEST: '1' })).toBe(true);
  });

  it('NODE_ENV=test → true', () => {
    expect(isTestEnv({ NODE_ENV: 'test' })).toBe(true);
  });

  it('两者都无 → false（生产）', () => {
    expect(isTestEnv({})).toBe(false);
    expect(isTestEnv({ NODE_ENV: 'production' })).toBe(false);
    expect(isTestEnv({ NODE_ENV: 'development' })).toBe(false);
  });
});

describe('transcriptsDir / transcriptPath', () => {
  // studioPath() 读 process.env.STUDIO_HOME（调用时惰性），故经 process.env 注入验证
  const withHome = (home: string | undefined, fn: () => void): void => {
    const prev = process.env.STUDIO_HOME;
    if (home === undefined) delete process.env.STUDIO_HOME;
    else process.env.STUDIO_HOME = home;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env.STUDIO_HOME;
      else process.env.STUDIO_HOME = prev;
    }
  };

  it('生产路径经 studioPath()（STUDIO_HOME/transcripts/<workUnitId>.jsonl）', () => {
    withHome('/tmp/fake-studio-home', () => {
      expect(transcriptsDir({})).toBe(path.join('/tmp/fake-studio-home', 'transcripts'));
      expect(transcriptPath('wu-1', {})).toBe(path.join('/tmp/fake-studio-home', 'transcripts', 'wu-1.jsonl'));
    });
  });

  it('缺省 env → ~/.studio/transcripts（os.homedir 回退，不硬编码字面量）', () => {
    withHome(undefined, () => {
      expect(transcriptsDir({})).toBe(path.join(os.homedir(), '.studio', 'transcripts'));
    });
  });

  it('dev/prod 不混：不同 STUDIO_HOME 下同 workUnitId 路径隔离', () => {
    let dev = '';
    let prod = '';
    withHome('/tmp/dev-home', () => { dev = transcriptPath('wu-1', {}); });
    withHome('/tmp/prod-home', () => { prod = transcriptPath('wu-1', {}); });
    expect(dev).not.toBe(prod);
    expect(dev).toBe(path.join('/tmp/dev-home', 'transcripts', 'wu-1.jsonl'));
  });

  it('测试环境 → os.tmpdir()/studio-test-transcripts/<per-进程子目录>（隔离，不写生产路径）', () => {
    expect(transcriptPath('wu-1', { VITEST: 'true' }))
      .toBe(path.join(transcriptsDir({ VITEST: 'true' }), 'wu-1.jsonl'));
    expect(transcriptPath('wu-1', { NODE_ENV: 'test' }))
      .toBe(path.join(transcriptsDir({ NODE_ENV: 'test' }), 'wu-1.jsonl'));
    // per-进程子目录挂在约定根下（#135），不同进程互不相同
    expect(transcriptsDir({ VITEST: 'true' }).startsWith(path.join(os.tmpdir(), 'studio-test-transcripts'))).toBe(true);
  });
});

describe('appendTranscriptStep + readTranscript', () => {
  // 默认 env（vitest 进程 VITEST 已设置）→ 写到隔离目录；用唯一 id 防跨用例碰撞
  const wuId = `wu-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  afterEach(() => {
    fs.rmSync(transcriptPath(wuId), { force: true });
  });

  it('按 workUnitId 归档与读取（多步追加、字段完整、原文不截断）', async () => {
    await appendTranscriptStep({
      workUnitId: wuId,
      sessionId: 'sess-a',
      step: 1,
      action: 'progress',
      rawOutput: '{"type":"assistant","message":{"content":[{"type":"text","text":"thinking"}]}}\n',
    });
    await appendTranscriptStep({
      workUnitId: wuId,
      sessionId: 'sess-a',
      step: 2,
      action: 'complete',
      rawOutput: '{"type":"result","result":"DONE"}\n',
    });

    const entries = await readTranscript(wuId);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      workUnitId: wuId,
      sessionId: 'sess-a',
      step: 1,
      action: 'progress',
    });
    expect(entries[1]).toMatchObject({
      workUnitId: wuId,
      sessionId: 'sess-a',
      step: 2,
      action: 'complete',
    });
    expect(typeof entries[0].createdAt).toBe('string');
    // 原文完整保留（非摘要截断）：提取要全文、质量评估要执行痕迹
    expect(entries[0].rawOutput).toContain('thinking');
    expect(entries[1].rawOutput).toContain('DONE');
  });

  it('文件不存在 → 返回 []（不抛出）', async () => {
    await expect(readTranscript('nope-no-such-wu')).resolves.toEqual([]);
  });

  it('按会话（sessionId）定位：entries 随行携带 sessionId，可过滤', async () => {
    await appendTranscriptStep({ workUnitId: wuId, sessionId: 'sess-x', step: 1, action: 'progress', rawOutput: 'a' });
    await appendTranscriptStep({ workUnitId: wuId, sessionId: 'sess-y', step: 2, action: 'complete', rawOutput: 'b' });

    const entries = await readTranscript(wuId);
    const sessX = entries.filter(e => e.sessionId === 'sess-x');
    expect(sessX).toHaveLength(1);
    expect(sessX[0]).toMatchObject({ step: 1, rawOutput: 'a' });
    const sessY = entries.filter(e => e.sessionId === 'sess-y');
    expect(sessY).toHaveLength(1);
    expect(sessY[0]).toMatchObject({ step: 2, rawOutput: 'b' });
  });

  it('不同 workUnitId 归档文件互相隔离', async () => {
    const wuB = `${wuId}-b`;
    try {
      await appendTranscriptStep({ workUnitId: wuId, sessionId: 's1', step: 1, action: 'progress', rawOutput: 'A' });
      await appendTranscriptStep({ workUnitId: wuB, sessionId: 's1', step: 1, action: 'progress', rawOutput: 'B' });

      expect(await readTranscript(wuId)).toHaveLength(1);
      expect(await readTranscript(wuB)).toHaveLength(1);
      expect((await readTranscript(wuId))[0].rawOutput).toBe('A');
      expect((await readTranscript(wuB))[0].rawOutput).toBe('B');
    } finally {
      fs.rmSync(transcriptPath(wuB), { force: true });
    }
  });

  it('Assignment 仅提交带成功或等待终止标记的完整前缀，失败与写入中内容不可见', async () => {
    const first = await appendTranscriptStep({
      workUnitId: wuId, assignmentId: 'assignment-success', step: 1, action: 'complete', rawOutput: 'committed',
    });
    await appendTranscriptStep({
      workUnitId: wuId, assignmentId: 'assignment-failed', step: 2, action: 'failed', rawOutput: 'failed-output',
    });
    await appendTranscriptStep({
      workUnitId: wuId, assignmentId: 'assignment-waiting', step: 3, action: 'need_input', rawOutput: 'waiting-output',
    });

    expect(await readTranscript(wuId)).toEqual([]);
    expect(first.contentId).toMatch(/^[a-f0-9]{64}$/);

    await finalizeTranscriptAssignment({ workUnitId: wuId, assignmentId: 'assignment-failed', status: 'failed' });
    await finalizeTranscriptAssignment({ workUnitId: wuId, assignmentId: 'assignment-success', status: 'succeeded' });
    await finalizeTranscriptAssignment({ workUnitId: wuId, assignmentId: 'assignment-waiting', status: 'waiting' });

    const entries = await readTranscript(wuId);
    expect(entries.map(entry => entry.rawOutput)).toEqual(['committed', undefined, 'waiting-output', undefined]);
    expect(entries.map(entry => entry.kind ?? 'step')).toEqual(['step', 'terminal', 'step', 'terminal']);
    expect(entries.map(entry => entry.step)).toEqual([1, 1, 3, 3]);
    expect(entries[1]).toMatchObject({ assignmentId: 'assignment-success', status: 'succeeded' });
    expect(entries[3]).toMatchObject({ assignmentId: 'assignment-waiting', status: 'waiting' });
    expect(JSON.stringify(entries)).not.toContain('failed-output');
  });

  it('每类 consumer 独立续读，处理失败不推进水位', async () => {
    await appendTranscriptStep({ workUnitId: wuId, assignmentId: 'a1', step: 1, rawOutput: 'one' });
    await finalizeTranscriptAssignment({ workUnitId: wuId, assignmentId: 'a1', status: 'succeeded' });

    const outputs = (result: { value: string[] }) => result.value;
    expect(outputs(await consumeTranscript(wuId, 'role-memory', async entries =>
      entries.filter(entry => entry.rawOutput).map(entry => entry.rawOutput!)))).toEqual(['one']);
    expect(outputs(await consumeTranscript(wuId, 'role-memory', async entries =>
      entries.map(entry => entry.rawOutput ?? 'terminal')))).toEqual([]);
    expect(outputs(await consumeTranscript(wuId, 'skill-usage', async entries =>
      entries.filter(entry => entry.rawOutput).map(entry => entry.rawOutput!)))).toEqual(['one']);

    await expect(consumeTranscript(wuId, 'recovery', async () => {
      throw new Error('consumer failed');
    })).rejects.toThrow('consumer failed');
    expect(outputs(await consumeTranscript(wuId, 'recovery', async entries =>
      entries.filter(entry => entry.rawOutput).map(entry => entry.rawOutput!)))).toEqual(['one']);

    await appendTranscriptStep({ workUnitId: wuId, assignmentId: 'a1', step: 2, rawOutput: 'two' });
    await finalizeTranscriptAssignment({ workUnitId: wuId, assignmentId: 'a1', status: 'succeeded' });
    expect(outputs(await consumeTranscript(wuId, 'role-memory', async entries =>
      entries.filter(entry => entry.rawOutput).map(entry => entry.rawOutput!)))).toEqual(['two']);
  });

  it('按 Assignment 对账补终止标记，步骤缺失标失败且后续重试可独立提交', async () => {
    await appendTranscriptStep({ workUnitId: wuId, assignmentId: 'complete-a', step: 1, rawOutput: 'complete-output' });
    await appendTranscriptStep({ workUnitId: wuId, assignmentId: 'incomplete-a', step: 2, rawOutput: 'partial-output' });

    await reconcileTranscriptAssignments({
      id: wuId,
      assignments: [
        { id: 'complete-a', status: 'succeeded', transcriptCount: 1 },
        { id: 'incomplete-a', status: 'succeeded', transcriptCount: 2 },
      ],
      stepRecords: [{
        assignmentId: 'incomplete-a',
        transcriptRefs: [`${transcriptPath(wuId)}#step=2`, `${transcriptPath(wuId)}#step=3`],
      }],
    });

    const committed = await readTranscript(wuId);
    expect(committed.filter(entry => entry.rawOutput).map(entry => entry.rawOutput)).toEqual(['complete-output']);
    expect(JSON.stringify(committed)).not.toContain('partial-output');
    const consumption = await consumeTranscript(wuId, 'recovery', async entries => entries);
    expect(consumption.hasUncommitted).toBe(true);

    await appendTranscriptStep({ workUnitId: wuId, assignmentId: 'retry-a', step: 4, rawOutput: 'retry-output' });
    await reconcileTranscriptAssignments({
      id: wuId,
      assignments: [{ id: 'retry-a', status: 'succeeded', transcriptCount: 1 }],
      stepRecords: [],
    });
    expect((await readTranscript(wuId)).filter(entry => entry.rawOutput).map(entry => entry.rawOutput))
      .toEqual(['complete-output', 'retry-output']);
  });

  it('旧无 kind 的 Assignment 步骤按实际数量对账，不误判为写入失败', async () => {
    const archive = transcriptPath(wuId);
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.writeFileSync(archive, [1, 2].map(step => JSON.stringify({
      workUnitId: wuId,
      assignmentId: 'legacy-a',
      step,
      action: step === 2 ? 'complete' : 'progress',
      rawOutput: `legacy-output-${step}`,
      createdAt: '2026-11-01T00:00:00.000Z',
    })).join('\n') + '\n');

    await reconcileTranscriptAssignments({
      id: wuId,
      assignments: [{ id: 'legacy-a', status: 'succeeded', transcriptCount: 2 }],
      stepRecords: [{ assignmentId: 'legacy-a', transcriptRefs: [`${transcriptPath(wuId)}#step=1`, `${transcriptPath(wuId)}#step=2`] }],
    });
    const entries = await readTranscript(wuId);
    expect(entries[0].rawOutput).toBe('legacy-output-1');
    expect(entries.at(-1)).toMatchObject({ assignmentId: 'legacy-a', kind: 'terminal', status: 'succeeded', step: 2 });
  });

  it('归档写失败可重试，不会被当作已完成空记录', async () => {
    const archive = transcriptPath(wuId);
    fs.mkdirSync(path.dirname(archive), { recursive: true });
    fs.mkdirSync(archive);
    try {
      await expect(appendTranscriptStep({ workUnitId: wuId, assignmentId: 'a1', step: 1, rawOutput: 'retry-me' }))
        .rejects.toThrow();
      await expect(readTranscript(wuId)).rejects.toThrow();
    } finally {
      fs.rmSync(archive, { recursive: true, force: true });
    }

    await appendTranscriptStep({ workUnitId: wuId, assignmentId: 'a1', step: 1, rawOutput: 'retry-me' });
    await finalizeTranscriptAssignment({ workUnitId: wuId, assignmentId: 'a1', status: 'succeeded' });
    expect((await readTranscript(wuId))[0].rawOutput).toBe('retry-me');
  });
});
