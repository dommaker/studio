/**
 * #654：事件文件路径「调用时惰性解析」的回归锁定。
 *
 * 历史 bug：十余个模块在 import 期用 `const X = resolveStudioLogFile('studio-events.jsonl')`
 * 把事件文件路径钉成模块级常量 —— import 之后改任何 env 都不生效，测试隔离被静默绕过，
 * 且与正本 resolveStudioEventsFile()（认 STUDIO_EVENTS_FILE）形成双口径。
 *
 * 本文件所有用例都在「模块已静态 import 之后」才设置 STUDIO_EVENTS_FILE，
 * 读/写必须落到 env 指定的文件；凡 import 期钉死路径的实现都会在这里失败。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { studioPath } from '@dommaker/studio-shared/studio-dir';

// 关键：全部在设置 env 之前静态 import —— import 期求值的路径常量会在此处冻结
import { sumTokensForWorkUnits } from '../../modules/agents/token-usage.service.js';
import { aggregateSkillUsage } from '../../modules/skills/skill-demotion.js';
import { generateSessionSummary } from '../../modules/events/session-summary-generator.js';
import { computeOutcomeMetrics } from '../../modules/knowledge/knowledge-metrics.js';
import { appendKnowledgeEvent } from '../../modules/knowledge/knowledge-singletons.js';
import { checkTreeBudget, TREE_TOKEN_BUDGET } from '../../modules/workunit/delegation-gate.js';
import { knowledgeService } from '../../modules/knowledge/knowledge-service.js';
import { resolutionService } from '../../modules/knowledge/resolution.service.js';
import { SystemExecutor } from '../../modules/agents/system-executor.js';

let tmpDir: string;
let eventsFile: string;
const createdResolutionFiles: string[] = [];

function appendEvent(event: Record<string, unknown>): void {
  fs.appendFileSync(eventsFile, JSON.stringify(event) + '\n', 'utf8');
}

/** fire-and-forget 写口的断言辅助：轮询事件文件直到出现匹配行（或超时失败） */
async function waitForEventLine(match: (line: string) => boolean, timeoutMs = 5_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (fs.existsSync(eventsFile)) {
      const hit = fs.readFileSync(eventsFile, 'utf8').split('\n').find(l => l && match(l));
      if (hit) return hit;
    }
    if (Date.now() > deadline) throw new Error('timed out waiting for event line');
    await new Promise(r => setTimeout(r, 20));
  }
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'events-lazy-654-'));
  eventsFile = path.join(tmpDir, 'studio-events.jsonl');
  // import 后才设置 env —— 本文件的全部语义
  process.env.STUDIO_EVENTS_FILE = eventsFile;
});

afterEach(() => {
  delete process.env.STUDIO_EVENTS_FILE;
  fs.rmSync(tmpDir, { recursive: true, force: true });
  for (const f of createdResolutionFiles.splice(0)) {
    try { fs.unlinkSync(f); } catch { /* 已不存在 */ }
  }
});

describe('#654 事件文件路径惰性解析（import 后改 STUDIO_EVENTS_FILE 即生效）', () => {
  it('token-usage.service: sumTokensForWorkUnits 读 env 指定文件', async () => {
    appendEvent({
      type: 'workunit:tokens',
      payload: JSON.stringify({ workUnitId: 'wu-lazy-654', executionTokens: 123 }),
      createdAt: new Date().toISOString(),
    });
    const sum = await sumTokensForWorkUnits(new Set(['wu-lazy-654']));
    expect(sum).toBe(123);
  });

  it('skill-demotion: aggregateSkillUsage 读 env 指定文件', async () => {
    appendEvent({
      type: 'knowledge:skill_used',
      payload: JSON.stringify({ skillName: 'lazy-skill-654', workUnitId: 'wu-lazy-654' }),
      createdAt: new Date().toISOString(),
    });
    const stats = await aggregateSkillUsage();
    expect(stats.get('lazy-skill-654')?.uses).toBe(1);
  });

  it('session-summary-generator: generateSessionSummary 读 env 指定文件', async () => {
    appendEvent({
      type: 'session:start', source: 'agent-lazy-654',
      payload: JSON.stringify({ sessionId: 'lazy-sess-654' }),
      createdAt: new Date().toISOString(),
    });
    appendEvent({
      type: 'file:change', source: 'agent-lazy-654',
      payload: JSON.stringify({ sessionId: 'lazy-sess-654', path: '/tmp/lazy-654.ts' }),
      createdAt: new Date().toISOString(),
    });
    const summary = await generateSessionSummary('lazy-sess-654');
    expect(summary).not.toBeNull();
    expect(summary?.eventCount).toBe(2);
    expect(summary?.filesChanged).toEqual(['/tmp/lazy-654.ts']);
  });

  it('knowledge-metrics: computeOutcomeMetrics 读 env 指定文件', async () => {
    appendEvent({
      type: 'knowledge:outcome:success',
      payload: JSON.stringify({ consumedKnowledge: ['k-lazy-654'] }),
      createdAt: new Date().toISOString(),
    });
    const metrics = await computeOutcomeMetrics();
    expect(metrics.source).toBe('events');
    expect(metrics.hitRate).toBe(100);
  });

  it('delegation-gate: checkTreeBudget 的账本源读 env 指定文件', async () => {
    appendEvent({
      type: 'workunit:tokens',
      payload: JSON.stringify({ workUnitId: 'wu-root-lazy-654', executionTokens: TREE_TOKEN_BUDGET + 1 }),
      createdAt: new Date().toISOString(),
    });
    const fakeFileStore = { getIndex: async () => [] } as any;
    const result = await checkTreeBudget('wu-root-lazy-654', fakeFileStore);
    expect(result.treeTotal).toBe(TREE_TOKEN_BUDGET + 1);
    expect(result.pass).toBe(false);
  });

  it('system-executor: 构造缺省 eventsFile 认 STUDIO_EVENTS_FILE（import 后设置）', () => {
    const executor = new SystemExecutor({} as any);
    expect((executor as any).eventsFile).toBe(eventsFile);
  });

  it('knowledge-singletons: appendKnowledgeEvent 写 env 指定文件', async () => {
    appendKnowledgeEvent('knowledge:lazy_probe_654', { ok: true });
    const line = await waitForEventLine(l => l.includes('"knowledge:lazy_probe_654"'));
    expect(JSON.parse(line).type).toBe('knowledge:lazy_probe_654');
  }, 10_000);

  it('knowledge-service: recordConsumption 写 env 指定文件', async () => {
    knowledgeService.recordConsumption(['k-lazy-entry-654'], 'lazy-context-654');
    const line = await waitForEventLine(l => l.includes('"knowledge:consumption"') && l.includes('lazy-context-654'));
    expect(JSON.parse(line).type).toBe('knowledge:consumption');
  }, 10_000);

  it('resolution.service: matchResolutions 命中后消费事件写 env 指定文件', async () => {
    const knowledgeDir = studioPath('knowledge');
    fs.mkdirSync(knowledgeDir, { recursive: true });
    const resolutionFile = path.join(knowledgeDir, 'resolution-lazy-654.md');
    createdResolutionFiles.push(resolutionFile);
    fs.writeFileSync(resolutionFile, [
      '---',
      'type: resolution',
      'pattern: "lazy-reso-654"',
      'errorClass: "lazy_error"',
      'layer: "project"',
      'title: "Lazy Resolution 654"',
      'maturity: "verified"',
      'verifyCount: 1',
      'tags: ["test"]',
      '---',
      '',
      '# Lazy Resolution 654',
      '',
      '## Solution',
      '',
      'Do the lazy fix',
    ].join('\n'), 'utf8');

    const result = await resolutionService.matchResolutions({ errorMessage: 'boom lazy-reso-654 happened' });
    expect(result.matched).toBe(true);
    expect(result.resolutions.length).toBeGreaterThan(0);
    const line = await waitForEventLine(l => l.includes('"knowledge:consumption"') && l.includes('resolution-match'));
    expect(JSON.parse(line).type).toBe('knowledge:consumption');
  }, 10_000);
});
