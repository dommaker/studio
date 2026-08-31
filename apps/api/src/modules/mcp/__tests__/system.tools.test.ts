/**
 * system.tools 单元测试（T3 拆分新增，pre-commit TDD 门禁）。
 *
 * 覆盖 systemHealth / emitEvent。
 * knowledge-singletons / knowledge-design-doc 被 mock；D18 后 STUDIO_EVENTS_FILE
 * 指向临时文件隔离事件写入。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const mockList = vi.fn();
const mockFreshness = vi.fn();

vi.mock('../../knowledge/knowledge-singletons.js', () => ({
  sharedStore: { list: mockList },
}));
vi.mock('../../knowledge/knowledge-design-doc.js', () => ({
  checkDocumentFreshness: mockFreshness,
}));

import { systemTools } from '../system.tools.js';

let tmpEvents: string;
let eventsFile: string;
let prevEventsFile: string | undefined;

function tool(name: string) {
  const t = systemTools.find(t => t.name === name);
  expect(t).toBeDefined();
  return t!;
}

beforeAll(() => {
  tmpEvents = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-system-tools-'));
  eventsFile = path.join(tmpEvents, 'studio-events.jsonl');
  prevEventsFile = process.env.STUDIO_EVENTS_FILE;
  process.env.STUDIO_EVENTS_FILE = eventsFile;
});

afterAll(() => {
  if (prevEventsFile === undefined) delete process.env.STUDIO_EVENTS_FILE;
  else process.env.STUDIO_EVENTS_FILE = prevEventsFile;
  fs.rmSync(tmpEvents, { recursive: true, force: true });
});

describe('system.tools', () => {
  it('导出 2 个 tool，注册顺序不变', () => {
    expect(systemTools.map(t => t.name)).toEqual(['systemHealth', 'emitEvent']);
  });

  it('systemHealth 汇总知识库统计与 flags（无事件文件 → 事件流不活跃）', async () => {
    mockList.mockReturnValue([
      { type: 'design', layer: 'project', maturity: 'candidate' },
      { type: 'design', layer: 'system', maturity: 'canonical' },
      { type: 'spec', layer: 'project', maturity: 'archived' },
    ]);
    mockFreshness.mockReturnValue([{ file: 'a.md' }, { file: 'b.md' }]);
    if (fs.existsSync(eventsFile)) fs.unlinkSync(eventsFile);

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

  it('systemHealth 空库时 needsColdStart/needsDecay 为 true；事件文件新鲜 → 事件流活跃', async () => {
    mockList.mockReturnValue([]);
    mockFreshness.mockReturnValue([]);
    fs.writeFileSync(eventsFile, '{"type":"x","payload":"{}","createdAt":"2026-01-01T00:00:00.000Z"}\n');

    const result = await tool('systemHealth').handler({});
    expect(result.system.eventsDaemonAlive).toBe(true);
    expect(result.flags).toEqual({ needsColdStart: true, needsDecay: true, healthy: true });
  });

  it('emitEvent 写入统一事件文件（StudioEvent 形态）并返回路由说明', async () => {
    const result = await tool('emitEvent').handler({
      eventType: 'agent:analysis_done', message: 'done', details: { goalId: 'g1' },
    });
    expect(result).toEqual({
      emitted: true,
      eventType: 'agent:analysis_done',
      routedTo: 'unified studio-events.jsonl (D18)',
    });

    const lines = fs.readFileSync(eventsFile, 'utf-8').trim().split('\n');
    const event = JSON.parse(lines[lines.length - 1]);
    expect(event.type).toBe('agent:analysis_done');
    expect(event.source).toBe('mcp');
    expect(JSON.parse(event.payload)).toEqual({ message: 'done', severity: 'info', details: { goalId: 'g1' } });
    expect(event.createdAt).toBeTruthy();
  });

  it('emitEvent severity 默认 info，可覆盖', async () => {
    await tool('emitEvent').handler({ eventType: 'agent:x', message: 'm', severity: 'critical' });
    const lines = fs.readFileSync(eventsFile, 'utf-8').trim().split('\n');
    expect(JSON.parse(JSON.parse(lines[lines.length - 1]).payload).severity).toBe('critical');
    expect(tool('emitEvent').inputSchema.required).toEqual(['eventType', 'message']);
  });
});
