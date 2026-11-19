import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore, WorkUnitMetadataRepository } from '@dommaker/studio-shared';
import { WorkUnitService } from '../../workunit/index.js';
import { appendTranscriptStep, finalizeTranscriptAssignment, transcriptPath } from '../../transcripts/index.js';

const { mockExtractFromConversation, mockReconcileCompleted } = vi.hoisted(() => ({
  mockExtractFromConversation: vi.fn().mockResolvedValue(undefined),
  mockReconcileCompleted: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../knowledge-service', () => ({
  knowledgePorts: { produce: { extractFromConversation: mockExtractFromConversation } },
}));

vi.mock('../knowledge-outcome-effects', () => ({
  getKnowledgeOutcomeEffects: () => ({ reconcileCompleted: mockReconcileCompleted }),
}));

import { KnowledgeExtractionEffects, knowledgeExtractionIdempotencyKey } from '../knowledge-extraction-effects';

describe('KnowledgeExtractionEffects', () => {
  let testDir: string;
  let fileStore: FileStore;
  let workUnits: WorkUnitService;

  beforeEach(() => {
    vi.clearAllMocks();
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'knowledge-extraction-effects-'));
    fileStore = new FileStore(testDir);
    workUnits = new WorkUnitService(fileStore);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('启动补扫为已完成 WU 的未消费 committed transcript 补建 Effect', async () => {
    const wu = await workUnits.create({ scope: '总结可靠恢复', type: 'task', status: 'done' });
    const at = new Date().toISOString();
    await new WorkUnitMetadataRepository(fileStore).mutateSnapshot(wu.id, current => ({
      ...current,
      assignments: [{
        id: 'assignment-1', workUnitId: wu.id, attempt: 1, previousAssignmentId: null,
        status: 'succeeded', reason: 'claim', createdAt: at, updatedAt: at,
        tokenCount: 0, transcriptCount: 1, progress: [], evidence: [],
      }],
      stepRecords: [{
        id: 'step-1', workUnitId: wu.id, assignmentId: 'assignment-1', step: 1,
        action: 'complete', result: 'done', at, verification: null, nextStep: null,
        acProgress: [], modifiedFiles: [], commands: [], decisions: [], artifacts: [], transcriptRefs: [],
      }],
    }));
    await appendTranscriptStep({
      workUnitId: wu.id, assignmentId: 'assignment-1', step: 1, action: 'complete', rawOutput: '完整执行原文',
    });
    await finalizeTranscriptAssignment({ workUnitId: wu.id, assignmentId: 'assignment-1', status: 'succeeded' });

    const service = new KnowledgeExtractionEffects(fileStore);
    await service.recoverPending();
    await service.waitForSettled();

    expect(mockExtractFromConversation).toHaveBeenCalledWith([
      { role: 'assistant', content: '完整执行原文' },
    ], expect.objectContaining({ workUnitId: wu.id, assignmentId: 'assignment-1' }));
    const snapshot = (await fileStore.getIndex({ id: wu.id }))[0];
    expect(snapshot?.effects?.find(effect => effect.idempotencyKey === knowledgeExtractionIdempotencyKey(wu.id, 'assignment-1'))?.status).toBe('succeeded');
    expect(mockReconcileCompleted).toHaveBeenCalled();
    fs.rmSync(transcriptPath(wu.id), { force: true });
  });

  it('临时模型失败落 retry-after，随后自动重试成功并写 succeeded Receipt', async () => {
    const wu = await workUnits.create({ scope: '重试提取', type: 'task', status: 'done' });
    await appendTranscriptStep({ workUnitId: wu.id, assignmentId: 'assignment-retry', step: 1, rawOutput: '失败恢复原文' });
    await finalizeTranscriptAssignment({ workUnitId: wu.id, assignmentId: 'assignment-retry', status: 'succeeded' });
    mockExtractFromConversation.mockRejectedValueOnce(new Error('temporary model failure'));
    // 30ms 的重试窗口小于 waitFor 轮询间隔（竞态：快机器上直接跳到 succeeded）。
    // 取 500ms 保证 retry-after 中间态可稳定观测，且显式放宽两段 waitFor 超时
    const service = new KnowledgeExtractionEffects(fileStore, { retryDelayMs: 500 });

    await service.trigger(wu.id, 'assignment-retry', { workUnitId: wu.id, assignmentId: 'assignment-retry' });
    await vi.waitFor(async () => {
      const snapshot = (await fileStore.getIndex({ id: wu.id }))[0];
      const effect = snapshot?.effects?.find(item => item.kind === 'knowledge-extraction');
      expect(effect).toMatchObject({ status: 'queued', attempts: 1, nextAttemptAt: expect.any(String) });
    }, { timeout: 5000, interval: 20 });
    await vi.waitFor(async () => {
      const snapshot = (await fileStore.getIndex({ id: wu.id }))[0];
      expect(snapshot?.effects?.find(item => item.kind === 'knowledge-extraction')?.status).toBe('succeeded');
    }, { timeout: 5000, interval: 20 });

    const snapshot = (await fileStore.getIndex({ id: wu.id }))[0];
    const effect = snapshot?.effects?.find(item => item.kind === 'knowledge-extraction');
    expect(effect?.attempts).toBe(2);
    expect(mockExtractFromConversation).toHaveBeenCalledTimes(2);
    expect(snapshot?.effectReceipts?.map(receipt => receipt.outcome)).toEqual(expect.arrayContaining(['retrying', 'succeeded']));
    fs.rmSync(transcriptPath(wu.id), { force: true });
  });
});
