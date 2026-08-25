/**
 * M2 成本红线 — workunit:tokens 事件写入。
 *
 * writeWorkunitTokenEvent 是 agent-loop 任务执行完成时的 token 记录点：
 * 注入估算（TokenEstimator.estimateText 口径，调用方直接算）+ 执行 tokens（CLI usage，
 * 未回报时 null）。用 tmp 文件验证事件形态与诚实语义（null 不编造为 0）。
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { TokenEstimator } from '@dommaker/harness';

import { writeWorkunitTokenEvent, WORKUNIT_TOKENS_SSE_TYPE } from '../loop/agent-loop.js';
import { eventBus } from '@dommaker/studio-shared';
import { resolveTokenLedgerFile } from '../../../utils/token-ledger.js';

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
      // 模拟 agentStep 完成路径：注入文本 800 字符（纯 ASCII）→ 800/4 = 200 tokens
      const knowledgeContext = 'x'.repeat(800);
      const injectedTokens = TokenEstimator.estimateText(knowledgeContext);
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
      expect(payload.injectedSource).toBe('estimate:token-estimator');
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

  it('落盘后顺带发布 SSE 信封 workunit.tokens（data 含 channelId 与 token 现成字段）', async () => {
    await withTmpFile(async (eventsFile) => {
      const received: Array<{ event_type: string; event_id: string; timestamp: string; data: Record<string, unknown> }> = [];
      eventBus.subscribe('events', (envelope: { event_type: string }) => {
        if (envelope.event_type === WORKUNIT_TOKENS_SSE_TYPE) received.push(envelope as (typeof received)[number]);
      });

      await writeWorkunitTokenEvent(eventsFile, {
        workUnitId: 'wu-3',
        channelId: 'ch-3',
        executionId: 'wu-3-1',
        injectedTokens: 100,
        executionTokens: 500,
        billedTokens: 700,
      });

      expect(received).toHaveLength(1);
      const envelope = received[0];
      expect(typeof envelope.event_id).toBe('string');
      expect(typeof envelope.timestamp).toBe('string');
      expect(envelope.data).toMatchObject({
        workUnitId: 'wu-3',
        channelId: 'ch-3',
        executionId: 'wu-3-1',
        injectedTokens: 100,
        executionTokens: 500,
        billedTokens: 700,
        totalTokens: 800, // injected + billed（账单口径优先）
      });
      // 落盘行为不变（appendJsonl 仍是一条 workunit:tokens）
      expect(readEvents(eventsFile)).toHaveLength(1);
    });
  });

  it('channelId 缺省 → SSE data 无该键（无频道 WU 不编造）', async () => {
    await withTmpFile(async (eventsFile) => {
      const received: Array<{ data: Record<string, unknown> }> = [];
      eventBus.subscribe('events', (envelope: { event_type: string; data: Record<string, unknown> }) => {
        if (envelope.event_type === WORKUNIT_TOKENS_SSE_TYPE) received.push(envelope);
      });

      await writeWorkunitTokenEvent(eventsFile, { workUnitId: 'wu-4', injectedTokens: 0, executionTokens: null });

      expect(received).toHaveLength(1);
      expect(received[0].data).not.toHaveProperty('channelId');
      expect(received[0].data.executionTokens).toBeNull();
    });
  });

  it('#320: 落盘后顺带更新 token 账本（写侧记账接线）', async () => {
    await withTmpFile(async (eventsFile) => {
      await writeWorkunitTokenEvent(eventsFile, {
        workUnitId: 'wu-ledger',
        executionId: 'wu-ledger-1',
        injectedTokens: 100,
        executionTokens: 500,
        billedTokens: 700,
      });

      const ledger = JSON.parse(fs.readFileSync(resolveTokenLedgerFile(eventsFile), 'utf-8'));
      expect(ledger.byWorkUnit['wu-ledger']).toMatchObject({
        events: 1,
        executionCount: 1,
        injectedTokens: 100,
        executionTokens: 500,
        billedTokens: 700,
      });
      expect(ledger.watermark.lines).toBe(1);
    });
  });

  it('follows TokenEstimator.estimateText convention (codebase-wide estimation convention)', () => {
    expect(TokenEstimator.estimateText('')).toBe(0);
    expect(TokenEstimator.estimateText('abcd')).toBe(1);
    expect(TokenEstimator.estimateText('abcde')).toBe(2); // ceil
    expect(TokenEstimator.estimateText('a'.repeat(8_000))).toBe(2_000); // 2K 红线对应的纯 ASCII 字符量
    expect(TokenEstimator.estimateText('你好世界')).toBe(3); // 含中文 ≈1.5 字符/token：4/1.5→3
    expect(TokenEstimator.estimateText('hello 世界')).toBe(6); // 含中文整段按 1.5：8/1.5→6
  });
});
