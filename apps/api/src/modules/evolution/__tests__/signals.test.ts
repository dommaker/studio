/**
 * signals tests — E1 进化信号窗口
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { FileStore } from '@dommaker/studio-shared';
import { resolveEvolutionPaths, loadWindowSignals } from '../signals.js';

let tmp: string;
let fileStore: FileStore;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evo-signals-'));
  fileStore = new FileStore();
});

afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('resolveEvolutionPaths', () => {
  it('honours explicit overrides', () => {
    const p = resolveEvolutionPaths({ repoRoot: '/x', constraintsFile: '/x/c.yml', eventsDir: '/x/events' });
    expect(p.repoRoot).toBe('/x');
    expect(p.constraintsFile).toBe('/x/c.yml');
    expect(p.eventsDir).toBe('/x/events');
  });

  it('derives harness paths from repoRoot by default', () => {
    const p = resolveEvolutionPaths({ repoRoot: tmp });
    expect(p.constraintsFile).toBe(path.join(tmp, '.harness', 'custom-constraints.yml'));
    expect(p.traceFile).toBe(path.join(tmp, '.harness', 'logs', 'traces.log'));
    expect(p.rolesDir).toBe(path.join(tmp, '.agents', 'roles'));
  });
});

describe('loadWindowSignals', () => {
  it('loads only events inside the window and tolerates missing files', async () => {
    const now = Date.now();
    const paths = resolveEvolutionPaths({ repoRoot: tmp, eventsDir: path.join(tmp, 'events') });
    fs.mkdirSync(paths.eventsDir, { recursive: true });
    fs.mkdirSync(path.dirname(paths.traceFile), { recursive: true });
    fs.mkdirSync(path.dirname(paths.studioEventsFile), { recursive: true });

    fs.writeFileSync(paths.traceFile, [
      JSON.stringify({ timestamp: now - 1000, constraintId: 'c1' }),
      JSON.stringify({ timestamp: now - 48 * 3600_000, constraintId: 'old' }),
    ].join('\n') + '\n');
    // D18: tool:call 与 knowledge:outcome 同一统一事件文件；扁平与 payload 嵌套两种形态都要兼容
    fs.writeFileSync(paths.studioEventsFile, [
      // 历史扁平形态
      JSON.stringify({ type: 'tool:call', timestamp: now - 1000, caller: 'developer', success: false }),
      // StudioEvent 新形态（payload 嵌套）
      JSON.stringify({ type: 'tool:call', source: 'mcp', payload: JSON.stringify({ tool: 'Read', success: true, timestamp: now - 1000 }), createdAt: new Date(now - 1000).toISOString() }),
      JSON.stringify({ type: 'file:change', timestamp: now - 1000 }),
      JSON.stringify({ type: 'knowledge:outcome:success', createdAt: new Date(now - 1000).toISOString(), payload: '{}' }),
      JSON.stringify({ type: 'knowledge:consumption', createdAt: new Date(now - 1000).toISOString(), payload: '{}' }),
    ].join('\n') + '\n');

    const sig = await loadWindowSignals(paths, 24, fileStore);
    expect(sig.constraintTraces).toHaveLength(1);
    expect(sig.constraintTraces[0].constraintId).toBe('c1');
    expect(sig.toolCalls).toHaveLength(2);
    expect(sig.toolCalls[0].success).toBe(false);       // 扁平形态字段保留
    expect(sig.toolCalls[1].tool).toBe('Read');         // payload 嵌套形态字段拉平
    expect(sig.outcomes).toHaveLength(1);
  });

  it('returns empty signals when files are absent', async () => {
    const paths = resolveEvolutionPaths({
      repoRoot: tmp,
      eventsDir: path.join(tmp, 'none'),
      studioEventsFile: path.join(tmp, 'none', 'studio-events.jsonl'),
      traceFile: path.join(tmp, 'none', 'traces.log'),
    });
    const sig = await loadWindowSignals(paths, 24, fileStore);
    expect(sig.constraintTraces).toEqual([]);
    expect(sig.toolCalls).toEqual([]);
    expect(sig.outcomes).toEqual([]);
  });
});
