// #90: Auditor 零执行噪声抑制 —— 过去 24h 零执行时 dailyAudit 早退：
// 不 push #系统、不 recordPattern、不 escalate 到 Triage、不生成 eval case/resolution。
// 空 FileStore（tmpdir）→ getIndex() 返回 [] → total=0 走早退；有执行时的行为不变由既有审计测试覆盖。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileStore } from '@dommaker/studio-shared';

describe('#90 Auditor 零执行噪声抑制', () => {
  let testDir: string;
  let prevStudioEventsFile: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'auditor-zero-exec-'));
    // 隔离 session:summary 事件文件，避免读到真实 home 的事件（早退后不触达，防 RED/回归期污染）
    prevStudioEventsFile = process.env.STUDIO_EVENTS_FILE;
    process.env.STUDIO_EVENTS_FILE = path.join(testDir, 'studio-events.jsonl');
  });

  afterEach(() => {
    if (prevStudioEventsFile === undefined) delete process.env.STUDIO_EVENTS_FILE;
    else process.env.STUDIO_EVENTS_FILE = prevStudioEventsFile;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('过去 24h 零执行 → dailyAudit 早退，不 push / recordPattern / escalate / eval / resolution', async () => {
    const { AuditorService } = await import('../auditor/auditor.service.js');
    const { knowledgeService } = await import('../../knowledge/knowledge-service.js');
    const agent = new AuditorService(new FileStore(testDir));

    const postSpy = vi.spyOn(agent as any, 'postToSystemChannel').mockResolvedValue(undefined);
    const escalateSpy = vi.spyOn(agent as any, 'escalateToTriage').mockResolvedValue(undefined);
    const evalSpy = vi.spyOn(agent as any, 'generateEvalCases').mockResolvedValue(undefined);
    const resSpy = vi.spyOn(agent as any, 'autoCreateResolutions').mockResolvedValue(undefined);
    const patternSpy = vi.spyOn(knowledgeService, 'recordPattern').mockResolvedValue(undefined);

    await (agent as any).dailyAudit();

    expect(postSpy).not.toHaveBeenCalled();
    expect(escalateSpy).not.toHaveBeenCalled();
    expect(evalSpy).not.toHaveBeenCalled();
    expect(resSpy).not.toHaveBeenCalled();
    expect(patternSpy).not.toHaveBeenCalled();

    postSpy.mockRestore();
    escalateSpy.mockRestore();
    evalSpy.mockRestore();
    resSpy.mockRestore();
    patternSpy.mockRestore();
  });
});
