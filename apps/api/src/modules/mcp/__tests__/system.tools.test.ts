/**
 * system.tools 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖 systemHealth / emitEvent。
 * knowledge-bus.service 被 mock；STUDIO_EVENTS_DIR 指向临时目录隔离事件文件。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const mockList = vi.fn();
const mockFreshness = vi.fn();

vi.mock('../../knowledge/knowledge-bus.service.js', () => ({
  sharedStore: { list: mockList },
  checkDocumentFreshness: mockFreshness,
}));

import { systemTools } from '../system.tools.js';

let tmpEvents: string;
let prevEventsDir: string | undefined;

function tool(name: string) {
  const t = systemTools.find(t => t.name === name);
  expect(t).toBeDefined();
  return t!;
}

beforeAll(() => {
  tmpEvents = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-system-tools-'));
  prevEventsDir = process.env.STUDIO_EVENTS_DIR;
  process.env.STUDIO_EVENTS_DIR = tmpEvents;
});

afterAll(() => {
  if (prevEventsDir === undefined) delete process.env.STUDIO_EVENTS_DIR;
  else process.env.STUDIO_EVENTS_DIR = prevEventsDir;
  fs.rmSync(tmpEvents, { recursive: true, force: true });
});

describe('system.tools', () => {
  it('导出 2 个 tool，注册顺序不变', () => {
    expect(systemTools.map(t => t.name)).toEqual(['systemHealth', 'emitEvent']);
  });

  it('systemHealth 汇总知识库统计与 flags（无 jsonl → daemon 不在线）', async () => {
    mockList.mockReturnValue([
      { type: 'design', layer: 'project', maturity: 'candidate' },
      { type: 'design', layer: 'system', maturity: 'canonical' },
      { type: 'spec', layer: 'project', maturity: 'archived' },
    ]);
    mockFreshness.mockReturnValue([{ file: 'a.md' }, { file: 'b.md' }]);

    const result = await tool('systemHealth').handler({});
    expect(mockFreshness).toHaveBeenCalledWith(process.env.REPO_DIR || process.cwd());
    expect(result.system.apiResponding).toBe(true);
    expect(result.system.eventsDaemonAlive).toBe(false);
    expect(result.knowledge).toEqual({
      total: 3,
      byType: { design: 2, spec: 1 },
      byLayer: { project: 2, system: 1 },
      byMaturity: { candidate: 1, canonical: 1, archived: 1 },
      staleDesignDocs: 2,
    });
    expect(result.flags).toEqual({ needsColdStart: false, needsDecay: false, healthy: false });
  });

  it('systemHealth 空库时 needsColdStart/needsDecay 为 true；新鲜 jsonl → daemon 在线', async () => {
    mockList.mockReturnValue([]);
    mockFreshness.mockReturnValue([]);
    fs.writeFileSync(path.join(tmpEvents, 'studio.jsonl'), '{}\n');

    const result = await tool('systemHealth').handler({});
    expect(result.system.eventsDaemonAlive).toBe(true);
    expect(result.flags).toEqual({ needsColdStart: true, needsDecay: true, healthy: true });
  });

  it('emitEvent 写入 studio.jsonl 并返回路由说明', async () => {
    const result = await tool('emitEvent').handler({
      eventType: 'agent:analysis_done', message: 'done', details: { goalId: 'g1' },
    });
    expect(result).toEqual({
      emitted: true,
      eventType: 'agent:analysis_done',
      routedTo: 'events-daemon → Discord (if goal:/monitor:/agent: prefix)',
    });

    const file = path.join(tmpEvents, 'studio.jsonl');
    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    const event = JSON.parse(lines[lines.length - 1]);
    expect(event).toMatchObject({
      type: 'agent:analysis_done', message: 'done', severity: 'info', details: { goalId: 'g1' },
    });
    expect(event.timestamp).toBeTruthy();
  });

  it('emitEvent severity 默认 info，可覆盖', async () => {
    await tool('emitEvent').handler({ eventType: 'agent:x', message: 'm', severity: 'critical' });
    const lines = fs.readFileSync(path.join(tmpEvents, 'studio.jsonl'), 'utf-8').trim().split('\n');
    expect(JSON.parse(lines[lines.length - 1]).severity).toBe('critical');
    expect(tool('emitEvent').inputSchema.required).toEqual(['eventType', 'message']);
  });
});
