import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore, WorkUnitMetadataRepository } from '@dommaker/studio-shared';
import { ExecutionJournal } from '../execution-journal.js';
import { loadRecoveryPacket } from '../recovery.js';
import { parseWuMetadata } from '../wu-metadata.js';
import { WorkUnitService } from '../workunit-review.js';
import { appendTranscriptStep, transcriptPath } from '../../transcripts/index.js';

let tmpDir: string;
let repo: string;
let store: FileStore;
let service: WorkUnitService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'step-recovery-'));
  repo = path.join(tmpDir, 'repo');
  fs.mkdirSync(repo);
  git(['init', '-b', 'main']);
  git(['config', 'user.email', 'test@example.invalid']);
  git(['config', 'user.name', 'Test']);
  fs.writeFileSync(path.join(repo, 'README.md'), 'initial\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'initial']);
  store = new FileStore(path.join(tmpDir, 'data'));
  service = new WorkUnitService(store);
});

afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
}

describe('#711 StepRecord 与恢复包', () => {
  it('逐步持久化完整记录，并从结构化事实和实时 Git 构建恢复包', async () => {
    const created = await service.create({
      scope: '实现可恢复执行', type: 'task', status: 'unassigned',
      metadata: {
        ac: ['记录步骤', '恢复真实状态'],
        worktreePath: repo,
        waitingForInput: true,
        waitingQuestion: '是否保留兼容回退？',
        sessionSummary: '旧摘要声称已经完成',
      },
    });
    const claimed = await service.claim(created.id, 'instance-1');
    const assignmentId = claimed.execution!.current!.id;
    const journal = new ExecutionJournal(new WorkUnitMetadataRepository(store));
    const runningSnapshot = await journal.beginStep({ wu: claimed, provider: 'claude' });
    const running = await service.getById(created.id);

    await journal.recordStepResult({
      wu: running!,
      metadata: parseWuMetadata(running!.metadata),
      action: 'progress',
      result: {
        action: 'progress', assignmentId, summary: '完成记录模型',
        transcriptRecorded: true,
        stepRecord: {
          acProgress: [
            { ac: '记录步骤', status: 'completed' },
            { ac: '恢复真实状态', status: 'in_progress', note: '待接 prompt' },
          ],
          modifiedFiles: ['packages/studio-shared/src/file-store/file-store-types.ts'],
          commands: [{ command: 'pnpm vitest run recovery.test.ts', status: 'passed' }],
          verification: {
            status: 'passed', commands: ['pnpm typecheck'], at: '2026-11-15T00:00:00.000Z',
          },
          decisions: ['恢复时重读 Git'],
          artifacts: ['docs/plans/2026-11-711-step-recovery.md'],
          nextStep: '接入新会话 prompt',
          transcriptRefs: ['transcripts/wu-1.jsonl#step=1'],
        },
      },
      guardUpdates: {}, freshnessUpdates: {},
      bookkeeping: { stepCount: 1, consecutiveStuck: 0, waitingUpdates: {}, blockReasonUpdates: {} },
    });

    const snapshot = (await store.getIndex({ id: created.id }))[0];
    expect(runningSnapshot).not.toBeNull();
    expect(snapshot.stepRecords).toHaveLength(1);
    expect(snapshot.stepRecords![0]).toMatchObject({
      assignmentId,
      workUnitId: created.id,
      step: 1,
      action: 'progress',
      result: '完成记录模型',
      nextStep: '接入新会话 prompt',
      modifiedFiles: ['packages/studio-shared/src/file-store/file-store-types.ts'],
      transcriptRefs: ['transcripts/wu-1.jsonl#step=1'],
    });
    await store.rebuildIndex();
    expect((await store.getIndex({ id: created.id }))[0].stepRecords).toEqual(snapshot.stepRecords);

    const packet = await loadRecoveryPacket(store, (await service.getById(created.id))!);
    expect(packet).toMatchObject({
      workUnitId: created.id,
      assignmentId,
      mandate: { workUnitId: created.id },
      acceptanceCriteria: [
        { ac: '记录步骤', status: 'completed' },
        { ac: '恢复真实状态', status: 'in_progress', note: '待接 prompt' },
      ],
      confirmedDecisions: ['恢复时重读 Git'],
      unfinishedItems: ['恢复真实状态', '接入新会话 prompt'],
      recentVerification: { status: 'passed', commands: ['pnpm typecheck'] },
      openQuestions: ['是否保留兼容回退？'],
      transcriptRefs: ['transcripts/wu-1.jsonl#step=1'],
      repository: { root: repo, branch: 'main', commit: git(['rev-parse', 'HEAD']), dirty: false },
    });
    expect(JSON.stringify(packet)).not.toContain('旧摘要声称已经完成');

    fs.writeFileSync(path.join(repo, 'next.txt'), 'next\n');
    git(['add', 'next.txt']);
    git(['commit', '-m', 'advance head']);
    const reloaded = await loadRecoveryPacket(store, (await service.getById(created.id))!);
    expect(reloaded!.repository!.commit).toBe(git(['rev-parse', 'HEAD']));
    expect(reloaded!.repository!.commit).not.toBe(packet!.repository!.commit);
  });

  it('Git 读取失败保留未知状态，不回退到旧分支或摘要', async () => {
    const created = await service.create({
      scope: '仓库已不可用', type: 'task', status: 'unassigned',
      metadata: { worktreePath: path.join(tmpDir, 'missing'), sessionSummary: 'main@deadbeef' },
    });
    const packet = await loadRecoveryPacket(store, created);
    expect(packet!.repository).toMatchObject({
      root: path.join(tmpDir, 'missing'), branch: null, commit: null, dirty: null,
    });
    expect(JSON.stringify(packet)).not.toContain('deadbeef');
  });

  it('恢复包只保留已提交 transcript 引用，Assignment 终止后可重读', async () => {
    const created = await service.create({ scope: '恢复原文', type: 'task', status: 'unassigned' });
    const claimed = await service.claim(created.id, 'instance-1');
    const assignmentId = claimed.execution!.current!.id;
    const journal = new ExecutionJournal(new WorkUnitMetadataRepository(store));
    await journal.beginStep({ wu: claimed, provider: 'claude' });
    const ref = `${transcriptPath(created.id)}#step=1`;
    try {
      await journal.recordStepResult({
        wu: claimed, metadata: parseWuMetadata(claimed.metadata), action: 'progress',
        result: {
          action: 'progress', assignmentId, summary: '留下原文',
          transcriptRecorded: true, stepRecord: { transcriptRefs: [ref] },
        },
        guardUpdates: {}, freshnessUpdates: {},
        bookkeeping: { stepCount: 1, consecutiveStuck: 0, waitingUpdates: {}, blockReasonUpdates: {} },
      });
      await appendTranscriptStep({
        workUnitId: created.id, assignmentId, step: 1, action: 'progress', rawOutput: 'committed later',
      });

      const writing = await loadRecoveryPacket(store, (await service.getById(created.id))!);
      expect(writing!.transcriptRefs).toEqual([]);

      const running = (await service.getById(created.id))!;
      await journal.recordStepResult({
        wu: running, metadata: parseWuMetadata(running.metadata), action: 'need_input',
        result: { action: 'need_input', assignmentId, summary: '等待回复' },
        guardUpdates: {}, freshnessUpdates: {},
        bookkeeping: { stepCount: 2, consecutiveStuck: 1, waitingUpdates: {}, blockReasonUpdates: {} },
      });
      const committed = await loadRecoveryPacket(store, (await service.getById(created.id))!);
      expect(committed!.transcriptRefs).toEqual([ref]);
    } finally {
      fs.rmSync(transcriptPath(created.id), { force: true });
    }
  });
});
