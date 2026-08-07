/**
 * M2 成本红线 — workunit:tokens 事件写入。
 *
 * writeWorkunitTokenEvent 是 agent-loop 任务执行完成时的 token 记录点：
 * 注入估算（chars/4 约定，调用方用 estimateTokens 计算）+ 执行 tokens（CLI usage，
 * 未回报时 null）。用 tmp 文件验证事件形态与诚实语义（null 不编造为 0）。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { estimateTokens } from '@dommaker/studio-shared';

import { writeWorkunitTokenEvent } from '../loop/agent-loop.js';

function withTmpFile(fn: (eventsFile: string) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workunit-tokens-'));
  const eventsFile = path.join(dir, 'studio-events.jsonl');
  return fn(eventsFile).finally(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
}

function readEvents(eventsFile: string): any[] {
  return fs.readFileSync(eventsFile, 'utf-8')
    .split('\n')
    .filter(l => l.trim())
    .map(l => JSON.parse(l));
}

describe('M2: writeWorkunitTokenEvent', () => {
  it('emits workunit:tokens event with injected estimate + execution tokens on completion', async () => {
    await withTmpFile(async (eventsFile) => {
      // 模拟 agentStep 完成路径：注入文本 800 字符 → chars/4 = 200 tokens
      const knowledgeContext = 'x'.repeat(800);
      const injectedTokens = estimateTokens(knowledgeContext.length);
      expect(injectedTokens).toBe(200);

      await writeWorkunitTokenEvent(eventsFile, {
        workUnitId: 'wu-1',
        executionId: 'wu-1-123',
        injectedTokens,
        executionTokens: 12_345,
      });

      const events = readEvents(eventsFile);
      expect(events).toHaveLength(1);
      const ev = events[0];
      expect(ev.type).toBe('workunit:tokens');
      expect(ev.source).toBe('agent-loop');
      expect(typeof ev.createdAt).toBe('string');

      const payload = JSON.parse(ev.payload);
      expect(payload.workUnitId).toBe('wu-1');
      expect(payload.executionId).toBe('wu-1-123');
      expect(payload.injectedTokens).toBe(200);
      expect(payload.injectedSource).toBe('estimate:chars/4');
      expect(payload.executionTokens).toBe(12_345);
      expect(payload.executionSource).toBe('cli-usage');
      expect(payload.totalTokens).toBe(200 + 12_345);
    });
  });

  it('records executionTokens=null (not fabricated 0) when CLI usage is unavailable', async () => {
    await withTmpFile(async (eventsFile) => {
      await writeWorkunitTokenEvent(eventsFile, {
        workUnitId: 'wu-2',
        injectedTokens: 0, // 无注入是合法的显式 0
        executionTokens: null,
      });

      const payload = JSON.parse(readEvents(eventsFile)[0].payload);
      expect(payload.executionTokens).toBeNull();
      expect(payload.executionSource).toBe('unavailable');
      expect(payload.totalTokens).toBe(0);
    });
  });

  it('follows estimateTokens chars/4 convention (codebase-wide estimation convention)', () => {
    expect(estimateTokens(0)).toBe(0);
    expect(estimateTokens(4)).toBe(1);
    expect(estimateTokens(5)).toBe(2); // ceil
    expect(estimateTokens(8_000)).toBe(2_000); // 2K 红线对应的字符量
  });
});
